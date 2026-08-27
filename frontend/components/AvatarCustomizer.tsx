"use client";

import type { ChangeEvent } from "react";
import { BUILT_IN_AVATARS } from "@/lib/avatars";
import { VOICE_OPTIONS, type VoiceId } from "@/lib/voices";

interface AvatarCustomizerProps {
  avatarName: string;
  avatarStatus: string;
  avatarDisabled: boolean;
  customAvatar: boolean;
  hasAvatar: boolean;
  previewingVoice: VoiceId | null;
  selectedAvatarId: string | null;
  selectedVoice: VoiceId;
  voiceDisabled: boolean;
  onAvatarUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onPreviewVoice: (voiceId: VoiceId) => void;
  onResetAvatar: () => void;
  onSelectAvatar: (avatarId: string) => void;
  onSelectVoice: (voiceId: VoiceId) => void;
}

function AvatarPortrait({ accent, initials }: { accent: string; initials: string }) {
  return (
    <span className={`relative grid aspect-square w-full place-items-center overflow-hidden rounded-2xl bg-gradient-to-br ${accent}`}>
      <svg
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 mx-auto h-[88%] w-[88%] text-slate-950/35"
        fill="currentColor"
        viewBox="0 0 100 100"
      >
        <circle cx="50" cy="34" r="20" />
        <path d="M14 100c2-27 16-41 36-41s34 14 36 41H14Z" />
      </svg>
      <span className="relative mt-auto mb-2 rounded-full bg-slate-950/55 px-2 py-0.5 text-[0.58rem] font-black tracking-wider text-white backdrop-blur">
        {initials}
      </span>
    </span>
  );
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
  hasAvatar,
  previewingVoice,
  selectedAvatarId,
  selectedVoice,
  voiceDisabled,
  onAvatarUpload,
  onPreviewVoice,
  onResetAvatar,
  onSelectAvatar,
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

      <fieldset className="mt-4" aria-describedby="avatar-choice-help">
        <legend className="flex w-full items-center gap-2 text-sm font-semibold text-white">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-cyan-300 text-[0.68rem] font-black text-slate-950">
            1
          </span>
          Choose your avatar
        </legend>
        <p className="mt-2 text-xs leading-5 text-slate-400" id="avatar-choice-help">
          Pick a ready-made avatar for a quick start, or upload a compatible avatar of your own.
        </p>

        <div className="mt-3 grid grid-cols-3 gap-2.5">
          {BUILT_IN_AVATARS.map((avatar) => {
            const selected = selectedAvatarId === avatar.id;
            return (
              <button
                aria-label={`Select ${avatar.name}, ${avatar.description}`}
                aria-pressed={selected}
                className={`group min-w-0 rounded-2xl border p-2 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-300/80 disabled:cursor-not-allowed disabled:opacity-45 ${
                  selected
                    ? "border-cyan-300 bg-cyan-400/10 shadow-[0_0_28px_rgba(34,211,238,0.12)]"
                    : "border-slate-700 bg-slate-900/70 hover:border-slate-500 hover:bg-slate-800/80"
                }`}
                disabled={avatarDisabled}
                key={avatar.id}
                onClick={() => onSelectAvatar(avatar.id)}
                type="button"
              >
                <span className="block overflow-hidden rounded-2xl">
                  <AvatarPortrait accent={avatar.accent} initials={avatar.initials} />
                </span>
                <span className="mt-2 flex items-center justify-between gap-1">
                  <span className="truncate text-xs font-bold text-white">{avatar.name}</span>
                  {selected ? (
                    <span aria-hidden="true" className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-cyan-300 text-[0.6rem] font-black text-slate-950">
                      ✓
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-[0.62rem] text-slate-400">
                  {avatar.description}
                </span>
              </button>
            );
          })}
        </div>

        <div className="my-3 flex items-center gap-3 text-[0.62rem] font-bold uppercase tracking-[0.18em] text-slate-500">
          <span className="h-px flex-1 bg-slate-700" />
          or use your own
          <span className="h-px flex-1 bg-slate-700" />
        </div>

        <label className={`flex items-center gap-3 rounded-2xl border border-dashed p-3 transition ${
          customAvatar
            ? "border-cyan-300 bg-cyan-400/10"
            : "border-slate-600 bg-slate-900/65 hover:border-cyan-300/70 hover:bg-slate-800/80"
        } ${avatarDisabled ? "cursor-not-allowed opacity-45" : "cursor-pointer"}`}>
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-slate-950">
            <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
              <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-white">Upload your own avatar</span>
            <span className="mt-0.5 block text-xs text-slate-400">GLB format · maximum 50 MB</span>
          </span>
          <span className="shrink-0 rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-950">
            Browse
          </span>
          <input
            accept=".glb,model/gltf-binary"
            className="sr-only"
            disabled={avatarDisabled}
            onChange={onAvatarUpload}
            type="file"
          />
        </label>
      </fieldset>

      <div aria-live="polite" className="mt-3 flex items-start gap-3 rounded-2xl bg-slate-900/55 p-3">
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${hasAvatar ? "bg-emerald-300" : "bg-amber-300"}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-bold text-slate-100">{avatarName}</p>
          <p className="mt-0.5 text-[0.68rem] leading-4 text-slate-400">{avatarStatus}</p>
        </div>
        {hasAvatar ? (
          <button
            className="shrink-0 rounded-lg px-2 py-1 text-[0.68rem] font-semibold text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
            disabled={avatarDisabled}
            onClick={onResetAvatar}
            type="button"
          >
            Clear
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-[0.66rem] leading-4 text-slate-500">
        Custom avatars need a humanoid skeleton and Oculus visemes for lip-sync. Sample avatar licenses apply.{" "}
        <a
          className="text-slate-400 underline decoration-slate-600 underline-offset-2 hover:text-cyan-200"
          href="https://github.com/met4citizen/TalkingHead#credits-and-licenses"
          rel="noreferrer"
          target="_blank"
        >
          View details
        </a>
        .
      </p>

      <fieldset className="mt-4">
        <legend className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
          <span className="grid h-5 w-5 place-items-center rounded-full border border-slate-600 text-[0.58rem] text-slate-300">2</span>
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
