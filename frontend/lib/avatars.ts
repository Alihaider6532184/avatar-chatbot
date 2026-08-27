export interface AvatarModelOptions {
  avatarMood: "neutral" | "happy";
  baseline?: Record<string, number>;
  body: "F" | "M";
  retarget?: Record<string, Record<string, number> | number>;
  url: string;
}

export interface BuiltInAvatar {
  accent: string;
  description: string;
  id: string;
  initials: string;
  model: AvatarModelOptions;
  name: string;
}

const SAMPLE_AVATAR_BASE =
  "https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@eed58d198076a7e1e825f804802921c4d3804d46/avatars";

export const BUILT_IN_AVATARS: readonly BuiltInAvatar[] = [
  {
    id: "mira",
    name: "Mira",
    description: "Friendly guide",
    initials: "MI",
    accent: "from-cyan-300 via-sky-400 to-blue-600",
    model: {
      url: `${SAMPLE_AVATAR_BASE}/brunette.glb`,
      body: "F",
      avatarMood: "neutral",
    },
  },
  {
    id: "lina",
    name: "Lina",
    description: "Warm assistant",
    initials: "LI",
    accent: "from-fuchsia-300 via-violet-400 to-indigo-600",
    model: {
      url: `${SAMPLE_AVATAR_BASE}/avaturn.glb`,
      body: "F",
      avatarMood: "happy",
      retarget: {
        Hips: { y: 0.03 },
        Spine: { y: 0.02 },
        Spine1: { y: 0.02, z: 0.01 },
        Spine2: { y: 0.02, z: 0.01 },
        Neck: { z: 0.02, y: 0.01 },
        Head: { z: 0.02 },
        LeftShoulder: { rx: -0.5 },
        RightShoulder: { rx: -0.5 },
        scaleToHipsLevel: 1,
      },
      baseline: {
        headRotateX: -0.05,
        eyeBlinkLeft: 0.15,
        eyeBlinkRight: 0.15,
      },
    },
  },
  {
    id: "zayn",
    name: "Zayn",
    description: "Professional host",
    initials: "ZA",
    accent: "from-amber-200 via-orange-400 to-rose-600",
    model: {
      url: `${SAMPLE_AVATAR_BASE}/avatarsdk.glb`,
      body: "M",
      avatarMood: "neutral",
      retarget: {
        Neck: { z: -0.01, rx: -0.15 },
        Neck1: { z: -0.01, rx: -0.15 },
        Neck2: { z: -0.01, rx: -0.15 },
        LeftShoulder: { rz: -0.3 },
        RightShoulder: { rz: 0.3 },
        scaleToEyesLevel: 1,
        origin: { y: -0.1 },
      },
      baseline: {
        headRotateX: -0.04,
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
      },
    },
  },
] as const;

export const CUSTOM_AVATAR_DEFAULTS = {
  body: "F",
  avatarMood: "neutral",
} as const satisfies Omit<AvatarModelOptions, "url">;
