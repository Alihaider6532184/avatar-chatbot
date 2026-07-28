# 3D Talking Avatar Chatbot

A production-structured 3D talking avatar chatbot built for the PITB internship deliverable. The browser is intentionally a lightweight renderer: it records/sends user input to the FastAPI service, then renders the Ready Player Me avatar and plays the returned audio and viseme timeline. Speech recognition, Gemini reasoning, Azure speech synthesis, and viseme translation all stay in the backend. This centralizes AI logic, prevents provider keys from reaching the browser, and makes providers easier to iterate on or swap later.

## Architecture

```
Mic audio or typed text → FastAPI WebSocket (/ws/chat)
  audio only: Groq Whisper (whisper-large-v3-turbo) → text
  text + in-memory session history → Gemini 2.5 Flash → reply
  reply → Azure Speech (en-US-JennyNeural) → WAV audio + viseme events
  WebSocket response: text + base64 audio + mapped timed Oculus visemes
→ Next.js renderer → TalkingHead/RPM avatar lip-sync
```

The frontend never calls Gemini, Groq, or Azure and contains no API keys. Its only backend connection is `NEXT_PUBLIC_WS_URL`.

## Setup

### Backend

1. Open a terminal in `backend`.
2. Create and activate a virtual environment (recommended):

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

3. Install dependencies and configure local secrets:

   ```powershell
   pip install -r requirements.txt
   Copy-Item .env.example .env
   ```

4. Fill `GEMINI_API_KEY`, `GROQ_API_KEY`, `AZURE_SPEECH_KEY`, and `AZURE_SPEECH_REGION` in `backend/.env`. Do not commit this file.
5. Run the API:

   ```powershell
   uvicorn main:app --reload
   ```

The local health endpoint is available at `http://localhost:8000/health`.

### Frontend

1. Open a second terminal in `frontend`.
2. Install dependencies and configure the internal backend URL:

   ```powershell
   npm install
   Copy-Item .env.local.example .env.local
   npm run dev
   ```

3. Open `http://localhost:3000` and allow microphone access when prompted.

`READY_PLAYER_ME_AVATAR_URL` at the top of `frontend/components/Avatar.tsx` is the configurable default avatar. For best lip-sync, use a Ready Player Me export that includes Oculus viseme morph targets.

### Avatar and voice personalization

- Use **Upload GLB** below the avatar to load a custom model for the current browser session. Files are validated in the browser and are never uploaded to the server. Humanoid GLBs with Oculus or ARKit facial morph targets give the best lip-sync results.
- Choose from Nova, Aria, or Atlas. **Preview** generates a short Azure Speech sample and animates the avatar with the returned visemes; selecting a card uses that voice for future replies. The selected voice is remembered in local storage.
- With the documented split frontend/backend setup, `/api/voice-preview` proxies to `BACKEND_HTTP_URL` (or derives it from `NEXT_PUBLIC_WS_URL`). In an integrated deployment with Azure variables available to Next.js, it synthesizes the sample directly.

## Pipeline

1. The client sends either a typed JSON message or a binary `MediaRecorder` audio blob through `/ws/chat`.
2. FastAPI transcribes audio with Groq Whisper when needed and retains a short in-memory conversation history for that WebSocket session.
3. Gemini produces a concise, conversational reply. The backend retries the LLM once if it fails.
4. Azure Speech synthesizes a WAV reply and emits standard Azure viseme IDs with audio offsets. `backend/viseme_map.py` translates those IDs to the Oculus names TalkingHead expects.
5. The backend sends text, base64 WAV audio, and timed visemes in one WebSocket response. The frontend adds the chat bubble and lets TalkingHead schedule the audio and mouth shapes. If TTS fails, text is still returned.

Each backend provider stage logs its latency to the Uvicorn console for demos and performance discussion.

## Notes

- Conversation history is intentionally in-memory and scoped to one WebSocket connection; no database is required for this version.
- The WebSocket client reconnects with capped exponential backoff after an unexpected disconnect.
- `.env` and `.env.local` are local-only files. Keep them out of source control.
