"""Gemini conversation adapter with a small, spoken-answer-oriented prompt."""

from __future__ import annotations

import os
from collections.abc import Sequence
from functools import lru_cache
from collections.abc import Iterator
from typing import TypedDict

from google import genai
from google.genai import types

SYSTEM_PROMPT = (
    "You are a helpful conversational avatar assistant. Answer clearly, warmly, "
    "and concisely. Your answers will be spoken aloud, so avoid long paragraphs, "
    "dense lists, markdown, and unnecessary preambles."
)
MAX_HISTORY_MESSAGES = 12
DEFAULT_MODEL = "gemini-3.1-flash-lite"


class ChatMessage(TypedDict):
    role: str
    content: str


class LlmError(RuntimeError):
    """Raised after Gemini's retry has failed."""


def _as_gemini_contents(history: Sequence[ChatMessage]) -> list[types.Content]:
    """Convert session history into the role names expected by Gemini."""

    return [
        types.Content(
            role="model" if message["role"] == "assistant" else "user",
            parts=[types.Part.from_text(text=message["content"])],
        )
        for message in history[-MAX_HISTORY_MESSAGES:]
    ]


@lru_cache(maxsize=2)
def _client(api_key: str) -> genai.Client:
    """Reuse HTTP connections instead of rebuilding the Gemini client per turn."""

    return genai.Client(api_key=api_key)


def generate_reply_stream(history: Sequence[ChatMessage]) -> Iterator[str]:
    """Yield Gemini text as it arrives, retrying only before the first chunk."""

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise LlmError("The language model is not configured on the server.")

    contents = _as_gemini_contents(history)
    configuration = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        temperature=0.5,
        max_output_tokens=180,
        thinking_config=types.ThinkingConfig(thinking_level="MINIMAL"),
    )

    last_error: Exception | None = None
    for _attempt in range(2):
        yielded = False
        try:
            response = _client(api_key).models.generate_content_stream(
                model=os.getenv("GEMINI_MODEL", DEFAULT_MODEL),
                contents=contents,
                config=configuration,
            )
            for chunk in response:
                text = chunk.text or ""
                if text:
                    yielded = True
                    yield text
            if yielded:
                return
            raise ValueError("Gemini returned an empty response")
        except Exception as error:  # Retry once: provider errors are heterogeneous.
            last_error = error
            if yielded:
                break

    raise LlmError("I couldn't generate a response right now. Please try again.") from last_error


def generate_reply(history: Sequence[ChatMessage]) -> str:
    """Compatibility helper for non-streaming callers and focused tests."""

    return "".join(generate_reply_stream(history)).strip()
