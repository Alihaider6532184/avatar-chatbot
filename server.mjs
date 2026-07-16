import http from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import { createSpeechSession, closeSpeechSession, processTextTurn, transcribeAudio, sendPipelineError } from "./lib/server/avatarPipeline.ts";

const port = Number(process.env.PORT || 3000);
const app = next({ dev: false, hostname: "0.0.0.0", port });
const handle = app.getRequestHandler();
await app.prepare();
const server = http.createServer((req, res) => handle(req, res));
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  const history = [];
  let speech = null;
  let mime = "audio/webm";
  let queue = Promise.resolve();
  let systemPrompt = "";
  let workspaceId = "";
  let active = null;
  try { speech = createSpeechSession(); } catch (error) { sendPipelineError(ws, error); }

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (error) { sendPipelineError(ws, error); return; }
      if (msg.type === "cancel") { active?.abort(); return; }
      if (msg.type === "session_config") { systemPrompt = String(msg.system_prompt || ""); workspaceId = String(msg.workspace_id || ""); return; }
      if (msg.type === "audio_metadata") { mime = String(msg.mime_type || "audio/webm"); return; }
      if (msg.type !== "text") return;
      queue = queue.catch(() => undefined).then(async () => {
        if (!speech) throw new Error("Speech synthesis is not configured.");
        active = new AbortController();
        await processTextTurn(ws, history, String(msg.text || ""), speech, { abortSignal: active.signal, systemPrompt, workspaceId });
        active = null;
      }).catch((error) => sendPipelineError(ws, error));
      return;
    }
    queue = queue.catch(() => undefined).then(async () => {
      if (!speech) throw new Error("Speech synthesis is not configured.");
      active = new AbortController();
      const text = await transcribeAudio(Buffer.from(data), mime);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "transcription", text }));
      await processTextTurn(ws, history, text, speech, { abortSignal: active.signal, systemPrompt, workspaceId });
      active = null;
    }).catch((error) => sendPipelineError(ws, error));
  });
  ws.on("close", () => { active?.abort(); closeSpeechSession(speech); speech = null; });
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/api/ws")) wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else socket.destroy();
});
server.listen(port, "0.0.0.0", () => console.log(`Avatar server listening on ${port}`));
