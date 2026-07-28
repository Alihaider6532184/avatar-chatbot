"use client";

import type { ChangeEvent } from "react";
import { VOICE_OPTIONS, type VoiceId } from "@/lib/voices";

interface AvatarCustomizerProps {
  avatarName: string;
  avatarStatus: string;
  avatarDisabled: boolean;
  customAvatar: boolean;
  previewingVoice: VoiceId | null;
  selectedVoice: VoiceId;
  voiceDisabled: boolean;
  onAvatarUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onPreviewVoice: (voiceId: VoiceId) => void;
  onResetAvatar: () => void;
  onSelectVoice: (voiceId: VoiceId) => void;
}

function PlayIcon({ playing }: { playing: boolean }) {
  if (playing) {
    return (
      <span aria-hidden="true" className="flex h-4 items-end gap-0.5">
        <span className="h-2 w-0.5 animate-pulse rounded-full bg-current" />
        <span className="h-4 w-0.5 animate-pulse rounded-full bg-current [animation-delay:120ms]" />
        <span className="h-3 w-0.5 animate-pulse rounded-full bg-current [animation-delay:240ms]" />
      </span>
    );
  }
  return (
    <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 16 16" width="12">
      <path d="M4 2.6a1 1 0 0 1 1.52-.85l8 5.4a1 1 0 0 1 0 1.7l-8 5.4A1 1 0 0 1 4 13.4V2.6Z" />
    </svg>
  );
}

export function AvatarCustomizer({
  avatarName,
  avatarStatus,
  avatarDisabled,
  customAvatar,
  previewingVoice,
  selectedVoice,
  voiceDisabled,
  onAvatarUpload,
  onPreviewVoice,
  onResetAvatar,
  onSelectVoice,
}: AvatarCustomizerProps) {
  return (
    <section
      aria-labelledby="personalize-title"
      className="mt-4 rounded-3xl border border-slate-700/70 bg-slate-950/55 p-4 backdrop-blur"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-cyan-300">
            Make it yours
          </p>
          <h2 className="mt-1 text-lg font-semibold text-white" id="personalize-title">
            Avatar & voice
          </h2>
        </div>
        <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider text-emerald-300">
          Live
        </span>
      </div>

      <div className="mt-4 flex items-center gap-3 rounded-2xl border border-dashed border-slate-600 bg-slate-900/65 p-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-400/10 text-cyan-300">
          <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
            <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-100">{avatarName}</p>
          <p className="mt-0.5 truncate text-xs text-slate-400">{avatarStatus}</p>
        </div>
        {customAvatar ? (
          <button
            className="shrink-0 rounded-xl px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
            disabled={avatarDisabled}
            onClick={onResetAvatar}
            type="button"
          >
            Reset
          </button>
        ) : null}
        <label className={`shrink-0 rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-950 transition hover:bg-cyan-100 ${avatarDisabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}>
          Upload GLB
          <input
            accept=".glb,model/gltf-binary"
            className="sr-only"
            disabled={avatarDisabled}
            onChange={onAvatarUpload}
            type="file"
          />
        </label>
      </div>
      <p className="mt-2 text-[0.68rem] leading-4 text-slate-500">
        Up to 50 MB. For lip-sync, use a humanoid GLB with Oculus or ARKit face shapes.
      </p>

      <fieldset className="mt-4">
        <legend className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
          Choose a voice
        </legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {VOICE_OPTIONS.map((voice) => {
            const selected = selectedVoice === voice.id;
            const playing = previewingVoice === voice.id;
            return (
              <div
                className={`min-w-0 rounded-2xl border p-2.5 transition ${
                  selected
                    ? "border-cyan-300/70 bg-cyan-400/10 shadow-[0_0_24px_rgba(34,211,238,0.08)]"
                    : "border-slate-700 bg-slate-900/70 hover:border-slate-500"
                }`}
                key={voice.id}
              >
                <button
                  aria-pressed={selected}
                  className="flex w-full min-w-0 items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={voiceDisabled}
                  onClick={() => onSelectVoice(voice.id)}
                  type="button"
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br ${voice.accent} text-xs font-black text-slate-950`}>
                    {voice.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-bold text-white">{voice.name}</span>
                    <span className="block truncate text-[0.62rem] text-slate-400">{voice.description}</span>
                  </span>
                </button>
                <button
                  aria-label={`${playing ? "Playing" : "Preview"} ${voice.name} voice`}
                  className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[0.65rem] font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    playing
                      ? "bg-cyan-300 text-slate-950"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white"
                  }`}
                  disabled={voiceDisabled}
                  onClick={() => onPreviewVoice(voice.id)}
                  type="button"
                >
                  <PlayIcon playing={playing} />
                  {playing ? "Playing" : "Preview"}
                </button>
              </div>
            );
          })}
        </div>
      </fieldset>
    </section>
  );
}
