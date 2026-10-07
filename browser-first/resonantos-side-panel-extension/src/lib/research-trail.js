import { safeContextText, safeContextUrl } from "./chat-turn-controller.js";

function sourceMarkdown({ snapshot, capturedAt }, index) {
  const text = safeContextText(snapshot.text, Infinity);
  const words = text.split(/\s+/).filter(Boolean);
  const links = (snapshot.links ?? []).slice(0, 8).map((link) => {
    const href = safeContextText(safeContextUrl(link.href), Infinity);
    if (!href) return "";
    return `- [${safeContextText(link.text || href, Infinity)}](${href})`;
  }).filter(Boolean);
  return [
    `### ${index + 1}. ${safeContextText(snapshot.title || "Untitled", Infinity)}`,
    `- address: ${safeContextText(safeContextUrl(snapshot.url), Infinity)}`,
    `- captured at: ${safeContextText(capturedAt, Infinity)}`,
    `- ${words.length} words · ${(snapshot.links ?? []).length} links`,
    words.length ? `> ${words.slice(0, 60).join(" ")}` : "",
    text.slice(0, 6000),
    links.length ? `#### Source Links\n${links.join("\n")}` : ""
  ].filter(Boolean).join("\n");
}

// A blocked site is recorded by domain only; an address that cannot be parsed
// is recorded as "unknown site" rather than aborting the whole trail.
function blockedDomain(url) {
  try { return new URL(url).hostname || "unknown site"; } catch { return "unknown site"; }
}

function uncapturedMarkdown(skipped, notCaptured) {
  const lines = skipped.map(({ tab, kind, error }) => {
    if (kind === "blocked") {
      return `- Blocked by your site permission: ${safeContextText(blockedDomain(tab.url), Infinity)}`;
    }
    return `- Could not read: ${safeContextText(tab.title || "Untitled", Infinity)} — ${safeContextText(safeContextUrl(tab.url), Infinity)} — ${safeContextText(error, Infinity)}`;
  });
  for (const tab of notCaptured.overLimit) {
    lines.push(`- Over the 8-tab limit: ${safeContextText(tab.title || "Untitled", Infinity)} — ${safeContextText(safeContextUrl(tab.url), Infinity)}`);
  }
  if (notCaptured.nonWeb) lines.push(`- Non-web tabs not captured: ${notCaptured.nonWeb}`);
  return lines.length ? `\n## Skipped and not captured\n${lines.join("\n")}` : "";
}

export function buildResearchTrail({ question = "", captures = [], skipped = [], notCaptured = { overLimit: [], nonWeb: 0 } }) {
  const safeQuestion = safeContextText(question, Infinity);
  const title = safeQuestion ? `Research Trail: ${safeQuestion.slice(0, 80)}` : "Browser research trail";
  const counts = {
    captured: captures.length,
    skipped: skipped.length,
    notCaptured: notCaptured.overLimit.length + notCaptured.nonWeb
  };
  const collected = captures.length ? `collected: ${safeContextText(captures[0].capturedAt, Infinity)} · ` : "";
  const content = [
    `# ${title}`,
    `- research question: ${safeQuestion || "none given"}`,
    `- ${collected}sources captured: ${counts.captured} · skipped: ${counts.skipped} · not captured: ${counts.notCaptured}`,
    captures.length ? `\n## Sources\n${captures.map(sourceMarkdown).join("\n\n")}` : "",
    uncapturedMarkdown(skipped, notCaptured),
    "\n## Review\nRaw source material, queued for review. Nothing was written to trusted memory."
  ].filter(Boolean).join("\n");
  return { title, content, counts };
}
