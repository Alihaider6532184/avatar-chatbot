# AI Handoff Context — PITB Avatar Chatbot

Read this file together with `PROJECT_TECHNICAL_DOCUMENTATION.md`.

## Current production state

- Live URL: `https://avatar-chatbot-psi.vercel.app`
- Primary platform: Vercel
- Primary code path: `frontend/app/api/ws/route.ts` + `frontend/lib/server/avatarPipeline.ts`
- Active development branch: `development`
- Default remote branch: `main`
- Current UI starts with no avatar.
- User must upload a compatible Oculus-viseme GLB.
- Voices: Nova, Aria, Atlas.
- Production documents use Supabase when configured.
- Chat appears above setup panels and is vertically resizable.

## Memory status

The current project has short-term session memory only:

- per WebSocket connection,
- most recent 12 user/assistant messages,
- not stored in a database,
- lost on refresh/disconnect.

Do not describe document RAG as conversation memory.

## Current provider behavior

- Audio STT: Groq `whisper-large-v3-turbo`
- LLM: direct Gemini `generateContent`, default `gemini-3.1-flash-lite`
- TTS: Azure Speech SDK `speakTextAsync`
- Conversation audio: raw 24 kHz, 16-bit, mono PCM
- Preview audio: RIFF 24 kHz, 16-bit, mono PCM
- Lip-sync: exact Azure `visemeReceived` offsets mapped to Oculus names
- Fallback: Azure REST audio plus browser audio-aware mouth cues

## Critical timing rules

1. Preserve `response_id` on all response events.
2. Initialize TalkingHead stream before applying audio.
3. Do not apply late visemes directly without the cumulative PCM timeline.
4. Keep the 160 ms viseme look-ahead unless retested.
5. Flush final PCM and remaining visemes in the same operation.
6. Wait for the stream operation queue before ending speech.
7. Keep explicit silence cues during quiet audio.

## GLB rules

The current validator requires:

- GLB 2.0,
- skin,
- `Armature`, `Hips`, and `Head`,
- facial morph targets,
- complete required Oculus viseme target names.

The avatar file stays in the browser as an object URL. Do not upload it to the server unless the product requirements explicitly change.

## RAG rules

- Production: Supabase/pgvector + Gemini embeddings.
- Local fallback: ignored JSON store + keyword scoring.
- Workspace IDs are browser-generated and currently unauthenticated.
- RAG failure must not block a normal AI answer.
- Sensitive documents should not be used until authentication/authorization is added.

## Local development

From `frontend/`:

```powershell
npm run dev
```

This starts:

- Next.js: `http://localhost:3000`
- WebSocket/preview server: `http://localhost:3001`

Provider values may be loaded from ignored local environment files. Never print, document, or commit their values.

## Required checks

```powershell
cd frontend
npm run lint
npm exec tsc -- --noEmit
npm run build
```

```powershell
backend\.venv\Scripts\python.exe -m compileall -q backend
git diff --check
```

For avatar/lip-sync changes, also test:

- MPFB-compatible GLB,
- Brunette-compatible GLB,
- Avaturn-compatible GLB,
- Nova,
- Aria,
- Atlas,
- preview speech,
- complete WebSocket speech,
- browser console.

## Git and deployment

- Use `development` for active upgrades.
- Do not force-push.
- Stage explicit files; private local text files and environment files must remain ignored.
- Vercel production is linked from `frontend/.vercel/project.json`.
- Production deploys are made from `frontend/`.
- After deployment, inspect the deployment and verify the stable alias.

## Known limitations

- no persistent long-term conversation memory,
- no authentication,
- no workspace authorization,
- avatar/system prompt not persistent,
- batch STT,
- complete-response Gemini generation,
- no full automated test suite,
- duplicate Node/FastAPI implementations,
- WebGL limits for complex GLBs.

## Next recommended work

1. Authentication and authorization.
2. Automated tests and CI.
3. Optional user-controlled persistent memory.
4. True streamed Gemini-to-Azure synthesis.
5. Partial/live STT.
6. Persistent avatar library.
7. RAG citations and document deletion.
8. Structured tracing and provider dashboards.
