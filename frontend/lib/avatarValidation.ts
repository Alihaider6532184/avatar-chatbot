const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;

const REQUIRED_HUMANOID_NODES = ["Armature", "Hips", "Head"] as const;
const REQUIRED_OCULUS_VISEMES = [
  "viseme_PP",
  "viseme_FF",
  "viseme_TH",
  "viseme_DD",
  "viseme_kk",
  "viseme_CH",
  "viseme_SS",
  "viseme_nn",
  "viseme_RR",
  "viseme_aa",
  "viseme_E",
  "viseme_I",
  "viseme_O",
  "viseme_U",
] as const;

interface GlbJson {
  asset?: { version?: string };
  meshes?: Array<{
    extras?: { targetNames?: unknown };
    primitives?: Array<{ targets?: unknown[] }>;
  }>;
  nodes?: Array<{ name?: string }>;
  skins?: unknown[];
}

export interface AvatarValidationResult {
  valid: boolean;
  error?: string;
}

function invalid(error: string): AvatarValidationResult {
  return { valid: false, error };
}

export async function validateAvatarGlb(file: Blob): Promise<AvatarValidationResult> {
  try {
    if (file.size < 20) {
      return invalid("This file is not a valid GLB 2.0 avatar.");
    }

    const header = new DataView(await file.slice(0, 20).arrayBuffer());
    const magic = header.getUint32(0, true);
    const version = header.getUint32(4, true);
    const declaredLength = header.getUint32(8, true);
    const jsonLength = header.getUint32(12, true);
    const jsonType = header.getUint32(16, true);

    if (
      magic !== GLB_MAGIC
      || version !== 2
      || declaredLength > file.size
      || jsonType !== GLB_JSON_CHUNK
      || jsonLength === 0
      || 20 + jsonLength > file.size
    ) {
      return invalid("This file is not a valid GLB 2.0 avatar.");
    }

    const jsonBytes = await file.slice(20, 20 + jsonLength).arrayBuffer();
    const jsonText = new TextDecoder().decode(jsonBytes).replace(/\u0000+$/g, "").trim();
    const glb = JSON.parse(jsonText) as GlbJson;
    if (glb.asset?.version !== "2.0") {
      return invalid("This file is not a valid GLB 2.0 avatar.");
    }

    const nodeNames = new Set(
      (glb.nodes ?? [])
        .map((node) => node.name)
        .filter((name): name is string => typeof name === "string"),
    );
    const missingNodes = REQUIRED_HUMANOID_NODES.filter((name) => !nodeNames.has(name));
    if (!glb.skins?.length || missingNodes.length > 0) {
      return invalid(
        `This GLB is missing the compatible humanoid skeleton (${missingNodes.join(", ") || "skin"}).`,
      );
    }

    const targetNames = new Set<string>();
    let morphTargetCount = 0;
    for (const mesh of glb.meshes ?? []) {
      const names = mesh.extras?.targetNames;
      if (Array.isArray(names)) {
        for (const name of names) {
          if (typeof name === "string") targetNames.add(name);
        }
      }
      for (const primitive of mesh.primitives ?? []) {
        morphTargetCount = Math.max(morphTargetCount, primitive.targets?.length ?? 0);
      }
    }

    if (morphTargetCount === 0 || targetNames.size === 0) {
      return invalid(
        "This GLB has a static face and no facial morph targets. Choose a talking-avatar GLB that includes Oculus visemes.",
      );
    }

    const missingVisemes = REQUIRED_OCULUS_VISEMES.filter((name) => !targetNames.has(name));
    if (missingVisemes.length > 0) {
      return invalid(
        "This GLB has facial shapes, but it is missing the Oculus visemes required for lip-sync.",
      );
    }

    return { valid: true };
  } catch {
    return invalid("This file is not a valid GLB 2.0 avatar.");
  }
}
