# AI Handoff Context — Avatar Chatbot

Read this file together with PROJECT_TECHNICAL_DOCUMENTATION.md. The technical document describes source-level behavior; this file records project history, decisions, failures, fixes, deployment context, branch policy, and continuation rules.

## 1. What was built

This is a 3D voice/chat avatar for PITB. React Three Fiber renders a TalkingHead-compatible GLB avatar. Typed text or a completed browser MediaRecorder recording travels over WebSocket. The primary Node/Next server performs Groq Whisper batch STT, optional Gemini-embedding/Supabase pgvector retrieval, streamed Gemini generation, Azure Speech TextStream synthesis, and timed Azure visemes. The browser buffers raw PCM and viseme events and schedules TalkingHead mouth animation.

The repository also contains a separate FastAPI implementation under backend. It has /health and /ws/chat, Python Groq STT, Python Gemini streaming, and Python Azure streaming TTS, but no RAG or document routes. It is not imported by the current Next route.

## 2. Repository history

The frontend originally contained its own nested .git while backend was outside the repository. Adding frontend as a directory would have produced a gitlink, so the frontend metadata was promoted to the project root and the source was staged as frontend/ plus backend/. Git recognized the frontend move as renames and preserved its history.

Remote: https://github.com/Alihaider6532184/avatar-chatbot

Current branch meanings:

- main: older remote default branch.
- safe: protected/live baseline, currently at documentation commit dffe10c.
- development: active upgrade branch, starts at the same baseline.
- agent/publish-complete-project: historical publishing branch.

The production host must be configured to deploy safe. Creating a branch does not change a Vercel Production Branch setting.

## 3. Voice incident context

The reported symptom was that the reopened site did not produce audible voice. Local provider values are in backend/.env; frontend/.env.local, frontend/.env.development.local, and frontend/.env.vercel are ignored local/deployment snapshots. Only backend/.env.example is committed and all values there are empty.

A critical deployment-path mismatch exists:

- frontend/app/api/ws/route.ts calls createSpeechSession() and passes Azure SpeechSession to processTextTurn.
- frontend/server.mjs passes null as the session argument. beginSynthesis() treats null as a no-op synthesis object. In that custom-server mode, text may stream while Azure audio is never generated unless a real SpeechSession is created and closed.

When debugging, first identify which server is live. Inspect WebSocket frames in order: response_start, response_delta, response_audio, response_viseme, response_end.

## 4. Important design decisions

The primary pipeline intentionally overlaps Gemini and Azure: every Gemini text delta is sent to Azure TextStream immediately. Azure callbacks emit raw 24 kHz Int16 mono PCM and visemes as they are generated.

The protocol uses response_id so stale events can be discarded after cancellation. Audio and viseme messages are separate because provider callbacks have different batch sizes. Browser Avatar.tsx reconstructs one cumulative audio timeline.

Chrome autoplay is handled by starting/resuming TalkingHead's existing AudioContext from the Send or microphone user gesture. The TalkingHead webpack loader removes eager automatic resume.

The browser holds normal PCM until a 160 ms viseme look-ahead is available. This adds latency but prevents a late mouth cue from missing the syllable. If Azure provides no usable cues, synthetic aa/E/O/PP/I/sil cues are inserted per chunk.

RAG is best effort. Retrieval is awaited before Gemini; retrieval errors are logged and the turn continues without context. Workspace IDs are client-generated and there is currently no authentication/authorization boundary.

## 5. Problems encountered and resolutions

Embedded Git repository: resolved by promoting frontend history to the parent and verifying Git reports renames rather than a submodule.

Git ownership safety: Codex and the Windows owner have different SIDs. Repository-scoped safe.directory is passed to Git commands; global safety settings were not changed.

Temporary metadata move permissions: an attempted metadata move toward C:\tmp partially failed. The nested .git was located and restored; the temporary empty metadata backup was removed only after exact path verification.

Lint/build verification: frontend lint passed with one existing unused _text warning at frontend/lib/server/avatarPipeline.ts:104 and no errors. Backend compileall passed with the project interpreter. Production build exceeded three minutes in the OneDrive-backed workspace without returning a compiler error; rerun outside OneDrive or with a longer timeout.

API key safety: root/frontend ignore rules exclude .env*, backend .env, .venv, node_modules, .next, .vercel, and logs. Do not expose values in diagnostics, documentation, issues, screenshots, or AI prompts.

## 6. Rules for another AI

1. Work on development; never make exploratory edits directly on safe.
2. Read PROJECT_TECHNICAL_DOCUMENTATION.md before changing protocol, RAG, TTS, or avatar timing.
3. Treat frontend/app/api/ws/route.ts plus frontend/lib/server/avatarPipeline.ts as primary unless FastAPI is explicitly requested.
4. Inspect frontend/server.mjs separately because its null SpeechSession is a known audio risk.
5. Preserve response_id and the response event schema; update server, ServerMessage types, and HomePage.handleMessage together for protocol changes.
6. Normal stream audio is raw 24 kHz Int16 mono PCM, not WAV.
7. Do not apply visemes immediately on arrival; maintain cumulative PCM timing and look-ahead.
8. Keep turns serialized per connection unless cancellation/history semantics are redesigned.
9. Add bounded retries without replaying already-yielded speech.
10. Add tests before broad refactors; no automated test suite is tracked.

## 7. Safe development workflow

Use this sequence from the repository root:

    git switch development
    git status -sb
    npm.cmd run lint --prefix frontend
    backend\.venv\Scripts\python.exe -m compileall -q backend
    npm.cmd run build --prefix frontend
    git diff --check
    git add <intended-files>
    git commit -m "Focused change description"
    git push origin development

After review, merge development into safe and redeploy safe. Do not force-push either branch.

## 8. Troubleshooting

Text but no response_audio: check whether the live server is the Next route or server.mjs, Azure key/region, SpeechSession creation, and synthesis completion logs.

response_audio exists but browser is silent: check Avatar.startStream returned true, AudioContext is running, sample_rate is 24000, the call came from a user gesture, and PCM has even byte length.

Audio plays but mouth is still: inspect response_viseme frames, Azure-to-Oculus mapping, the OCULUS_VISEMES allowlist, monotonic offsets, and GLB morph targets.

No transcript: the browser must send audio_metadata JSON followed by one binary frame. Recordings are batch, empty recordings are rejected, and the 25 MiB limit applies.

RAG ignored: confirm local workspace ID, session_config, Supabase service-role variables, Gemini embedding key, vector extension, document_chunks table, HNSW index, and match_document_chunks RPC.

WebSocket reconnect loop: verify NEXT_PUBLIC_WS_URL, ws/wss protocol, proxy upgrade support, and the /api/ws upgrade route. The client retries with a capped exponential backoff and can replay pending actions after reconnect.

## 9. Next-level upgrade candidates

Unify or retire one backend implementation. Fix server.mjs to create and close a real SpeechSession. Add authentication, workspace authorization, rate limits, provider timeouts, structured tracing, and CI. Add tests for chunking, viseme mapping, PCM resampling, envelope parsing, cancellation, and stream completion. Make document replacement transactional and parallelize embeddings with bounded concurrency. Consider partial STT to reduce post-speech delay. Separate text-complete from audio-drained UI events. Configure preview deployments from development and production deployments from safe.

## 10. Security rules

Keep GEMINI_API_KEY, GROQ_API_KEY, AZURE_SPEECH_KEY, RAG_SUPABASE_SERVICE_ROLE_KEY, database URLs, JWT secrets, and Vercel OIDC tokens server-side. Rotate any credential that appears in a public issue, chat, commit, screenshot, or build artifact. Treat the Supabase service-role key as database-administration access.

## 11. Handoff checklist

Before changing code, an AI should know which backend is active, know safe is the live baseline and development is the work branch, inspect only environment variable presence, understand batch STT versus streamed Gemini/TTS, know that response_end waits for Azure completion, preserve PCM/viseme timing, update both ends of WebSocket changes, run lint/compile/build, and keep safe deployable.
