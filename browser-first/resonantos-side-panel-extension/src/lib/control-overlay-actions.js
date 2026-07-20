const readingStepTypes = new Set(["forms", "inspect", "open", "read", "search", "screenshot", "switch_tab", "tabs"]);
const clickingStepTypes = new Set(["click", "scroll"]);

export function publicControlOverlayActionForStep(step = {}) {
  if (readingStepTypes.has(step?.type)) {
    return { label: "reading", phase: "reading" };
  }
  if (clickingStepTypes.has(step?.type)) {
    return { label: "clicking", phase: "clicking" };
  }
  if (step?.type === "type") {
    return { label: "typing", phase: "typing" };
  }
  if (step?.type === "wait") {
    return { label: "waiting for you", phase: "waiting" };
  }
  return { label: "working", phase: "working" };
}
