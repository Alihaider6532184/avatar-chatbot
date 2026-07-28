import { NextResponse } from "next/server";
import { synthesizeVoicePreview } from "@/lib/server/avatarPipeline";
import { getVoice, isVoiceId } from "@/lib/voices";

export const runtime = "nodejs";
export const maxDuration = 30;

const PREVIEW_LINE = "Hello! I’m ready to bring your ideas to life. How can I help today?";

function backendPreviewUrl(): string | null {
  const configuredUrl = process.env.BACKEND_HTTP_URL
    || process.env.NEXT_PUBLIC_WS_URL;
  if (!configuredUrl) return null;
  try {
    const url = new URL(configuredUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/voice-preview";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { voice_id?: unknown };
    if (!isVoiceId(payload.voice_id)) {
      return NextResponse.json({ error: "Choose a valid voice." }, { status: 400 });
    }

    if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
      const previewUrl = backendPreviewUrl();
      if (!previewUrl) {
        throw new Error("Azure Speech or a backend preview URL must be configured.");
      }
      const response = await fetch(previewUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: payload.voice_id }),
        cache: "no-store",
      });
      const responseText = await response.text();
      let upstreamPayload: Record<string, unknown>;
      try {
        upstreamPayload = JSON.parse(responseText) as Record<string, unknown>;
      } catch {
        upstreamPayload = {
          error: response.ok
            ? "The speech server returned an invalid response."
            : `The speech server returned status ${response.status}.`,
        };
      }
      if (!response.ok && typeof upstreamPayload.error !== "string") {
        upstreamPayload.error = typeof upstreamPayload.detail === "string"
          ? upstreamPayload.detail
          : "The voice preview is temporarily unavailable.";
      }
      return NextResponse.json(upstreamPayload, { status: response.status });
    }

    const preview = await synthesizeVoicePreview(payload.voice_id, PREVIEW_LINE);
    return NextResponse.json({
      ...preview,
      text: PREVIEW_LINE,
      voice: getVoice(payload.voice_id).name,
    });
  } catch (error) {
    console.error("[avatar] voice preview failed", error);
    return NextResponse.json(
      { error: "The voice preview is temporarily unavailable." },
      { status: 503 },
    );
  }
}
