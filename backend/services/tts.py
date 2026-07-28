"""Azure Speech synthesis adapter that returns WAV audio and timed visemes."""

from __future__ import annotations

import os
import threading
import time
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass

import azure.cognitiveservices.speech as speechsdk

from viseme_map import to_oculus_viseme

logger = logging.getLogger("avatar-chatbot.tts")

VOICE_NAMES = {
    "nova": "en-US-JennyNeural",
    "aria": "en-US-AriaNeural",
    "atlas": "en-US-GuyNeural",
}
DEFAULT_VOICE_ID = "nova"


@dataclass(frozen=True)
class TimedViseme:
    """One Azure viseme, already translated for the TalkingHead renderer."""

    offset_ms: float
    viseme_id: int
    viseme: str


@dataclass(frozen=True)
class SynthesisResult:
    """Audio and visual timing generated for one reply."""

    audio: bytes
    visemes: list[TimedViseme]


@dataclass(frozen=True)
class StreamingSynthesisResult:
    """Summary of one streamed response after every audio chunk has arrived."""

    text: str
    has_audio: bool
    viseme_count: int
    last_viseme_offset_ms: float
    tts_error: str | None = None


class TextToSpeechError(RuntimeError):
    """Raised when Azure cannot synthesize a reply."""


_stream_lock = threading.Lock()
_stream_synthesizer: speechsdk.SpeechSynthesizer | None = None
_stream_connection: speechsdk.Connection | None = None
_stream_voice_id: str | None = None


def is_voice_id(value: object) -> bool:
    """Return whether a client-provided voice ID is supported."""

    return isinstance(value, str) and value in VOICE_NAMES


def _voice_name(voice_id: str) -> str:
    return VOICE_NAMES.get(voice_id, VOICE_NAMES[DEFAULT_VOICE_ID])


def _speech_credentials() -> tuple[str, str]:
    speech_key = os.getenv("AZURE_SPEECH_KEY")
    region = os.getenv("AZURE_SPEECH_REGION")
    if not speech_key or not region:
        raise TextToSpeechError("Speech synthesis is not configured on the server.")
    return speech_key, region


def _get_stream_synthesizer(
    voice_id: str = DEFAULT_VOICE_ID,
) -> speechsdk.SpeechSynthesizer:
    """Create one WebSocket-v2 synthesizer and retain its warm connection."""

    global _stream_connection, _stream_synthesizer, _stream_voice_id
    if _stream_synthesizer is not None and _stream_voice_id == voice_id:
        return _stream_synthesizer
    if _stream_connection is not None:
        _stream_connection.close()
    if _stream_synthesizer is not None:
        _stream_synthesizer.synthesizing.disconnect_all()
        _stream_synthesizer.viseme_received.disconnect_all()
    _stream_connection = None
    _stream_synthesizer = None
    _stream_voice_id = None

    speech_key, region = _speech_credentials()
    config = speechsdk.SpeechConfig(
        endpoint=f"wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v2",
        subscription=speech_key,
    )
    config.speech_synthesis_voice_name = _voice_name(voice_id)
    config.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm
    )
    config.set_property(speechsdk.PropertyId.SpeechSynthesis_FrameTimeoutInterval, "100000000")
    config.set_property(speechsdk.PropertyId.SpeechSynthesis_RtfTimeoutThreshold, "10")
    _stream_synthesizer = speechsdk.SpeechSynthesizer(
        speech_config=config,
        audio_config=None,
    )
    _stream_connection = speechsdk.Connection.from_speech_synthesizer(_stream_synthesizer)
    _stream_connection.open(True)
    _stream_voice_id = voice_id
    return _stream_synthesizer


def preconnect_speech() -> None:
    """Warm Azure's WebSocket connection during backend startup."""

    with _stream_lock:
        _get_stream_synthesizer(DEFAULT_VOICE_ID)


def synthesize_speech_stream(
    text_chunks: Iterable[str],
    on_text: Callable[[str], None],
    on_audio: Callable[[bytes], None],
    on_viseme: Callable[[TimedViseme], None],
    voice_id: str = DEFAULT_VOICE_ID,
) -> StreamingSynthesisResult:
    """Feed LLM deltas directly into Azure and emit raw PCM plus visemes."""

    with _stream_lock:
        full_text: list[str] = []
        has_audio = False
        viseme_count = 0
        last_viseme_offset_ms = 0.0
        tts_error: str | None = None

        try:
            synthesizer = _get_stream_synthesizer(voice_id)
        except Exception as error:
            synthesizer = None
            tts_error = str(error)

        request: speechsdk.SpeechSynthesisRequest | None = None
        synthesis_task = None

        if synthesizer is not None:
            synthesizer.synthesizing.disconnect_all()
            synthesizer.viseme_received.disconnect_all()

            def capture_audio(event: speechsdk.SpeechSynthesisEventArgs) -> None:
                nonlocal has_audio
                audio = bytes(event.result.audio_data)
                if audio:
                    has_audio = True
                    on_audio(audio)

            def capture_viseme(event: speechsdk.SpeechSynthesisVisemeEventArgs) -> None:
                nonlocal last_viseme_offset_ms, viseme_count
                viseme_id = int(event.viseme_id)
                timed_viseme = TimedViseme(
                    offset_ms=event.audio_offset / 10_000,
                    viseme_id=viseme_id,
                    viseme=to_oculus_viseme(viseme_id),
                )
                viseme_count += 1
                last_viseme_offset_ms = timed_viseme.offset_ms
                on_viseme(timed_viseme)

            synthesizer.synthesizing.connect(capture_audio)
            synthesizer.viseme_received.connect(capture_viseme)
            try:
                request = speechsdk.SpeechSynthesisRequest(
                    input_type=speechsdk.SpeechSynthesisRequestInputType.TextStream
                )
                synthesis_task = synthesizer.speak_async(request)
            except Exception as error:
                tts_error = str(error)
                request = None

        try:
            for chunk in text_chunks:
                if not chunk:
                    continue
                full_text.append(chunk)
                on_text(chunk)
                if request is not None:
                    try:
                        request.input_stream.write(chunk)
                    except Exception as error:
                        tts_error = str(error)
                        request.input_stream.close()
                        request = None
        finally:
            if request is not None:
                request.input_stream.close()

        if synthesis_task is not None:
            try:
                result = synthesis_task.get()
                if result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted:
                    tts_error = "Voice synthesis did not complete."
            except Exception as error:
                tts_error = str(error)
            finally:
                if synthesizer is not None:
                    synthesizer.synthesizing.disconnect_all()
                    synthesizer.viseme_received.disconnect_all()

        return StreamingSynthesisResult(
            text="".join(full_text).strip(),
            has_audio=has_audio,
            viseme_count=viseme_count,
            last_viseme_offset_ms=last_viseme_offset_ms,
            tts_error=tts_error,
        )


def synthesize_speech(
    text: str,
    voice_id: str = DEFAULT_VOICE_ID,
) -> SynthesisResult:
    """Synthesize a browser-playable WAV payload and collect Azure callbacks."""

    speech_key, region = _speech_credentials()

    def synthesize_once() -> SynthesisResult:
        visemes: list[TimedViseme] = []
        synthesizer: speechsdk.SpeechSynthesizer | None = None
        connection: speechsdk.Connection | None = None
        try:
            config = speechsdk.SpeechConfig(subscription=speech_key, region=region)
            config.speech_synthesis_voice_name = _voice_name(voice_id)
            config.set_speech_synthesis_output_format(
                speechsdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm
            )
            synthesizer = speechsdk.SpeechSynthesizer(
                speech_config=config,
                audio_config=None,
            )
            connection = speechsdk.Connection.from_speech_synthesizer(synthesizer)

            def capture_viseme(event: speechsdk.SpeechSynthesisVisemeEventArgs) -> None:
                # Azure reports ticks in 100-nanosecond units; TalkingHead uses ms.
                viseme_id = int(event.viseme_id)
                visemes.append(
                    TimedViseme(
                        offset_ms=event.audio_offset / 10_000,
                        viseme_id=viseme_id,
                        viseme=to_oculus_viseme(viseme_id),
                    )
                )

            synthesizer.viseme_received.connect(capture_viseme)
            result = synthesizer.speak_text_async(text).get()
            if (
                result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted
                or not result.audio_data
            ):
                if result.reason == speechsdk.ResultReason.Canceled:
                    details = speechsdk.SpeechSynthesisCancellationDetails(result)
                    raise TextToSpeechError(
                        f"Azure canceled synthesis: {details.error_code}; "
                        f"{details.error_details or details.reason}"
                    )
                raise TextToSpeechError("Voice synthesis returned no audio.")
            if not visemes:
                raise TextToSpeechError("Voice synthesis returned no lip-sync timing.")

            # Azure callbacks are normally ordered, but sorting here makes the
            # renderer's animation timeline deterministic.
            visemes.sort(key=lambda viseme: viseme.offset_ms)
            return SynthesisResult(audio=bytes(result.audio_data), visemes=visemes)
        finally:
            if synthesizer is not None:
                synthesizer.viseme_received.disconnect_all()
            if connection is not None:
                connection.close()

    last_error: Exception | None = None
    for attempt in range(2):
        try:
            return synthesize_once()
        except Exception as error:
            last_error = error
            logger.warning(
                "Voice preview synthesis attempt %d failed: %s",
                attempt + 1,
                error,
            )
            if attempt == 0:
                time.sleep(0.25)

    raise TextToSpeechError("Voice synthesis is temporarily unavailable.") from last_error
