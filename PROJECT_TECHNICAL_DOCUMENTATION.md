# Avatar Chatbot — Technical Architecture Documentation

## Table of contents

1. [Project overview](#1-project-overview)
2. [Architecture and data flow](#2-architecture-and-data-flow)
3. [Backend implementation details](#3-backend-implementation-details)
4. [Frontend implementation details](#4-frontend-implementation-details)
5. [Timing and sequencing behavior](#5-timing-and-sequencing-behavior)
6. [Known limitations and TODOs](#6-known-limitations-and-todos)
7. [File structure](#7-file-structure)
8. [Configuration and operational notes](#8-configuration-and-operational-notes)

## 1. Project overview

This is a browser-based 3D conversational avatar. A user either types a question or records microphone audio; the browser sends the typed JSON or completed `MediaRecorder` blob over a WebSocket. The active Node/Next server transcribes audio with Groq Whisper, optionally retrieves document context from Supabase/pgvector, streams a Gemini response, feeds the arriving text into Azure Speech's text-stream synthesis, and sends text deltas, raw 24 kHz mono PCM chunks, and Azure timed visemes back over the same WebSocket. React renders the conversation, while `@met4citizen/talkinghead` (inside a React Three Fiber scene) schedules PCM playback and maps Oculus mouth shapes to the loaded GLB avatar. The repository also contains a separate FastAPI implementation under `backend/`; it implements the same core audio → Gemini → Azure pipeline but has no RAG route and is not the server imported by the current `frontend/server.mjs` or `frontend/app/api/ws/route.ts`.

### Technology stack

| Area | Technology in the repository |
|---|---|
| Languages | TypeScript/TSX, JavaScript ESM (`.mjs`), Python 3 |
| Frontend framework | Next.js `^16.0.0`, React `^19.0.0`, React DOM `^19.0.0` |
| UI/rendering | React Three Fiber `^9.1.2`, Three.js `^0.180.0`, Tailwind CSS `^3.4.10`, PostCSS/autoprefixer |
| Avatar/lip-sync | `@met4citizen/talkinghead ^1.7.0`, TalkingHead English lipsync module, Oculus viseme names |
| WebSocket client/server | Browser `WebSocket`, `ws ^8.21.0`, `@vercel/functions ^3.7.5` WebSocket upgrade, custom `frontend/server.mjs` upgrade server |
| AI SDK | Vercel AI SDK `ai ^7.0.22`, `@ai-sdk/google ^4.0.12` |
| LLM | Google Gemini through `streamText` in Node; the standalone Python adapter uses `google-genai >=1.0.0,<2.0.0` |
| Speech-to-text | Groq OpenAI-compatible Whisper endpoint/model `whisper-large-v3-turbo`; Python adapter uses `groq >=0.11.0,<1.0.0` |
| Text-to-speech | Microsoft Cognitive Services Speech SDK `microsoft-cognitiveservices-speech-sdk ^1.50.0`; Python adapter uses `azure-cognitiveservices-speech >=1.40.0,<2.0.0` |
| RAG | Gemini Embeddings REST model `gemini-embedding-2`, 768 dimensions; Supabase JS `^2.110.5`, Postgres `^3.4.9`, PostgreSQL `pgvector` HNSW index and SQL RPC |
| Document extraction | `unpdf ^1.6.2` for PDF; browser/server `File.text()` for text-like formats |
| Backend alternative | FastAPI `>=0.115.0,<1.0.0`, Uvicorn `>=0.30.0,<1.0.0`, `python-dotenv` |
| Build/runtime | Node `tsx ^4.20.3`; Next webpack mode; Node runtime routes; Python Uvicorn |

The Python dependency declarations are in `backend/requirements.txt`; the Node dependency declarations are in `frontend/package.json` and the lockfile is `frontend/package-lock.json`.

## 2. Architecture and data flow

### 2.1 Primary/current Node pipeline

The current browser defaults to a same-origin WebSocket endpoint: `ws(s)://<host>/api/ws` from `frontend/app/page.tsx:websocketUrl()`. If `NEXT_PUBLIC_WS_URL` is set, that URL is used instead. There are two possible Node WebSocket hosts:

1. The Next route `frontend/app/api/ws/route.ts` uses `experimental_upgradeWebSocket` and imports `frontend/lib/server/avatarPipeline.ts`.
2. The production-style custom server `frontend/server.mjs` creates an HTTP Next server plus a `ws.WebSocketServer`, upgrades `/api/ws`, and calls the same `avatarPipeline` functions directly.

The data flow for microphone input is:

```text
User click
  → MicButton.startRecording()
  → getUserMedia(audio constraints)
  → MediaRecorder records WebM/OGG/MP4/WAV blob
  → end-of-speech detector stops recorder
  → ChatWebSocketClient.sendAudio()
       JSON {type:"audio_metadata", mime_type}
       binary audio Blob
  → Node WebSocket route/server queue
  → transcribeAudio() → Groq POST /openai/v1/audio/transcriptions
  → {type:"transcription", text}
  → processTextTurn()
       optional retrieveContext() → Gemini Embedding REST → Supabase RPC
       streamText() → Gemini text chunks
       each text chunk → Azure Speech TextStream input
       Azure synthesizing callbacks → PCM chunks + viseme events
  → WebSocket response_start / response_delta / response_audio /
    response_viseme / response_end
  → HomePage handleMessage()
  → Avatar.startStream(), pushStreamAudio(), pushStreamViseme(), endStream()
  → TalkingHead AudioContext playback + scheduled Oculus mouth animation
```

Typed input omits the recording/STT part:

```text
Send form → HomePage.sendText() → {type:"text", text}
  → processTextTurn() → optional RAG → streaming Gemini → streaming Azure
  → response events → TalkingHead
```

### 2.2 Stage-by-stage contract

| Stage | Code | Input | Output | Completion/streaming behavior |
|---|---|---|---|---|
| Microphone capture | `frontend/components/MicButton.tsx:startRecording` | Browser microphone permission and `MediaStream` | `Blob` built from `MediaRecorder` chunks | Recording is local and continuous until click, 850 ms silence after speech, or 12 s without speech. The complete blob is required before upload. |
| Audio transport | `frontend/lib/wsClient.ts:sendAudio` | `Blob` | One JSON metadata frame followed by one binary WebSocket frame | Not streaming: the complete recording is sent after `MediaRecorder.stop`. |
| STT | `frontend/lib/server/avatarPipeline.ts:transcribeAudio` or `backend/services/stt.py:transcribe_audio` | Complete bytes + MIME type | Plain transcript string | Batch HTTP API. `response_format: "json"`; no partial transcription. |
| RAG query embedding | `frontend/lib/server/rag.ts:embedText` | Text and title | 768-number vector | Awaited HTTP request; full vector required. |
| RAG retrieval | `retrieveContext` → Supabase RPC `match_document_chunks` | Workspace ID + query vector | Up to five chunks, filtered to similarity ≥ 0.35 and joined as text | Awaited before the LLM starts. RAG failure is caught by `processTextTurn` and logged; the turn continues without context. |
| LLM | Node `processTextTurn` → `streamText`; Python `generate_reply_stream` → `generate_content_stream` | History + user text + system prompt/context | Text deltas | Streaming iterator. Node emits each delta immediately and writes it into Azure's text input stream. Python emits through an `asyncio.Queue`. |
| TTS | Node `beginSynthesis`/Azure `SpeechSynthesisRequest(TextStream)`; Python `synthesize_speech_stream` | Incremental text chunks | Raw 24 kHz, 16-bit, mono PCM plus callbacks | Text-stream synthesis. It starts before the final LLM text exists, but `processTextTurn` waits for synthesis completion before `response_end`. |
| Visemes | Node Azure `visemeReceived`; Python `capture_viseme` | Azure event ID and 100-ns audio offset | `{offset_ms, viseme_id, viseme}` with Oculus name | Event-driven during synthesis. Offset conversion is `audioOffset / 10_000`. |
| WebSocket event dispatch | Node `send`; Python `_process_turn.emit` + queue | Event objects | JSON text frames | Events are sent as generated; WebSocket preserves frame order. |
| Browser decode/playback | `Avatar.pushStreamAudio`, `TalkingHead.streamAudio` | Base64 PCM | AudioContext playback | PCM chunks are queued and released with a 160 ms viseme look-ahead. Playback is not started until `response_start` has initialized TalkingHead. |
| Mouth animation | `Avatar.pushStreamViseme`, `takeReadyVisemes`, TalkingHead | Timed Oculus visemes | `visemes`, `vtimes`, `vdurations` arrays | Scheduled against the cumulative PCM timeline, not merely animated on WebSocket arrival. |

### 2.3 WebSocket message schema

Client-to-server JSON envelopes:

```json
{"type":"text","text":"What is ...?"}
{"type":"audio_metadata","mime_type":"audio/webm"}
{"type":"session_config","system_prompt":"...","workspace_id":"..."}
{"type":"cancel"}
```

The next frame after `audio_metadata` is binary audio. `frontend/lib/wsClient.ts:sendAudio` sends the two frames back-to-back.

Server-to-client stream events:

```json
{"type":"transcription","text":"recognized question"}
{"type":"response_start","response_id":"...","sample_rate":24000}
{"type":"response_delta","response_id":"...","text":"partial answer"}
{"type":"response_audio","response_id":"...","audio":"base64 PCM","text":"optional fallback text"}
{"type":"response_viseme","response_id":"...","viseme":{"offset_ms":123.4,"viseme_id":4,"viseme":"E"}}
{"type":"response_end","response_id":"...","text":"complete answer","has_audio":true}
{"type":"error","message":"human-readable failure"}
```

The old `ChatResponse` type remains in `frontend/lib/wsClient.ts` for compatibility with a former one-shot protocol (`type: "response"`, base64 audio, and an array of visemes). The current Node pipeline emits the event stream instead.

## 3. Backend implementation details

There are two implementations. This distinction is important for architecture analysis.

### 3.1 Current Node/Next implementation

#### WebSocket setup and routes

`frontend/app/api/ws/route.ts` exports `GET()` with `runtime = "nodejs"` and `maxDuration = 300`. It calls `experimental_upgradeWebSocket`, creates per-connection `history`, a `SpeechSession`, MIME state, a serialized `processing` promise, and an `AbortController` for cancellation. Incoming turns are chained with:

```ts
processing = processing.catch(() => undefined).then(async () => {
  const abortController = new AbortController();
  activeAbortController = abortController;
  // STT for binary input, then processTextTurn; or processTextTurn directly.
}).catch((error) => sendPipelineError(ws, error));
```

This means turns on one connection are processed serially. A later message cannot begin its provider work until the prior `processTextTurn` promise settles.

`frontend/server.mjs` is the standalone equivalent. It uses `http.createServer`, `next({ dev: false, hostname: "0.0.0.0" })`, and `WebSocketServer({ noServer: true })`. The HTTP server responds to `/healthz` with in-memory runtime counters, passes other requests to Next, and only upgrades URLs beginning with `/api/ws`.

#### `transcribeAudio` / Groq Whisper

The active Node implementation sends a complete recording with a standard multipart request:

```ts
const form = new FormData();
form.append("file", new Blob([Uint8Array.from(audio)], { type: mimeType }),
  `recording.${extensionForMimeType(mimeType)}`);
form.append("model", "whisper-large-v3-turbo");
form.append("response_format", "json");
const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
  method: "POST",
  headers: { Authorization: `Bearer ${requiredEnvironment("GROQ_API_KEY")}` },
  body: form,
});
```

`extensionForMimeType` maps MIME strings containing `ogg`, `mp4`, or `wav` to `ogg`, `m4a`, or `wav`; all other values become `webm`. The route rejects empty audio and recordings over 25 MiB. The API is batch-only: the browser must finish recording and the server must await `response.json()` before the LLM stage begins.

#### RAG indexing and retrieval

RAG exists only in the Node implementation (`frontend/lib/server/rag.ts`). `frontend/app/api/documents/route.ts` exposes:

- `GET /api/documents?workspace_id=<id>` → `listDocuments(workspaceId)`.
- `POST /api/documents` → accepts multipart `workspace_id` and `file`, max 10 MiB, extensions `.pdf`, `.txt`, `.md`, `.csv`, `.json`, `.html`.

PDF text is extracted with dynamically imported `unpdf`; all other supported files use `file.text()`.

`chunkDocument` normalizes whitespace, creates maximum 2,400-character chunks, and overlaps adjacent chunks by 300 characters:

```ts
const end = Math.min(normalized.length, start + MAX_CHUNK_CHARACTERS);
chunks.push(normalized.slice(start, end).trim());
if (end >= normalized.length) break;
start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARACTERS);
```

For every chunk, `indexDocument` sequentially calls `embedText` (Gemini REST `gemini-embedding-2:embedContent`, `output_dimensionality: 768`), deletes any previous rows for the same `(workspace_id, document_name)`, then inserts rows into Supabase table `document_chunks` with `workspace_id`, `document_name`, `chunk_index`, `content`, and a pgvector string.

`frontend/scripts/setup-rag.mjs` creates the database schema. It enables the `vector` extension, creates `public.document_chunks` with `embedding extensions.vector(768)`, creates a workspace index and HNSW cosine index, and creates SQL function `public.match_document_chunks(query_embedding, match_workspace_id, match_count default 5)`. The function orders by vector cosine distance and limits the result count.

At question time `retrieveContext` embeds the query with title `user question`, calls the RPC with `match_count: 5`, drops rows below similarity `0.35`, and formats each result as `[document_name] content`. `processTextTurn` awaits this entire retrieval before constructing the Gemini stream. Any retrieval exception is logged and ignored, so RAG is best-effort rather than a hard dependency.

#### Gemini prompt construction and streaming

`processTextTurn` starts with either the client-supplied system prompt or `DEFAULT_SYSTEM_PROMPT`. If RAG returned text, it appends instructions and the retrieved context. It then adds an English/spoken-answer suffix and calls:

```ts
const result = streamText({
  model: google(process.env.GEMINI_MODEL || "gemini-3.1-flash-lite"),
  system: systemPrompt
    + "\n\nAlways answer in English unless the user explicitly asks for another language. "
    + "Give a complete answer to the user's question. Do not stop mid-sentence. Keep it suitable for spoken delivery.",
  messages: toModelMessages([...history, { role: "user", content: text }]),
  abortSignal: options.abortSignal,
  temperature: 0.5,
  maxOutputTokens: 700,
  providerOptions: { google: { thinkingConfig: { thinkingLevel: "minimal" } } },
});
```

`toModelMessages` maps the last 12 messages to AI SDK model messages (`user` and `assistant` roles). The loop `for await (const chunk of result.textStream)` is genuinely incremental: each non-empty chunk is appended to `reply`, emitted as `response_delta`, and written immediately to Azure's `SpeechSynthesisRequest.inputStream`.

There is one retry-oriented difference in the Python implementation: Python's `generate_reply_stream` calls Gemini's `generate_content_stream` and retries once only if no chunk has been yielded. The Node implementation relies on AI SDK/provider errors and does not implement a local retry loop.

#### Azure Speech TTS and audio format

`createSpeechSession` builds a regional Azure synthesizer using `SpeechConfig.fromSubscription`, voice `en-US-JennyNeural`, and `Raw24Khz16BitMonoPcm`. It deliberately does not synchronously open the connection because that can block WebSocket listener registration. `beginSynthesis` creates:

```ts
const request = new speechSdk.SpeechSynthesisRequest(
  speechSdk.SpeechSynthesisRequestInputType.TextStream,
);
const completion = new Promise((resolve, reject) => {
  session.synthesizer.speakAsync(request, resolve, reject);
});
```

The Azure `synthesizing` callback base64-encodes each `event.result.audioData` and emits `response_audio`. The `visemeReceived` callback converts Azure's 100-nanosecond `audioOffset` to milliseconds and emits `response_viseme`. `processTextTurn` closes the request input after the Gemini iterator ends and then **awaits `synthesis.completion`**. Thus audio can begin before the final text, but the turn is not closed until Azure finishes the complete utterance.

If streaming synthesis generated no audio, `synthesizeFallback` performs a second, non-streaming REST POST to `https://<region>.tts.speech.microsoft.com/cognitiveservices/v1` with SSML and `X-Microsoft-OutputFormat: raw-24khz-16bit-mono-pcm`. The fallback sends one complete base64 PCM payload and does not generate viseme events; the browser's synthetic viseme fallback may animate it.

#### Viseme generation and mapping

Azure supplies viseme IDs; the application does not infer phonemes from audio in the active Node server. `frontend/lib/server/visemes.ts` maps IDs 0–21 to TalkingHead/Oculus names (`sil`, `aa`, `O`, `E`, `RR`, `I`, `U`, `nn`, `SS`, `CH`, `TH`, `FF`, `DD`, `kk`, `PP`). Unknown IDs map to `sil`.

Each event sent to the browser has this shape:

```json
{
  "type": "response_viseme",
  "response_id": "...",
  "viseme": { "offset_ms": 123.4, "viseme_id": 4, "viseme": "E" }
}
```

#### Error/cancellation behavior

`sendPipelineError` sends `{type: "error", message}`. The route parses envelopes and validates a maximum 4,000-character system prompt and workspace IDs matching `/^[a-zA-Z0-9-]{16,80}$/`. `cancel` aborts the active Gemini stream; `processTextTurn` closes the Azure input stream, waits for Azure completion with errors swallowed, and returns without sending `response_end`.

### 3.2 Standalone FastAPI implementation

#### Setup and endpoints

`backend/main.py` creates `FastAPI(title="Avatar Chatbot API", version="1.0.0")`, loads `backend/.env` with `load_dotenv()`, and configures CORS for `http://localhost:3000` and `http://127.0.0.1:3000`.

Endpoints:

| Route | Handler | Behavior |
|---|---|---|
| `GET /health` | `health_check` | Returns `{"status":"ok"}` without provider calls. |
| WebSocket `/ws/chat` | `chat_websocket` | Accepts text JSON, audio metadata JSON, and a binary recording; keeps in-memory history for that connection. |

The FastAPI server has no HTTP document-upload route and no RAG integration. Its history is a list of `ChatMessage` objects and is truncated to the last 12 messages.

#### FastAPI STT

`backend/services/stt.py:transcribe_audio` constructs a Groq SDK client and performs one batch request:

```py
client = Groq(api_key=api_key)
result = client.audio.transcriptions.create(
    model="whisper-large-v3-turbo",
    file=(f"recording.{extension}", audio_bytes, mime_type),
    response_format="json",
)
```

The WebSocket receives the complete binary frame, checks the 25 MiB limit, calls `transcribe_audio` in `run_in_threadpool` through `_timed_stage`, then sends `{type: "transcription", text}`. It is not streaming.

#### FastAPI Gemini

`backend/services/llm.py` uses `google.genai`, default model `gemini-3.1-flash-lite`, temperature `0.5`, max output tokens `180`, and minimal thinking. `_as_gemini_contents` converts assistant history to Gemini role `model`. The exact streaming call is:

```py
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
```

The Python adapter retries once if the provider fails before the first non-empty chunk. `generate_reply` is a compatibility helper that joins the stream and is not used by `backend/main.py`'s streaming turn.

#### FastAPI Azure TTS

`backend/services/tts.py:_get_stream_synthesizer` creates the Azure WebSocket-v2 endpoint directly:

```py
config = speechsdk.SpeechConfig(
    endpoint=f"wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v2",
    subscription=speech_key,
)
config.speech_synthesis_voice_name = "en-US-JennyNeural"
config.set_speech_synthesis_output_format(
    speechsdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm
)
```

`synthesize_speech_stream` creates `SpeechSynthesisRequestInputType.TextStream`, starts `speak_async`, writes each Gemini chunk to `request.input_stream.write(chunk)`, and closes the input stream when the iterator ends. The `synthesizing` callback emits raw PCM bytes; the `viseme_received` callback emits `TimedViseme`. Despite the callback streaming, the function calls `synthesis_task.get()` before returning its summary. A global `threading.Lock` serializes all Python TTS calls, so simultaneous sessions cannot synthesize concurrently.

The compatibility `synthesize_speech(text)` is fully batch-oriented and returns RIFF/WAV (`Riff24Khz16BitMonoPcm`) with a complete audio buffer and sorted visemes. `backend/main.py` uses `synthesize_speech_stream`, not this batch helper.

#### FastAPI WebSocket event loop

`backend/main.py:chat_websocket` accepts JSON `audio_metadata` immediately before binary bytes, or a JSON `{"type":"text","text":"..."}` message. `_process_turn` immediately sends `response_start`, then runs the blocking provider pipeline in `asyncio.to_thread`:

```py
worker = asyncio.create_task(asyncio.to_thread(run_turn))
while not worker.done() or not events.empty():
    event = await asyncio.wait_for(events.get(), timeout=0.05)
    await websocket.send_json(event)
synthesis = await worker
```

Callbacks put events onto an `asyncio.Queue` using `loop.call_soon_threadsafe`, so the event loop can send deltas/audio/visemes while the provider thread is busy. The final `response_end` includes the accumulated text and `has_audio`. There is no RAG context, session-config envelope, cancellation envelope, or fallback TTS in this FastAPI path.

## 4. Frontend implementation details

### 4.1 Page state and WebSocket integration

`frontend/app/page.tsx` is a client component. It owns `messages`, `draft`, `systemPrompt`, `workspaceId`, document state, avatar state (`idle | listening | thinking | speaking`), connection state, and response/stream queues.

On mount it creates `ChatWebSocketClient`, connects, and passes `handleMessage`. The client reconnects with exponential backoff capped at 15 seconds. `sendText` starts TalkingHead streaming from the click event to preserve browser autoplay permission, sets session config, sends the text, adds the user message, and sets `thinking`.

The microphone path calls `handleAudioReady`, which sends session config then the complete blob. The page also creates a persistent workspace ID in localStorage under `pitb-avatar-workspace-id`, then lists documents with `GET /api/documents`.

`handleMessage` behavior:

- `transcription`: append a user chat bubble.
- `response_start`: create an empty assistant bubble, set the active response ID, and call `Avatar.startStream(sample_rate)`.
- `response_delta`: append text to the active assistant bubble immediately.
- `response_audio`: enqueue `Avatar.pushStreamAudio(base64, optional text)` behind prior stream operations.
- `response_viseme`: enqueue `Avatar.pushStreamViseme(viseme)` behind prior stream operations.
- `response_end`: replace the assistant bubble with final text; call `endStream` if `has_audio`, otherwise cancel and return to idle.
- `error`: cancel the avatar stream, remove an empty in-progress assistant bubble, append a system message, and return to idle.

`streamOperationsRef` is a promise chain. It intentionally serializes audio and viseme handling in the order WebSocket events were received; it does not process independent audio/viseme messages in parallel.

### 4.2 TalkingHead initialization

`frontend/components/Avatar.tsx:AvatarScene` dynamically imports `@met4citizen/talkinghead`, constructs `new TalkingHead(...)` with `avatarOnly`, the Three.js camera, no built-in lipsync modules, and a pixel ratio capped at 2. It dynamically loads `LipsyncEn`, tries `NEXT_PUBLIC_AVATAR_URL` first, then falls back to:

```text
https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/brunette.glb
```

It adds `head.armature` to the React Three Fiber scene and calls `frameUpperBody` to frame hips-to-head. The render loop calls `head.animate(delta * 1000)` on every frame. `next.config.ts` marks `ws`, the Azure SDK, and `unpdf` as external server packages and uses `webpack/talkinghead-loader.cjs` to neutralize TalkingHead's dynamic optional module import and its automatic early `audioCtx.resume()`.

### 4.3 Audio playback and viseme scheduling

The server emits raw PCM, not WAV, for the stream. `base64ToArrayBuffer` decodes it. `resamplePcm16` linearly interpolates Int16 samples if Azure's 24 kHz source differs from the avatar AudioContext sample rate.

`Avatar.startStream` calls TalkingHead:

```ts
head.streamStart(
  {
    sampleRate: head.audioCtx.sampleRate,
    lipsyncType: "words",
    lipsyncLang: "en",
    waitForAudioChunks: true,
    mood: "neutral",
  },
  onAudioStart,
  onAudioEnd,
);
```

The call resumes the existing TalkingHead AudioContext and awaits `streamStart`. `waitForAudioChunks: true` prevents a stream from being considered started before audio arrives.

`pushStreamAudio` queues `{audio, durationMs, sampleRate, text}`. If the server sends `text` on an audio event (the one-shot/fallback compatibility case), `buildAudioAwareWordTiming` derives 20 ms RMS energy intervals and distributes words by character weight. For normal Azure stream chunks without `text`, it waits until a viseme look-ahead is available. `LIP_SYNC_LOOK_AHEAD_MS = 160` means a PCM chunk is held until the queue has a viseme at least 160 ms beyond the chunk's end.

`pushStreamViseme` validates finite non-negative offsets and known Oculus names, ignores stale offsets, queues the event, and attempts a flush. `takeReadyVisemes` converts timed events to TalkingHead arrays:

```ts
{
  visemes: batch.map((viseme) => viseme.viseme),
  vtimes: batch.map((viseme) => viseme.offset_ms),
  vdurations: /* next offset - current, minimum 40 ms */,
}
```

If Azure provides no usable viseme for an audio chunk, `pushStreamAudio` synthesizes deterministic cues `aa, E, O, PP, I, sil` across that chunk and adds a trailing silence look-ahead marker. This is a timing fallback, not phoneme recognition.

At `endStream`, remaining visemes are flushed, remaining audio is force-flushed, and `head.streamNotifyEnd()` tells TalkingHead no more audio will arrive. `cancelStream` increments a session token, clears buffers, and calls `head.streamInterrupt()`.

The old one-shot `Avatar.speak` path decodes a complete base64 audio buffer with `AudioContext.decodeAudioData`, builds a complete `visemes/vtimes/vdurations` timeline from response visemes, then calls `head.speakAudio`. It is retained for protocol compatibility and is not the normal stream path.

## 5. Timing and sequencing behavior

This section describes the exact critical path after the user stops speaking.

### 5.1 Browser-side stop and upload

1. `MicButton` continuously samples an `AnalyserNode` while `MediaRecorder` writes chunks.
2. Speech is considered started when volume exceeds `max(0.018, noiseFloor * 2.8)`. `onSpeechDetected` can cancel an existing avatar turn.
3. After speech, 850 ms of silence calls `recorder.stop()`. If no speech is heard, recording stops after 12 seconds.
4. `recorder.onstop` builds one Blob from all chunks, closes monitoring and microphone tracks, then calls `onAudioReady`. **Everything through this point waits for the complete recording.**
5. `sendAudio` sends MIME metadata and then the entire binary Blob. There is no live microphone-to-STT streaming.

### 5.2 STT, retrieval, and response start

6. The Node route's per-connection promise queue begins a turn. It awaits `transcribeAudio`; Groq must receive and process the complete file and return JSON before anything reaches the LLM.
7. The server sends `transcription` to the browser. The client displays the recognized user text.
8. `processTextTurn` validates text, sends `response_start`, and the browser calls `Avatar.startStream(24_000)`. The user sees the assistant bubble and TalkingHead prepares the AudioContext while server work continues.
9. If `workspaceId` is set, `retrieveContext` awaits a Gemini embedding request, then awaits the Supabase RPC. This is fully blocking before `streamText` starts. RAG failures are caught and do not stop the turn.

### 5.3 LLM/TTS overlap

10. `streamText` starts Gemini. The first text chunk is appended to `reply`, emitted as `response_delta`, and written to Azure `request.inputStream` immediately.
11. Azure can synthesize and emit PCM/viseme events concurrently with later Gemini chunks because `SpeechSynthesisRequest` is a text stream and its callbacks fire while the input iterator continues.
12. The server sends each resulting event as soon as the callback fires. The browser receives text, audio, and visemes interleaved in WebSocket order.
13. The server closes Azure's text input only after Gemini's text stream ends, then **awaits `synthesis.completion`**. Therefore the first audio can be early, but `response_end` is deliberately delayed until Azure has completed the full generated answer.

### 5.4 Browser playback overlap and visible response

14. `HomePage` serializes calls through `streamOperationsRef`. `response_audio` and `response_viseme` events are not applied concurrently; each waits for prior avatar operation completion.
15. `Avatar.pushStreamAudio` decodes base64 and queues PCM. It does not necessarily release it immediately: normal chunks wait for the 160 ms viseme look-ahead. This can add intentional buffering latency, but it keeps mouth timing ahead of sound.
16. Once `flushStreamBuffers` has enough cues, it calls `TalkingHead.streamAudio`. TalkingHead schedules PCM in its AudioContext and applies the supplied `vtimes/vdurations` on the same audio timeline.
17. `response_end` calls `endStream`, which flushes final visemes/audio and calls `streamNotifyEnd`. TalkingHead invokes `onAudioEnd`, and the page returns the avatar state to `idle`.

### 5.5 What is and is not streaming

Streaming/overlapped:

- Gemini output is streamed (`streamText` / `generate_content_stream`).
- Azure receives incremental text and produces incremental PCM and viseme callbacks.
- WebSocket events are emitted incrementally.
- Browser playback can begin before the final answer text is complete.

Full-response/blocking:

- Microphone capture and Groq transcription are batch.
- RAG query embedding and retrieval complete before Gemini begins.
- Azure completion is awaited before `response_end`.
- A fallback Azure REST synthesis waits for the complete answer and sends one audio blob.
- The Python implementation's `synthesis_task.get()` blocks its worker before returning, even though callbacks are forwarded concurrently.
- Per-connection turn queues serialize multiple user turns; a second turn waits for the first.

## 6. Known limitations and TODOs

### Architecture and deployment ambiguity

- The repository contains two implementations with different behavior and protocols. The FastAPI README describes `/ws/chat`, while the current Node frontend defaults to `/api/ws` and includes RAG/session configuration/cancellation. Decide whether Python is legacy, fallback, or intended production service and remove or clearly isolate the unused implementation.
- `frontend/server.mjs` passes `null` for `SpeechSession` to `processTextTurn`, so `beginSynthesis` intentionally creates a no-op synthesis request there. In that custom server path, Azure audio is not available unless the session construction is wired into the server. The Next route does create a `SpeechSession`. This is a significant deployment-specific voice risk.
- The README says “Gemini 2.5 Flash” in the diagram, while code defaults to `gemini-3.1-flash-lite`. Documentation and runtime configuration should be reconciled.

### Latency and throughput

- STT cannot start until the user stops speaking and the complete recording is uploaded. Live/partial STT would reduce turn-start latency.
- RAG indexes chunks serially: `for` + `await embedText(...)`. `Promise.all` with a bounded concurrency limit would reduce indexing time.
- RAG retrieval has two sequential network calls (embedding, then Supabase RPC) and blocks the LLM. A hybrid strategy could begin a generic LLM stream immediately and splice context only when available, or cache query/document embeddings.
- The single global Python `_stream_lock` serializes TTS across all sessions. Node's session-specific synthesizer is also attached to mutable callback properties; concurrent turns on one session are prevented, but multi-session behavior should be load-tested.
- The browser's `streamOperationsRef` serializes audio and viseme application. This is safe for ordering but can back up if `streamAudio` becomes asynchronous or the network delivers many frames.
- The intentional 160 ms look-ahead adds latency. It is a correctness trade-off; adaptive buffering or server-side interleaving could reduce it.
- `response_end` waits for all TTS completion even though the user already hears early audio. A separate “text complete” and “audio drained” event could make UI state more precise.
- The production build was slow in the OneDrive-backed workspace; benchmark builds and runtime outside OneDrive before treating build latency as an application property.

### Error handling and edge cases

- Provider retries are inconsistent: Python Gemini retries once before its first chunk; Node Gemini has no explicit retry; Groq and embeddings have no retries/backoff.
- There are no automated tests in the tracked tree. Add unit tests for `chunkDocument`, `toOculusViseme`, PCM resampling, viseme ordering, message parsing, and cancellation.
- Azure TTS errors can preserve text but leave the UI with no audio. The browser displays text but has limited user-visible diagnostics beyond a system error.
- Azure viseme offsets are trusted as a single timeline. Clock drift, dropped frames, or provider callback anomalies are only partially handled by sorting/validation and browser look-ahead.
- `workspace_id` is a client-generated localStorage UUID-like value. There is no authentication/authorization layer; anyone who knows a workspace ID can query or upload its document chunks if the endpoint is exposed.
- The RAG Supabase client uses the service-role key server-side. This is appropriate for trusted server code but makes route authentication and workspace authorization essential before public deployment.
- Uploading a document deletes existing chunks before inserting new embeddings. A failed insert can leave the document absent; use a transaction/staging table for atomic replacement.
- Document names are truncated to 160 characters for indexing but the response returns the original name, which can create display/index identity inconsistencies.
- The fallback TTS REST path escapes XML special characters but does not handle all SSML-sensitive characters/attributes.
- The custom server's `runtimeStats` is process-global and only reports the latest coarse stage, not per-session observability.
- Connection close/error cleanup should be load-tested around Azure callbacks, an in-flight `request.inputStream`, and aborted Gemini streams.

## 7. File structure

```text
avatar-chatbot/
├── README.md                         Project setup and legacy FastAPI-oriented architecture notes
├── backend/
│   ├── .env.example                   Empty provider-key template (copy to .env locally)
│   ├── requirements.txt               FastAPI, Uvicorn, Gemini, Groq, Azure Speech dependencies
│   ├── main.py                        FastAPI app, /health, /ws/chat, Python event queue pipeline
│   ├── viseme_map.py                  Azure viseme ID → Oculus name mapping
│   └── services/
│       ├── __init__.py                Python service package marker
│       ├── stt.py                     Groq Whisper batch transcription adapter
│       ├── llm.py                     Gemini streaming adapter and 12-message history conversion
│       └── tts.py                     Azure streaming and compatibility batch synthesis adapters
└── frontend/
    ├── package.json                   Next scripts and Node dependency ranges
    ├── package-lock.json              Locked Node dependency graph
    ├── next.config.ts                 Next config, external server packages, TalkingHead loader hook
    ├── server.mjs                     Optional standalone Next + ws HTTP/WebSocket server
    ├── app/
    │   ├── layout.tsx                 HTML root and metadata
    │   ├── page.tsx                   Main client UI, WebSocket event reducer, upload/send controls
    │   ├── globals.css                 Global Tailwind/CSS styles
    │   └── api/
    │       ├── ws/route.ts             Vercel/Next WebSocket upgrade route and per-session queue
    │       └── documents/route.ts      RAG document GET/POST endpoints and extraction validation
    ├── components/
    │   ├── Avatar.tsx                  Three/R3F scene, TalkingHead lifecycle, PCM/viseme buffering
    │   ├── MicButton.tsx                MediaRecorder, microphone constraints, VAD/end-of-speech
    │   └── ChatLog.tsx                  Accessible chat bubble list
    ├── lib/
    │   ├── wsClient.ts                  Reconnecting browser WebSocket client and message types
    │   └── server/
    │       ├── avatarPipeline.ts        Node STT, RAG integration, Gemini stream, Azure stream, events
    │       ├── rag.ts                    Gemini embeddings, chunking, Supabase indexing/retrieval
    │       └── visemes.ts                Azure ID → Oculus viseme mapping
    ├── scripts/setup-rag.mjs             PostgreSQL/pgvector schema and match_document_chunks RPC
    ├── webpack/talkinghead-loader.cjs    Neutralizes TalkingHead dynamic optional imports/autoplay resume
    ├── types/talkinghead.d.ts            TypeScript declarations for TalkingHead and LipsyncEn
    ├── tailwind.config.ts                Tailwind content/theme configuration
    ├── postcss.config.js                 PostCSS plugin configuration
    ├── eslint.config.mjs                 ESLint/Next lint configuration
    └── tsconfig.json                     TypeScript compiler/path alias configuration
```

Ignored local-only directories/files such as `backend/.venv`, `frontend/node_modules`, `frontend/.next`, `.env*`, and logs are intentionally omitted from the tree above.

## 8. Configuration and operational notes

### Provider environment variables

The Python service expects `GEMINI_API_KEY`, `GROQ_API_KEY`, `AZURE_SPEECH_KEY`, and `AZURE_SPEECH_REGION` in `backend/.env`. The Node service additionally uses `GEMINI_MODEL` (optional), `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_AVATAR_URL`, `RAG_SUPABASE_URL`, `RAG_SUPABASE_SERVICE_ROLE_KEY`, and either `RAG_POSTGRES_URL_NON_POOLING` or `RAG_POSTGRES_URL` for schema setup. The browser must never receive provider secrets; only `NEXT_PUBLIC_*` values are bundled.

### Local launch modes

Python mode: from `backend`, install `requirements.txt` and run `uvicorn main:app --reload`; health is `http://localhost:8000/health` and WebSocket is `ws://localhost:8000/ws/chat`.

Node/Next mode: from `frontend`, install dependencies and run `npm run dev` (Next route) or `npm run start` (custom `server.mjs` after a production build). The default browser URL is same-origin `/api/ws`; set `NEXT_PUBLIC_WS_URL` when the WebSocket server is separate. Ensure the selected deployment mode has the Azure/Groq/Gemini variables configured and, for RAG, the Supabase variables plus schema created with `npm`/`node scripts/setup-rag.mjs`.

