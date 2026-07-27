// Decide whether a chrome.storage change should trigger a cross-surface chat
// re-sync. Both the sidecar and the main workspace read/write the same chat
// keys, so each surface re-hydrates and re-renders when the OTHER writes — but
// must ignore its own writes (which also fire storage events) to avoid a
// flicker/loop. Every chat write stamps a `writer` token of the form
// "<instanceId>:<seq>"; a change whose writer prefix is ours is skipped.

export function shouldSyncChatChange(changes, { keys = [], writerKey = "", instanceId = "" } = {}) {
  if (!changes || typeof changes !== "object") return false;
  const writerValue = writerKey ? changes[writerKey]?.newValue : undefined;
  if (typeof writerValue === "string" && writerValue.split(":")[0] === instanceId) {
    return false; // our own write
  }
  return keys.some((key) => Boolean(changes[key]));
}
