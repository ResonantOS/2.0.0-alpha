export const DEFAULT_USER_PROFILE = {
  displayName: "ResonantOS User",
  subtitle: "Local sovereign profile",
  email: "",
};

export const DEFAULT_AUGMENTOR_SYSTEM_PROMPT = [
  "Act as Augmentor, the Strategist inside ResonantOS.",
  "Stay aligned with the user's goals, memory boundaries, and ResonantOS safety model.",
  "Use browser control, memory, and delegation through ResonantOS host-mediated capabilities instead of claiming those capabilities are unavailable.",
].join("\n");

export const DEFAULT_AUGMENTOR_CONFIG = {
  displayName: "Augmentor",
  systemPrompt: DEFAULT_AUGMENTOR_SYSTEM_PROMPT,
};

const cleanText = (value, fallback = "", maxLength = 4000) => {
  const text = String(value ?? "").replace(/\s+\n/g, "\n").trim();
  return (text || fallback).slice(0, maxLength);
};

export function normalizeUserProfile(value = {}) {
  return {
    displayName: cleanText(value.displayName, DEFAULT_USER_PROFILE.displayName, 120),
    subtitle: cleanText(value.subtitle, DEFAULT_USER_PROFILE.subtitle, 160),
    email: cleanText(value.email, "", 180),
  };
}

export function normalizeAugmentorConfig(value = {}) {
  return {
    displayName: cleanText(value.displayName, DEFAULT_AUGMENTOR_CONFIG.displayName, 80),
    systemPrompt: cleanText(value.systemPrompt, DEFAULT_AUGMENTOR_CONFIG.systemPrompt, 8000),
  };
}

export async function readPersonalizationSettings(storage, storageKeys = {}, { strict = false } = {}) {
  const profileKey = storageKeys.userProfile ?? "augmentorUserProfile";
  const configKey = storageKeys.augmentorConfig ?? "augmentorConfig";
  let result;
  try {
    if (typeof storage?.get !== "function") throw new Error("Identity storage is unavailable.");
    result = await storage.get([profileKey, configKey]);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Identity settings could not be read safely.");
    }
  } catch (error) {
    // Read-only chat hydration may use defaults; an editable form must not.
    if (strict) throw error;
    result = {};
  }
  return {
    augmentor: normalizeAugmentorConfig(result?.[configKey]),
    profile: normalizeUserProfile(result?.[profileKey]),
  };
}

export async function writePersonalizationSettings(storage, storageKeys = {}, { profile, augmentor }) {
  const profileKey = storageKeys.userProfile ?? "augmentorUserProfile";
  const configKey = storageKeys.augmentorConfig ?? "augmentorConfig";
  const next = {
    [profileKey]: normalizeUserProfile(profile),
    [configKey]: normalizeAugmentorConfig(augmentor),
  };
  if (typeof storage?.set !== "function") throw new Error("Identity storage is unavailable.");
  await storage.set(next);
  return {
    augmentor: next[configKey],
    profile: next[profileKey],
  };
}
