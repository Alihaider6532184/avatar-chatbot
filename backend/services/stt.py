"""Groq Whisper speech-to-text adapter."""

from __future__ import annotations

import os

from groq import Groq


class SpeechToTextError(RuntimeError):
    """Raised when a recording cannot be transcribed."""


def transcribe_audio(audio_bytes: bytes, mime_type: str = "audio/webm") -> str:
    """Transcribe a browser MediaRecorder payload with Groq Whisper."""

    if not audio_bytes:
        raise SpeechToTextError("The recording was empty.")

    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise SpeechToTextError("Speech recognition is not configured on the server.")

    extension = next(
        (candidate for candidate in ("webm", "ogg", "mp4", "wav") if candidate in mime_type),
        "webm",
    )
    try:
        client = Groq(api_key=api_key)
        result = client.audio.transcriptions.create(
            model="whisper-large-v3-turbo",
            file=(f"recording.{extension}", audio_bytes, mime_type),
            response_format="json",
        )
    except Exception as error:  # Provider exceptions vary by SDK version.
        raise SpeechToTextError("I couldn't understand that recording. Please try again.") from error

    text = (result.text or "").strip()
    if not text:
        raise SpeechToTextError("I couldn't hear any speech in that recording.")
    return text
