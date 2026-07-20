// TODO(dictation-local): the dictation controller below still uses the Web
// Speech API (cloud STT). The shared `src/dictation/` engine introduced for
// the React app (parakeet.js + meljs, no cloud calls) is the migration target.
//
// Migration steps (tracked separately):
//   1. Vendor parakeet.js, meljs, and onnxruntime-web into
//      `browser-first/resonantos-side-panel-extension/src/lib/vendor/` via a
//      `scripts/sync-dictation-engine.mjs` copy step wired into
//      `browser-first:install`.
//   2. Replace this `createDictationController` with an adapter that uses
//      `chrome.runtime.getURL("src/lib/vendor/parakeet.js/src/index.js")` as
//      the worker entrypoint and `assets/ort-wasm/*.wasm` for the ONNX WASM
//      blobs (already in the WAR list of `manifest.json`).
//   3. Re-run the extension's `composer-runtime.test.mjs` with a fake worker
//      that emits canned transcripts (mirror the `FakeWorker` class in
//      `src/dictation/__tests__/controller.test.ts`).
//   4. Update the `createDictationController` greps in
//      `browser-first/test/browser-first-contract.test.mjs`.

const DEFAULT_MODEL_LABELS = {
  "__auto__": "Auto route",
  "MiniMax-M3": "MiniMax M3",
  "zai/glm-5.2": "Z.AI GLM 5.2",
  "gpt-5.5": "GPT 5.5",
  "gpt-5.4-mini": "GPT 5.4 Mini",
  "batiai/gemma4-e2b:q4": "Gemma 4 2B"
};

const MODEL_CONTEXT_WINDOWS = {
  "MiniMax-M3": 1_000_000,
  "zai/glm-5.2": 195_000,
  "gpt-5.5": 128_000,
  "gpt-5.4-mini": 128_000,
  "batiai/gemma4-e2b:q4": 8_000,
  "Qwen3.6-35B-A3B-Q4_K_M.gguf": 128_000
};

export function modelLabel(model, labels = DEFAULT_MODEL_LABELS) {
  return labels[model] ?? model;
}

export function supportsThinkingDepth(model) {
  return String(model ?? "").startsWith("gpt-5.");
}

function providerModelEntries(providerStatus) {
  return (providerStatus?.providers ?? [])
    .flatMap((provider) => (provider.models ?? [])
      .filter((model) => model.allowed !== false)
      .map((model) => ({
        model: String(model.model ?? "").trim(),
        label: String(model.label ?? model.model ?? "").trim(),
        providerId: provider.id,
        providerLabel: provider.label,
        configured: Boolean(provider.configured),
        runtime: model.runtime,
        costTier: model.costTier,
        qualityTier: model.qualityTier
      })))
    .filter((entry) => entry.model);
}

export async function hydrateProviderModelOptions({ bridgeRequest, getBridgeRequest, modelSelect, getPreferredModel = () => "__auto__", setStatus = () => undefined }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const preferred = getPreferredModel() || modelSelect.value || "__auto__";
  const fallbackOptions = [...modelSelect.options].map((option) => ({
    model: option.value,
    label: option.textContent || option.value
  }));
  try {
    const status = await bridge()("/providers/status", { method: "GET" });
    const entries = providerModelEntries(status);
    const byModel = new Map();
    for (const entry of entries) {
      if (!byModel.has(entry.model) || (!byModel.get(entry.model).configured && entry.configured)) {
        byModel.set(entry.model, entry);
      }
    }
    const options = [
      { model: "__auto__", label: "Auto route", configured: true },
      ...[...byModel.values()]
    ];
    modelSelect.replaceChildren();
    for (const optionEntry of options) {
      const option = document.createElement("option");
      option.value = optionEntry.model;
      option.textContent = optionEntry.model === "__auto__"
        ? optionEntry.label
        : `${optionEntry.label || optionEntry.model}${optionEntry.providerLabel ? ` · ${optionEntry.providerLabel}` : ""}${optionEntry.configured ? "" : " · missing credential"}`;
      option.dataset.providerId = optionEntry.providerId ?? "";
      option.dataset.configured = optionEntry.configured ? "true" : "false";
      modelSelect.append(option);
    }
    modelSelect.value = [...modelSelect.options].some((option) => option.value === preferred) ? preferred : "__auto__";
    setStatus(`Loaded ${Math.max(0, options.length - 1)} provider model route${options.length === 2 ? "" : "s"}`);
    return { ok: true, options };
  } catch (error) {
    modelSelect.replaceChildren();
    for (const optionEntry of fallbackOptions) {
      const option = document.createElement("option");
      option.value = optionEntry.model;
      option.textContent = optionEntry.label;
      modelSelect.append(option);
    }
    modelSelect.value = [...modelSelect.options].some((option) => option.value === preferred) ? preferred : "__auto__";
    setStatus(`Provider model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, error };
  }
}

function estimateTextTokens(value) {
  const text = String(value ?? "");
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function contextUsageSnapshot({ attachments = [], messages = [], model = "__auto__", pageSnapshot = null } = {}) {
  const messageTokens = messages.reduce((total, message) => total + estimateTextTokens(message.content) + 8, 0);
  const attachmentTokens = attachments.reduce((total, attachment) =>
    total + estimateTextTokens(attachment.content ?? attachment.summary ?? attachment.name) + 8, 0);
  const pageTokens = estimateTextTokens(pageSnapshot?.text) + estimateTextTokens(pageSnapshot?.title) + estimateTextTokens(pageSnapshot?.url);
  const usedTokens = messageTokens + attachmentTokens + pageTokens;
  const contextWindow = MODEL_CONTEXT_WINDOWS[model] ?? 64_000;
  const ratio = Math.min(0.99, usedTokens / contextWindow);
  const percent = Math.round(ratio * 100);
  return {
    attachmentTokens,
    contextWindow,
    messageTokens,
    pageTokens,
    percent,
    ratio,
    title: [
      `Estimated context usage: ${percent}%`,
      `Model route: ${model === "__auto__" ? "Auto route" : model}`,
      `Estimated tokens: ${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()}`,
      "This is a deterministic estimate for conversation, attachments, and captured page context. It is used to decide when compaction or a larger-context model is needed."
    ].join("\n"),
    usedTokens
  };
}

export function updateContextMeterElement(contextMeter, snapshot) {
  if (!contextMeter || !snapshot) return;
  contextMeter.style.setProperty("--context-used", `${snapshot.percent}%`);
  contextMeter.querySelector(".context-meter-label").textContent = `${snapshot.percent}%`;
  contextMeter.title = snapshot.title;
  contextMeter.setAttribute("aria-label", `Context usage ${snapshot.percent} percent`);
}

function formatTokenCount(value) {
  const count = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function contextFlowStep(doc, label, active = false) {
  const item = doc.createElement("span");
  item.className = active ? "active" : "";
  item.textContent = label;
  return item;
}

function contextMemoryCard(doc, label, value, tone = "neutral") {
  const card = doc.createElement("article");
  card.className = `context-memory-card ${tone}`;
  const caption = doc.createElement("span");
  caption.textContent = label;
  const strong = doc.createElement("strong");
  strong.textContent = value;
  card.append(caption, strong);
  return card;
}

export function renderContextMemoryPopover(popover, snapshot, { notice = "", onClose = () => undefined, onCompact = () => undefined } = {}) {
  if (!popover || !snapshot) return;
  const doc = popover.ownerDocument ?? globalThis.document;
  const usable = Math.max(1, snapshot.contextWindow);
  const usedWidth = `${Math.min(100, Math.round((snapshot.usedTokens / usable) * 100))}%`;
  const compactWidth = "72%";
  const hardStopWidth = "88%";

  const head = doc.createElement("div");
  head.className = "context-memory-head";
  const title = doc.createElement("div");
  const titleLabel = doc.createElement("span");
  titleLabel.textContent = "Context map";
  const titleValue = doc.createElement("strong");
  titleValue.textContent = `${snapshot.percent}%`;
  title.append(titleLabel, titleValue);
  const actions = doc.createElement("div");
  actions.className = "context-memory-actions";
  const compact = doc.createElement("button");
  compact.type = "button";
  compact.textContent = "Compact now";
  compact.addEventListener("click", onCompact);
  const close = doc.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", onClose);
  actions.append(compact, close);
  head.append(title, actions);

  const location = doc.createElement("p");
  location.className = "context-memory-location";
  location.textContent = "This changes the context view only. Raw chat transcript stays intact.";

  const noticeNode = doc.createElement("div");
  noticeNode.className = "inline-notice warning";
  noticeNode.textContent = notice;
  noticeNode.hidden = !notice;

  const meter = doc.createElement("div");
  meter.className = "context-memory-meter";
  meter.title = snapshot.title;
  const track = doc.createElement("div");
  track.className = "context-memory-meter-track";
  const used = doc.createElement("span");
  used.className = "context-memory-meter-used";
  used.style.width = usedWidth;
  const compactThreshold = doc.createElement("span");
  compactThreshold.className = "context-memory-meter-threshold compact";
  compactThreshold.style.left = compactWidth;
  const hardThreshold = doc.createElement("span");
  hardThreshold.className = "context-memory-meter-threshold hard";
  hardThreshold.style.left = hardStopWidth;
  track.append(used, compactThreshold, hardThreshold);
  const labels = doc.createElement("div");
  labels.className = "context-memory-meter-labels";
  const usedLabel = doc.createElement("span");
  usedLabel.textContent = `${formatTokenCount(snapshot.usedTokens)} used`;
  const usableLabel = doc.createElement("span");
  usableLabel.textContent = `${formatTokenCount(snapshot.contextWindow)} usable`;
  labels.append(usedLabel, usableLabel);
  meter.append(track, labels);

  const flow = doc.createElement("div");
  flow.className = "context-memory-flow";
  flow.setAttribute("aria-label", "Prompt memory layers");
  flow.append(
    contextFlowStep(doc, "Raw transcript", true),
    contextFlowStep(doc, "Compact memory", snapshot.percent >= 72),
    contextFlowStep(doc, "Recent turns", true),
    contextFlowStep(doc, "Page context", snapshot.pageTokens > 0),
    contextFlowStep(doc, "Response reserve")
  );

  const grid = doc.createElement("div");
  grid.className = "context-memory-grid";
  grid.append(
    contextMemoryCard(doc, "Messages", `${formatTokenCount(snapshot.messageTokens)} tokens`, "primary"),
    contextMemoryCard(doc, "Attachments", `${formatTokenCount(snapshot.attachmentTokens)} tokens`, "neutral"),
    contextMemoryCard(doc, "Page context", `${formatTokenCount(snapshot.pageTokens)} tokens`, snapshot.pageTokens > 0 ? "primary" : "neutral"),
    contextMemoryCard(doc, "Reserve", `${formatTokenCount(Math.max(0, snapshot.contextWindow - snapshot.usedTokens))} tokens`, "neutral")
  );

  const foot = doc.createElement("div");
  foot.className = "context-memory-foot";
  const range = doc.createElement("span");
  range.textContent = snapshot.percent >= 72
    ? "Compaction threshold reached or approaching."
    : "Context is within the safe operating range.";
  const note = doc.createElement("span");
  note.textContent = "Use Compact now before old turns leave the prompt.";
  foot.append(range, note);

  popover.replaceChildren(head, location, noticeNode, meter, flow, grid, foot);
}

function speechRecognitionConstructor(win = globalThis.window) {
  if (!win) return null;
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

async function diagnoseMicrophoneAccess(navigatorRef = globalThis.navigator) {
  if (!navigatorRef.mediaDevices?.getUserMedia) {
    return "Microphone capture is not available in this browser runtime.";
  }
  try {
    const stream = await navigatorRef.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return "Speech recognition was denied after microphone capture was granted. Restart ResonantOS, then check macOS microphone privacy if it still fails.";
  } catch (error) {
    const name = error?.name ?? "";
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No microphone input device was found. Connect or enable a microphone, then try dictation again.";
    }
    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
      return "Microphone permission is denied by the browser or operating system. Enable microphone access for ResonantOS Browser, then try again.";
    }
    return `Microphone access check failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function createDictationController({
  button,
  commandInput,
  setStatus = () => undefined,
  setNotice = null,
  addMessage = async () => undefined,
  onTranscript = () => undefined,
  navigatorRef = globalThis.navigator,
  windowRef = globalThis.window
}) {
  let recognition = null;
  let dictating = false;

  function setDictating(next) {
    dictating = Boolean(next);
    button.classList.toggle("is-live", dictating);
    button.classList.toggle("muted", !canUseDictation());
    button.title = dictating
      ? "Stop dictation"
      : canUseDictation()
        ? "Start voice dictation"
        : "Voice dictation is not available in this browser runtime.";
    button.setAttribute("aria-label", dictating ? "Stop dictation" : "Start voice dictation");
    button.setAttribute("aria-pressed", dictating ? "true" : "false");
  }

  function canUseDictation() {
    return Boolean(speechRecognitionConstructor(windowRef));
  }

  function appendTranscript(text) {
    const value = String(text ?? "").trim();
    if (!value) return;
    const prefix = commandInput.value.trim() ? " " : "";
    commandInput.value = `${commandInput.value}${prefix}${value}`.trim();
    commandInput.dispatchEvent(new Event("input", { bubbles: true }));
    setNotice?.("");
    onTranscript(value);
  }

  async function reportDictationNotice(message) {
    if (typeof setNotice === "function") {
      setNotice(message);
      return;
    }
    await addMessage("system", message);
  }

  async function start() {
    const Recognition = speechRecognitionConstructor(windowRef);
    if (!Recognition) {
      await reportDictationNotice("Voice dictation is not available in this browser runtime.");
      setStatus("Dictation unavailable");
      setDictating(false);
      return;
    }
    try {
      recognition = new Recognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.onresult = (event) => {
        const transcript = Array.from(event.results ?? [])
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();
        appendTranscript(transcript);
      };
      recognition.onerror = async (event) => {
        setStatus("Dictation failed");
        const reason = event.error === "not-allowed"
          ? await diagnoseMicrophoneAccess(navigatorRef)
          : event.error || "unknown error";
        await reportDictationNotice(`Voice dictation failed: ${reason}`);
        setDictating(false);
      };
      recognition.onend = () => {
        setDictating(false);
        setStatus("Ready");
      };
      setDictating(true);
      setStatus("Listening");
      setNotice?.("");
      recognition.start();
    } catch (error) {
      setStatus("Dictation failed");
      await reportDictationNotice(`Voice dictation failed: ${error instanceof Error ? error.message : String(error)}`);
      setDictating(false);
    }
  }

  function stop() {
    recognition?.stop?.();
    setDictating(false);
    setStatus("Ready");
  }

  function toggle() {
    if (dictating) {
      stop();
      return;
    }
    void start();
  }

  setDictating(false);

  return {
    canUseDictation,
    start,
    stop,
    toggle
  };
}
