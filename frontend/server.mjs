import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import nextEnvironment from "@next/env";

const dev = process.argv.includes("--dev");
const wsOnly = process.argv.includes("--ws-only");
nextEnvironment.loadEnvConfig(process.cwd(), dev);

if (dev) {
  const providerNames = new Set([
    "AZURE_SPEECH_KEY",
    "AZURE_SPEECH_REGION",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
  ]);
  const localProviderPaths = [
    path.resolve(process.cwd(), ".env.vercel"),
    path.resolve(process.cwd(), "../backend/.env"),
  ];
  for (const localProviderPath of localProviderPaths) {
    if (!existsSync(localProviderPath)) continue;
    for (const line of readFileSync(localProviderPath, "utf8").split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim();
      if (!providerNames.has(name) || process.env[name]) continue;
      let value = line.slice(separator + 1).trim();
      if (
        value.length >= 2
        && ((value.startsWith('"') && value.endsWith('"'))
          || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (!value) continue;
      process.env[name] = value;
    }
  }
}

const pipelineModule = await import("./lib/server/avatarPipeline.ts");
const pipeline = pipelineModule.default ?? pipelineModule;
const { processTextTurn, synthesizeVoicePreview, transcribeAudio, sendPipelineError } = pipeline;
if (![processTextTurn, synthesizeVoicePreview, transcribeAudio, sendPipelineError].every((item) => typeof item === "function")) {
  throw new Error(`Avatar pipeline exports unavailable: ${Object.keys(pipeline).join(", ")}`);
}

const port = Number(process.env.PORT || 3000);
let handle = null;
if (!wsOnly) {
  const { default: next } = await import("next");
  const app = next({ dev, hostname: "0.0.0.0", port, webpack: dev });
  handle = app.getRequestHandler();
  await app.prepare();
}
const runtimeStats = {
  version: "voice-health-v2",
  connections: 0,
  messages: 0,
  lastStage: "startup",
  lastError: null,
};
const reportError = (ws, error) => {
  runtimeStats.lastStage = "error";
  runtimeStats.lastError = error instanceof Error ? error.message : String(error);
  sendPipelineError(ws, error);
};
const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(runtimeStats));
    return;
  }
  if (wsOnly && req.url === "/voice-preview" && req.method === "POST") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const voiceId = ["nova", "aria", "atlas"].includes(payload.voice_id)
        ? payload.voice_id
        : null;
      if (!voiceId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Choose a valid voice." }));
        return;
      }
      const text = "Hello! I'm ready to bring your ideas to life. How can I help today?";
      const preview = await synthesizeVoicePreview(voiceId, text);
      const voiceNames = { nova: "Nova", aria: "Aria", atlas: "Atlas" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...preview, text, voice: voiceNames[voiceId] }));
    } catch (error) {
      console.error("[avatar] voice preview failed", error);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "The voice preview is temporarily unavailable." }));
    }
    return;
  }
  if (handle) {
    handle(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found." }));
});
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  runtimeStats.connections += 1;
  runtimeStats.lastStage = "connected";
  const history = [];
  let mime = "audio/webm";
  let queue = Promise.resolve();
  let systemPrompt = "";
  let workspaceId = "";
  let voiceId = "nova";
  let active = null;

  ws.on("message", (data, isBinary) => {
    runtimeStats.messages += 1;
    runtimeStats.lastStage = isBinary ? "audio-received" : "json-received";
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (error) { reportError(ws, error); return; }
      if (msg.type === "cancel") { active?.abort(); return; }
      if (msg.type === "session_config") {
        systemPrompt = String(msg.system_prompt || "");
        workspaceId = String(msg.workspace_id || "");
        const nextVoiceId = ["nova", "aria", "atlas"].includes(msg.voice_id) ? msg.voice_id : "nova";
        voiceId = nextVoiceId;
        return;
      }
      if (msg.type === "audio_metadata") { mime = String(msg.mime_type || "audio/webm"); return; }
      if (msg.type !== "text") return;
      queue = queue.catch(() => undefined).then(async () => {
        active = new AbortController();
        runtimeStats.lastStage = "text-processing";
        console.log("[avatar] text turn received");
        await processTextTurn(ws, history, String(msg.text || ""), null, { abortSignal: active.signal, systemPrompt, workspaceId, voiceId });
        runtimeStats.lastStage = "text-complete";
        active = null;
      }).catch((error) => reportError(ws, error));
      return;
    }
    queue = queue.catch(() => undefined).then(async () => {
      active = new AbortController();
      runtimeStats.lastStage = "transcribing";
      console.log("[avatar] audio turn received", { bytes: data.length, mime });
      const text = await transcribeAudio(Buffer.from(data), mime);
      runtimeStats.lastStage = "transcribed";
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "transcription", text }));
      await processTextTurn(ws, history, text, null, { abortSignal: active.signal, systemPrompt, workspaceId, voiceId });
      runtimeStats.lastStage = "audio-complete";
      active = null;
    }).catch((error) => reportError(ws, error));
  });
  const close = () => {
    active?.abort();
  };
  ws.on("close", close);
  ws.on("error", close);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/api/ws")) wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else socket.destroy();
});
server.listen(port, "0.0.0.0", () => console.log(`Avatar server listening on ${port}`));
