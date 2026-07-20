// Intent citation: docs/reference/CAPABILITY_MATRIX.md
// Draft connectors are provider handoffs only; they never send email or schedule events.

const SUPPORTED_HANDOFFS = {
  calendar: new Set(["google-calendar"]),
  email: new Set(["gmail"])
};

export function parseDraftPacketMarkdown(content, fallback = {}) {
  const text = String(content ?? "");
  const field = (name) => {
    const match = new RegExp(`^- ${name}:\\s*(.+)$`, "mi").exec(text);
    return match ? match[1].trim() : "";
  };
  const section = (heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`, "i").exec(text);
    return match ? match[1].trim() : "";
  };
  return {
    body: section("Draft Body"),
    id: field("id") || fallback.id || "",
    intent: section("Intent"),
    status: field("status") || fallback.status || "draft-only",
    target: field("target") || fallback.target || ""
  };
}

function assertSupportedProvider(target, provider) {
  const normalizedTarget = String(target ?? "").trim().toLowerCase();
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  if (!SUPPORTED_HANDOFFS[normalizedTarget]?.has(normalizedProvider)) {
    throw new Error(`Unsupported ${normalizedTarget || "draft"} provider handoff: ${normalizedProvider || "(none)"}.`);
  }
  return { provider: normalizedProvider, target: normalizedTarget };
}

export function buildProviderDraftHandoff(draft, provider) {
  const { provider: normalizedProvider, target } = assertSupportedProvider(draft?.target, provider);
  const intent = String(draft?.intent ?? "").trim();
  const body = String(draft?.body ?? "").trim();
  if (!intent || !body) {
    throw new Error("Provider handoff requires a draft intent and body.");
  }

  if (target === "email") {
    const params = new URLSearchParams({
      body,
      fs: "1",
      su: intent,
      view: "cm"
    });
    return {
      action: "manual-review-compose",
      boundary: "Opens a Gmail compose draft for human review. ResonantOS does not send the email.",
      provider: normalizedProvider,
      target,
      url: `https://mail.google.com/mail/?${params.toString()}`
    };
  }

  const params = new URLSearchParams({
    action: "TEMPLATE",
    details: [
      body,
      "",
      "Prepared by ResonantOS as a draft-only calendar handoff. Review details before saving."
    ].join("\n"),
    text: intent
  });
  return {
    action: "manual-review-event-template",
    boundary: "Opens a Google Calendar event template for human review. ResonantOS does not schedule the event.",
    provider: normalizedProvider,
    target,
    url: `https://calendar.google.com/calendar/render?${params.toString()}`
  };
}

export function appendProviderHandoffAudit(content, handoff, reviewer = "human") {
  const now = new Date().toISOString();
  return `${String(content ?? "").trimEnd()}\n\n## Provider Handoff\n- handedOffAt: ${now}\n- reviewer: ${String(reviewer || "human").slice(0, 80)}\n- provider: ${handoff.provider}\n- action: ${handoff.action}\n- target: ${handoff.target}\n- boundary: ${handoff.boundary}\n`;
}
