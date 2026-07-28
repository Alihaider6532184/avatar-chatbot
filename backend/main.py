"""FastAPI WebSocket server for the backend-driven talking-avatar pipeline."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

load_dotenv()

from services.llm import ChatMessage, LlmError, generate_reply_stream
from services.stt import SpeechToTextError, transcribe_audio
from services.tts import (
    DEFAULT_VOICE_ID,
    StreamingSynthesisResult,
    TextToSpeechError,
    is_voice_id,
    preconnect_speech,
    synthesize_speech,
    synthesize_speech_stream,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger("avatar-chatbot")

app = FastAPI(title="Avatar Chatbot API", version="1.0.0")
MAX_TEXT_CHARACTERS = 4_000
MAX_AUDIO_BYTES = 25 * 1024 * 1024
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class VoicePreviewRequest(BaseModel):
    """Validated voice sample request from the Next.js UI."""

    voice_id: str


_voice_preview_cache: dict[str, dict[str, object]] = {}
_voice_preview_lock = asyncio.Lock()


async def _timed_stage(name: str, operation: Callable[..., Any], *args: Any) -> Any:
    """Run a blocking provider SDK off the event loop and log its latency."""

    started = time.perf_counter()
    try:
        return await run_in_threadpool(operation, *args)
    finally:
        logger.info("%s latency: %.0f ms", name, (time.perf_counter() - started) * 1_000)


async def _send_error(websocket: WebSocket, message: str) -> None:
    await websocket.send_json({"type": "error", "message": message})


def _parse_text_message(raw_message: str) -> str:
    """Validate the JSON envelope used for typed chat messages."""

    try:
        payload = json.loads(raw_message)
    except json.JSONDecodeError as error:
        raise ValueError("Please send a valid chat message.") from error

    if payload.get("type") != "text" or not isinstance(payload.get("text"), str):
        raise ValueError("Unsupported message format.")
    text = payload["text"].strip()
    if not text:
        raise ValueError("Please type a message before sending.")
    if len(text) > MAX_TEXT_CHARACTERS:
        raise ValueError("Please keep messages under 4,000 characters.")
    return text


async def _process_turn(
    websocket: WebSocket,
    history: list[ChatMessage],
    user_text: str,
    voice_id: str = DEFAULT_VOICE_ID,
) -> None:
    """Stream Gemini text into Azure so audio starts before the reply is complete."""

    response_id = uuid.uuid4().hex
    events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    started = time.perf_counter()
    first_text_at: float | None = None
    first_audio_at: float | None = None
    turn_history: list[ChatMessage] = [*history, {"role": "user", "content": user_text}]

    await websocket.send_json(
        {"type": "response_start", "response_id": response_id, "sample_rate": 24_000}
    )

    def emit(payload: dict[str, Any]) -> None:
        nonlocal first_audio_at, first_text_at
        now = time.perf_counter()
        if payload["type"] == "response_delta" and first_text_at is None:
            first_text_at = now
        elif payload["type"] == "response_audio" and first_audio_at is None:
            first_audio_at = now
        loop.call_soon_threadsafe(
            events.put_nowait,
            {**payload, "response_id": response_id},
        )

    def run_turn() -> StreamingSynthesisResult:
        return synthesize_speech_stream(
            generate_reply_stream(turn_history),
            on_text=lambda text: emit({"type": "response_delta", "text": text}),
            on_audio=lambda audio: emit(
                {
                    "type": "response_audio",
                    "audio": base64.b64encode(audio).decode("ascii"),
                }
            ),
            on_viseme=lambda viseme: emit(
                {"type": "response_viseme", "viseme": viseme.__dict__}
            ),
            voice_id=voice_id,
        )

    worker = asyncio.create_task(asyncio.to_thread(run_turn))
    try:
        while not worker.done() or not events.empty():
            try:
                event = await asyncio.wait_for(events.get(), timeout=0.05)
            except TimeoutError:
                continue
            await websocket.send_json(event)
        synthesis = await worker
    except LlmError as error:
        await _send_error(websocket, str(error))
        return
    if not synthesis.text:
        await _send_error(websocket, "I couldn't generate a response right now. Please try again.")
        return

    history.extend(
        [
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": synthesis.text},
        ]
    )
    del history[:-12]

    if synthesis.tts_error:
        logger.warning("Streaming TTS issue; text reply was preserved: %s", synthesis.tts_error)
    logger.info(
        "Streaming turn: first text %.0f ms, first audio %s, total %.0f ms; "
        "%d visemes spanning %.0f ms",
        ((first_text_at or time.perf_counter()) - started) * 1_000,
        f"{(first_audio_at - started) * 1_000:.0f} ms" if first_audio_at else "unavailable",
        (time.perf_counter() - started) * 1_000,
        synthesis.viseme_count,
        synthesis.last_viseme_offset_ms,
    )
    await websocket.send_json(
        {
            "type": "response_end",
            "response_id": response_id,
            "text": synthesis.text,
            "has_audio": synthesis.has_audio,
        }
    )


@app.on_event("startup")
async def warm_provider_connections() -> None:
    """Pay Azure's connection setup cost before the user's first question."""

    try:
        await run_in_threadpool(preconnect_speech)
        logger.info("Azure speech connection is warm")
    except Exception as error:
        logger.warning("Azure speech preconnection failed: %s", error)


@app.get("/health")
async def health_check() -> dict[str, str]:
    """A key-free health check for local development and deployment probes."""

    return {"status": "ok"}


@app.post("/voice-preview")
async def voice_preview(payload: VoicePreviewRequest) -> dict[str, object]:
    """Return a short WAV sample and matching lip-sync cues for one voice."""

    if not is_voice_id(payload.voice_id):
        raise HTTPException(status_code=400, detail="Unsupported avatar voice.")
    async with _voice_preview_lock:
        cached = _voice_preview_cache.get(payload.voice_id)
        if cached is not None:
            return cached

        text = "Hello! I'm ready to bring your ideas to life. How can I help today?"
        try:
            result = await _timed_stage(
                "TTS preview",
                synthesize_speech,
                text,
                payload.voice_id,
            )
        except TextToSpeechError as error:
            logger.warning("Voice preview unavailable: %s", error)
            raise HTTPException(
                status_code=503,
                detail="The voice preview is temporarily unavailable.",
            ) from error

        response: dict[str, object] = {
            "audio": base64.b64encode(result.audio).decode("ascii"),
            "text": text,
            "visemes": [viseme.__dict__ for viseme in result.visemes],
        }
        _voice_preview_cache[payload.voice_id] = response
        return response


@app.websocket("/ws/chat")
async def chat_websocket(websocket: WebSocket) -> None:
    """Accept typed JSON or binary MediaRecorder audio for one chat session."""

    await websocket.accept()
    history: list[ChatMessage] = []
    audio_mime_type = "audio/webm"
    voice_id = DEFAULT_VOICE_ID
    logger.info("WebSocket client connected")

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            raw_text = message.get("text")
            raw_audio = message.get("bytes")
            if raw_text is not None:
                # The client sends this immediately before a binary blob so Groq
                # receives the correct container type on browsers that do not use WebM.
                try:
                    envelope = json.loads(raw_text)
                except json.JSONDecodeError:
                    envelope = None
                if envelope and envelope.get("type") == "audio_metadata":
                    mime_type = envelope.get("mime_type")
                    if isinstance(mime_type, str) and mime_type.startswith("audio/"):
                        audio_mime_type = mime_type
                    else:
                        await _send_error(websocket, "Unsupported audio recording format.")
                    continue
                if envelope and envelope.get("type") == "session_config":
                    requested_voice = envelope.get("voice_id")
                    if is_voice_id(requested_voice):
                        voice_id = requested_voice
                    else:
                        await _send_error(websocket, "Unsupported avatar voice.")
                    continue
                try:
                    user_text = _parse_text_message(raw_text)
                except ValueError as error:
                    await _send_error(websocket, str(error))
                    continue
            elif raw_audio is not None:
                if not raw_audio:
                    await _send_error(websocket, "The recording was empty. Please try again.")
                    continue
                if len(raw_audio) > MAX_AUDIO_BYTES:
                    await _send_error(websocket, "That recording is too large. Please keep it under 25 MB.")
                    continue
                try:
                    user_text = await _timed_stage("STT", transcribe_audio, raw_audio, audio_mime_type)
                except SpeechToTextError as error:
                    await _send_error(websocket, str(error))
                    continue
                await websocket.send_json({"type": "transcription", "text": user_text})
            else:
                await _send_error(websocket, "Unsupported WebSocket message.")
                continue

            await _process_turn(websocket, history, user_text, voice_id)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected WebSocket pipeline error")
        try:
            await _send_error(websocket, "Something went wrong. Please reconnect and try again.")
        except (RuntimeError, WebSocketDisconnect):
            pass
    finally:
        logger.info("WebSocket client disconnected")
