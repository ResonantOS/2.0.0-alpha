import { noteCard, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";

const defaults = {
  density: "comfortable",
  fontScale: "standard",
  motion: "full"
};

function option(value, text, selected) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  node.selected = selected;
  return node;
}

function labelledControl(label, help, control) {
  const wrapper = document.createElement("label");
  wrapper.className = "settings-appearance-control";
  const title = document.createElement("span");
  title.textContent = label;
  const detail = document.createElement("small");
  detail.textContent = help;
  wrapper.append(title, detail, control);
  return wrapper;
}

function applyAppearance(preferences = {}) {
  const next = { ...defaults, ...preferences };
  document.body.dataset.density = next.density;
  document.body.dataset.fontScale = next.fontScale;
  document.body.dataset.motion = next.motion;
  return next;
}

async function readPreferences(storage, key) {
  if (!storage || !key) return defaults;
  const result = await storage.get(key).catch(() => ({}));
  return { ...defaults, ...(result?.[key] ?? {}) };
}

export function renderAppearanceSection(container, { storage, storageKeys = {} }) {
  const key = storageKeys.appearance;
  const statusNode = document.createElement("p");
  statusNode.className = "settings-status";
  statusNode.setAttribute("role", "status");
  statusNode.textContent = "Loading appearance settings...";
  const form = document.createElement("form");
  form.className = "settings-appearance-form";

  const density = document.createElement("select");
  density.name = "density";
  density.setAttribute("aria-label", "Interface density");
  density.append(
    option("comfortable", "Comfortable", true),
    option("compact", "Compact", false),
    option("touch", "Touch friendly", false)
  );
  const fontScale = document.createElement("select");
  fontScale.name = "fontScale";
  fontScale.setAttribute("aria-label", "Font scale");
  fontScale.append(
    option("small", "Small", false),
    option("standard", "Standard", true),
    option("large", "Large", false)
  );
  const motion = document.createElement("select");
  motion.name = "motion";
  motion.setAttribute("aria-label", "Motion preference");
  motion.append(
    option("full", "Full motion", true),
    option("reduced", "Reduced motion", false)
  );
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save Appearance";
  form.append(
    labelledControl("Density", "Choose compact desktop spacing or larger touch-friendly controls.", density),
    labelledControl("Text size", "Adjust chat, navigation, and settings text without changing workflows.", fontScale),
    labelledControl("Motion", "Reduce motion when animation should be calmer or less distracting.", motion),
    save,
    statusNode
  );

  container.replaceChildren(
    settingsHeader({
      eyebrow: "Appearance and accessibility",
      title: "Interface Preferences",
      body: "Tune the workspace for desktop focus or touch-friendly use. These settings change presentation only, not agent behavior."
    }),
    noteCard({
      title: "Recommended default",
      body: "Use Comfortable + Standard + Full motion for the normal desktop experience. Switch to Touch friendly when using a touchscreen."
    }),
    form
  );

  const load = async () => {
    const preferences = applyAppearance(await readPreferences(storage, key));
    density.value = preferences.density;
    fontScale.value = preferences.fontScale;
    motion.value = preferences.motion;
    setStatus(statusNode, `Using ${preferences.density} density, ${preferences.fontScale} font scale, ${preferences.motion} motion.`, "success");
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    const preferences = {
      density: density.value,
      fontScale: fontScale.value,
      motion: motion.value
    };
    setStatus(statusNode, "Saving appearance settings...");
    try {
      if (!storage?.set || !key) {
        throw new Error("Local settings storage is unavailable.");
      }
      await storage.set({ [key]: preferences });
      applyAppearance(preferences);
      setStatus(statusNode, "Appearance settings saved.", "success");
    } catch (error) {
      setStatus(statusNode, `Appearance settings could not be saved. Your previous appearance is unchanged. Try saving again. ${safeErrorMessage(error)}`, "error");
    } finally {
      save.disabled = false;
    }
  });

  void load();
}

export const appearanceDefaults = defaults;
export const applyAppearancePreferences = applyAppearance;
