export const VOICE_OPTIONS = [
  {
    id: "nova",
    name: "Nova",
    description: "Warm & natural",
    azureName: "en-US-JennyNeural",
    accent: "from-violet-400 to-fuchsia-400",
  },
  {
    id: "aria",
    name: "Aria",
    description: "Clear & expressive",
    azureName: "en-US-AriaNeural",
    accent: "from-cyan-300 to-blue-400",
  },
  {
    id: "atlas",
    name: "Atlas",
    description: "Calm & confident",
    azureName: "en-US-GuyNeural",
    accent: "from-amber-300 to-orange-400",
  },
] as const;

export type VoiceId = (typeof VOICE_OPTIONS)[number]["id"];

export const DEFAULT_VOICE_ID: VoiceId = "nova";

export function isVoiceId(value: unknown): value is VoiceId {
  return typeof value === "string"
    && VOICE_OPTIONS.some((voice) => voice.id === value);
}

export function getVoice(voiceId: VoiceId) {
  return VOICE_OPTIONS.find((voice) => voice.id === voiceId)
    ?? VOICE_OPTIONS[0];
}
