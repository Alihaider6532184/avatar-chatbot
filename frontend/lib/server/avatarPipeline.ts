import https from "node:https";
import * as speechSdk from "microsoft-cognitiveservices-speech-sdk";
import type { WebSocket } from "ws";
import { toOculusViseme } from "@/lib/server/visemes";
import { retrieveContext } from "@/lib/server/rag";
import {
  DEFAULT_VOICE_ID,
  getVoice,
  type VoiceId,
} from "@/lib/voices";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful conversational avatar assistant. Answer clearly, warmly, "
  + "and concisely. Your answers will be spoken aloud, so avoid long paragraphs, "
  + "dense lists, markdown, and unnecessary preambles.";

const MAX_HISTORY_MESSAGES = 12;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 4_000;
const directFetch = globalThis.fetch.bind(globalThis);
const directHttpsRequest = https.request.bind(https);

export type ChatHistory = Array<{ role: "user" | "assistant"; content: string }>;

export interface TurnOptions {
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  workspaceId?: string;
  voiceId?: VoiceId;
}

type ServerEvent = Record<string, unknown> & { type: string };

interface TimedViseme {
  offset_ms: number;
  viseme_id: number;
  viseme: string;
}

interface TimedSpeech {
  audio: Buffer;
  visemes: TimedViseme[];
}

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(event));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export interface SpeechSession {
  synthesizer: speechSdk.SpeechSynthesizer;
  connection: speechSdk.Connection;
}

export function createSpeechSession(voiceId: VoiceId = DEFAULT_VOICE_ID): SpeechSession {
  const region = requiredEnvironment("AZURE_SPEECH_REGION");
  // Use the SDK's subscription configuration so it negotiates the correct
  // regional websocket endpoint and keeps streaming synthesis reliable on
  // serverless runtimes.
  const speechConfig = speechSdk.SpeechConfig.fromSubscription(
    requiredEnvironment("AZURE_SPEECH_KEY"),
    region,
  );
  speechConfig.speechSynthesisVoiceName = getVoice(voiceId).azureName;
  speechConfig.speechSynthesisOutputFormat =
    speechSdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
  speechConfig.setProperty(
    speechSdk.PropertyId.SpeechSynthesis_FrameTimeoutInterval,
    "100000000",
  );
  speechConfig.setProperty(
    speechSdk.PropertyId.SpeechSynthesis_RtfTimeoutThreshold,
    "10",
  );

  const synthesizer = new speechSdk.SpeechSynthesizer(speechConfig, null);
  const connection = speechSdk.Connection.fromSynthesizer(synthesizer);
  // Do not synchronously open the Azure socket here. On hosted runtimes this
  // can block the WebSocket connection handler before client message listeners
  // are registered. The SDK opens it lazily on the first speak request.
  return { synthesizer, connection };
}

export function closeSpeechSession(session: SpeechSession | null): void {
  if (!session) return;
  session.synthesizer.close();
}

function escapeSsml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function fetchAzureSpeech(
  text: string,
  voiceId: VoiceId,
  outputFormat: "raw-24khz-16bit-mono-pcm" | "riff-24khz-16bit-mono-pcm",
): Promise<Buffer> {
  const region = requiredEnvironment("AZURE_SPEECH_REGION");
  const body = `<speak version="1.0" xml:lang="en-US"><voice name="${getVoice(voiceId).azureName}">${escapeSsml(text)}</voice></speak>`;
  return new Promise<Buffer>((resolve, reject) => {
    const request = directHttpsRequest(
      {
        hostname: `${region}.tts.speech.microsoft.com`,
        path: "/cognitiveservices/v1",
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
          "Content-Length": Buffer.byteLength(body),
        "Ocp-Apim-Subscription-Key": requiredEnvironment("AZURE_SPEECH_KEY"),
        "User-Agent": "piba-avatar-local",
        "X-Microsoft-OutputFormat": outputFormat,
      },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`Speech synthesis failed with status ${response.statusCode}.`));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      },
    );
    request.setTimeout(30_000, () => {
      request.destroy(new Error("Speech synthesis took too long to respond."));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function synthesizeAzureTimedSpeech(
  text: string,
  voiceId: VoiceId,
  outputFormat: speechSdk.SpeechSynthesisOutputFormat,
): Promise<TimedSpeech> {
  const speechConfig = speechSdk.SpeechConfig.fromSubscription(
    requiredEnvironment("AZURE_SPEECH_KEY"),
    requiredEnvironment("AZURE_SPEECH_REGION"),
  );
  speechConfig.speechSynthesisVoiceName = getVoice(voiceId).azureName;
  speechConfig.speechSynthesisOutputFormat = outputFormat;
  speechConfig.setProperty(
    speechSdk.PropertyId.SpeechSynthesis_FrameTimeoutInterval,
    "30000000",
  );
  speechConfig.setProperty(
    speechSdk.PropertyId.SpeechSynthesis_RtfTimeoutThreshold,
    "10",
  );

  const synthesizer = new speechSdk.SpeechSynthesizer(speechConfig, null);
  const visemes: TimedViseme[] = [];
  synthesizer.visemeReceived = (_sender, event) => {
    visemes.push({
      offset_ms: event.audioOffset / 10_000,
      viseme_id: event.visemeId,
      viseme: toOculusViseme(event.visemeId),
    });
  };

  try {
    const result = await new Promise<speechSdk.SpeechSynthesisResult>((resolve, reject) => {
      let settled = false;
      const finish = (
        callback: (value: speechSdk.SpeechSynthesisResult) => void,
        value: speechSdk.SpeechSynthesisResult,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const timeout = setTimeout(() => {
        fail(new Error("Timed speech synthesis took too long to respond."));
      }, 30_000);
      synthesizer.speakTextAsync(
        text,
        (value) => finish(resolve, value),
        fail,
      );
    });
    if (
      result.reason !== speechSdk.ResultReason.SynthesizingAudioCompleted
      || !result.audioData.byteLength
    ) {
      throw new Error("Timed speech synthesis returned no audio.");
    }
    return {
      audio: Buffer.from(result.audioData),
      visemes: visemes.sort((left, right) => left.offset_ms - right.offset_ms),
    };
  } finally {
    synthesizer.close();
  }
}

async function generateGeminiReply(
  systemPrompt: string,
  history: ChatHistory,
  abortSignal?: AbortSignal,
): Promise<string> {
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: history.slice(-MAX_HISTORY_MESSAGES).map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 700,
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  });

  const payload = await new Promise<string>((resolve, reject) => {
    const request = directHttpsRequest(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "x-goog-api-key": requiredEnvironment("GEMINI_API_KEY"),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`The AI service returned status ${response.statusCode}.`));
            return;
          }
          resolve(responseBody);
        });
      },
    );
    const abort = () => request.destroy(new Error("The AI request was cancelled."));
    abortSignal?.addEventListener("abort", abort, { once: true });
    request.setTimeout(30_000, () => {
      request.destroy(new Error("The AI service took too long to respond."));
    });
    request.on("error", reject);
    request.on("close", () => abortSignal?.removeEventListener("abort", abort));
    request.end(body);
  });

  const result = JSON.parse(payload) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return result.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim() ?? "";
}

async function synthesizeFallback(
  ws: WebSocket,
  responseId: string,
  text: string,
  voiceId: VoiceId,
): Promise<{ hasAudio: boolean; visemeCount: number; lastVisemeOffsetMs: number }> {
  try {
    const timedSpeech = await synthesizeAzureTimedSpeech(
      text,
      voiceId,
      speechSdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm,
    );
    send(ws, {
      type: "response_audio",
      response_id: responseId,
      audio: timedSpeech.audio.toString("base64"),
    });
    timedSpeech.visemes.forEach((viseme) => send(ws, {
      type: "response_viseme",
      response_id: responseId,
      viseme,
    }));
    return {
      hasAudio: true,
      visemeCount: timedSpeech.visemes.length,
      lastVisemeOffsetMs: timedSpeech.visemes.at(-1)?.offset_ms ?? 0,
    };
  } catch (error) {
    console.warn("[avatar] timed Azure visemes unavailable; using audio-aware fallback", error);
  }

  const audio = await fetchAzureSpeech(text, voiceId, "raw-24khz-16bit-mono-pcm");
  if (!audio.length) {
    return { hasAudio: false, visemeCount: 0, lastVisemeOffsetMs: 0 };
  }
  send(ws, {
    type: "response_audio",
    response_id: responseId,
    audio: audio.toString("base64"),
    text,
  });
  return { hasAudio: true, visemeCount: 0, lastVisemeOffsetMs: 0 };
}

export async function processTextTurn(
  ws: WebSocket,
  history: ChatHistory,
  userText: string,
  _session: SpeechSession | null,
  options: TurnOptions = {},
): Promise<void> {
  const text = userText.trim();
  if (options.abortSignal?.aborted) return;
  if (!text) throw new Error("Please type a message before sending.");
  if (text.length > MAX_TEXT_CHARACTERS) {
    throw new Error("Please keep messages under 4,000 characters.");
  }
  const responseId = crypto.randomUUID();
  const startedAt = performance.now();
  let firstTextAt: number | null = null;
  let firstAudioAt: number | null = null;
  let fallbackVisemeCount = 0;
  let fallbackLastVisemeOffsetMs = 0;
  let hasAudio = false;
  let reply = "";
  send(ws, {
    type: "response_start",
    response_id: responseId,
    sample_rate: 24_000,
  });
  console.info("[avatar] response started");

  let systemPrompt = options.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  if (options.workspaceId) {
    try {
      const context = await retrieveContext(options.workspaceId, text);
      if (context) {
        systemPrompt += "\n\nUse the following uploaded-document context when it is relevant. "
          + "Do not invent facts that are not supported by it. If it does not answer the question, say so clearly.\n"
          + context;
      }
    } catch (error) {
      console.warn("[avatar] RAG retrieval unavailable", error);
    }
  }
  try {
    const providerSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    console.info("[avatar] generating response");
    const generatedText = await generateGeminiReply(
      systemPrompt
        + "\n\nAlways answer in English unless the user explicitly asks for another language. "
        + "Give a complete answer to the user's question. Do not stop mid-sentence. Keep it suitable for spoken delivery.",
      [...history, { role: "user", content: text }],
      providerSignal,
    );
    console.info("[avatar] response generated");
    if (generatedText) {
      firstTextAt = performance.now();
      reply = generatedText;
      send(ws, {
        type: "response_delta",
        response_id: responseId,
        text: generatedText,
      });
    }
    if (reply.trim()) {
      try {
        console.info("[avatar] synthesizing response");
        const fallback = await synthesizeFallback(
          ws,
          responseId,
          reply.trim(),
          options.voiceId ?? DEFAULT_VOICE_ID,
        );
        if (fallback.hasAudio) {
          hasAudio = true;
          firstAudioAt = performance.now();
          fallbackVisemeCount = fallback.visemeCount;
          fallbackLastVisemeOffsetMs = fallback.lastVisemeOffsetMs;
        }
        console.info("[avatar] response synthesized");
      } catch (error) {
        console.warn("[avatar] fallback speech synthesis unavailable", error);
      }
    }
  } catch (error) {
    if (options.abortSignal?.aborted) {
      return;
    }
    throw error;
  }

  if (options.abortSignal?.aborted) return;

  reply = reply.trim();
  if (!reply) throw new Error("I couldn't generate a response right now. Please try again.");

  history.push(
    { role: "user", content: text },
    { role: "assistant", content: reply },
  );
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }

  const visemes = {
    count: fallbackVisemeCount,
    lastOffsetMs: fallbackLastVisemeOffsetMs,
  };
  console.info("[avatar] streaming turn", {
    firstTextMs: firstTextAt ? Math.round(firstTextAt - startedAt) : null,
    firstAudioMs: firstAudioAt ? Math.round(firstAudioAt - startedAt) : null,
    totalMs: Math.round(performance.now() - startedAt),
    visemes: visemes.count,
    lastVisemeOffsetMs: Math.round(visemes.lastOffsetMs),
  });
  send(ws, {
    type: "response_end",
    response_id: responseId,
    text: reply,
    has_audio: hasAudio,
  });
}

export interface VoicePreview {
  audio: string;
  visemes: TimedViseme[];
}

function approximateVisemes(text: string, durationMs: number): VoicePreview["visemes"] {
  const phonemes: number[] = [];
  const normalized = text.toLowerCase();
  const characterVisemes: Record<string, number> = {
    a: 2,
    b: 21,
    c: 20,
    d: 19,
    e: 4,
    f: 18,
    g: 20,
    h: 1,
    i: 6,
    j: 16,
    k: 20,
    l: 19,
    m: 21,
    n: 14,
    o: 8,
    p: 21,
    q: 20,
    r: 13,
    s: 15,
    t: 19,
    u: 7,
    v: 18,
    w: 7,
    x: 15,
    y: 6,
    z: 15,
  };
  for (let index = 0; index < normalized.length; index += 1) {
    const pair = normalized.slice(index, index + 2);
    let visemeId: number | undefined;
    if (pair === "th") {
      visemeId = 17;
      index += 1;
    } else if (pair === "sh" || pair === "ch") {
      visemeId = 16;
      index += 1;
    } else {
      visemeId = characterVisemes[normalized[index]];
    }
    if (visemeId !== undefined && phonemes.at(-1) !== visemeId) {
      phonemes.push(visemeId);
    }
  }

  const usableDurationMs = Math.max(200, durationMs - 120);
  const stepMs = usableDurationMs / Math.max(1, phonemes.length);
  return [
    { offset_ms: 0, viseme_id: 0, viseme: "sil" },
    ...phonemes.map((visemeId, index) => ({
      offset_ms: 60 + index * stepMs,
      viseme_id: visemeId,
      viseme: toOculusViseme(visemeId),
    })),
    {
      offset_ms: Math.max(80, durationMs - 40),
      viseme_id: 0,
      viseme: "sil",
    },
  ];
}

export async function synthesizeVoicePreview(
  voiceId: VoiceId,
  text: string,
): Promise<VoicePreview> {
  try {
    const timedSpeech = await synthesizeAzureTimedSpeech(
      text,
      voiceId,
      speechSdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm,
    );
    return {
      audio: timedSpeech.audio.toString("base64"),
      visemes: timedSpeech.visemes,
    };
  } catch (error) {
    console.warn("[avatar] timed preview visemes unavailable; using fallback timing", error);
  }

  const audio = await fetchAzureSpeech(text, voiceId, "riff-24khz-16bit-mono-pcm");
  if (audio.byteLength <= 44) throw new Error("Voice preview returned no audio.");
  const durationMs = (audio.byteLength - 44) / 2 / 24_000 * 1_000;
  return {
    audio: audio.toString("base64"),
    visemes: approximateVisemes(text, durationMs),
  };
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

export async function transcribeAudio(audio: Buffer, mimeType: string): Promise<string> {
  if (!audio.length) throw new Error("The recording was empty. Please try again.");
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new Error("That recording is too large. Please keep it under 25 MB.");
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([Uint8Array.from(audio)], { type: mimeType }),
    `recording.${extensionForMimeType(mimeType)}`,
  );
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "json");
  const response = await directFetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${requiredEnvironment("GROQ_API_KEY")}` },
    body: form,
  });
  if (!response.ok) {
    console.error("[avatar] Groq transcription failed", response.status);
    throw new Error("I couldn't transcribe that recording. Please try again.");
  }
  const payload = await response.json() as { text?: string };
  const transcription = payload.text?.trim();
  if (!transcription) throw new Error("I couldn't hear any speech in that recording.");
  return transcription;
}

export function sendPipelineError(ws: WebSocket, error: unknown): void {
  console.error("[avatar] pipeline error", error);
  send(ws, {
    type: "error",
    message: error instanceof Error
      ? error.message
      : "Something went wrong. Please reconnect and try again.",
  });
}
