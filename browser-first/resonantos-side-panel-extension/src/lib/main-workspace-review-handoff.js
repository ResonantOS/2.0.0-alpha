// Intent citation: docs/architecture/ADR-027-living-archive-llm-wiki-compliance.md
// Intent citation: docs/reference/CAPABILITY_MATRIX.md

export function renderReviewQueueNotice({ container, result = {}, onOpenReviewQueue }) {
  if (!container || !result?.reviewRequestPath) return false;
  container.replaceChildren();
  container.hidden = false;
  container.dataset.kind = "review-queue";

  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = "Review queued";
  const detail = document.createElement("small");
  detail.textContent = "Open Living Archive review to draft, verify, and promote if this should become trusted AI Memory.";
  copy.append(title, detail);

  const action = document.createElement("button");
  action.type = "button";
  action.textContent = "Open Review";
  action.addEventListener("click", () => {
    if (typeof onOpenReviewQueue === "function") onOpenReviewQueue(result);
  });

  container.append(copy, action);
  return true;
}

export async function runReviewableCapture(action, { noticeContainer, onOpenReviewQueue } = {}) {
  const result = await action();
  renderReviewQueueNotice({
    container: noticeContainer,
    onOpenReviewQueue,
    result
  });
  return result;
}
