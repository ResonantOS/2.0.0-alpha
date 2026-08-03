import { describe, expect, it } from "vitest";
import { rebaseStateOntoLatest } from "./state-concurrency";

describe("rebaseStateOntoLatest", () => {
  it("preserves unrelated settings edits made while a chat turn awaited", () => {
    const base = {
      conversationThreads: [{ id: "thread-1", title: "New chat", messages: [] }],
      providers: [{ id: "provider-1", label: "Before" }],
      uiPreferences: { activeChatThreadId: "thread-1", theme: "dark" },
    };
    const candidate = {
      ...base,
      conversationThreads: [{ id: "thread-1", title: "Renamed by chat", messages: [{ id: "m1" }] }],
      uiPreferences: { ...base.uiPreferences, activeChatThreadId: "thread-1" },
    };
    const latest = {
      ...base,
      providers: [{ id: "provider-1", label: "Edited in Settings" }],
      uiPreferences: { ...base.uiPreferences, theme: "light" },
    };

    expect(rebaseStateOntoLatest(base, candidate, latest)).toEqual({
      conversationThreads: [{ id: "thread-1", title: "Renamed by chat", messages: [{ id: "m1" }] }],
      providers: [{ id: "provider-1", label: "Edited in Settings" }],
      uiPreferences: { activeChatThreadId: "thread-1", theme: "light" },
    });
  });

  it("preserves a concurrent keyed collection addition", () => {
    const base = { conversationThreads: [{ id: "thread-1", title: "One" }] };
    const candidate = { conversationThreads: [{ id: "thread-1", title: "Updated" }] };
    const latest = {
      conversationThreads: [
        { id: "thread-1", title: "One" },
        { id: "thread-2", title: "Created while waiting" },
      ],
    };

    expect(rebaseStateOntoLatest(base, candidate, latest).conversationThreads).toEqual([
      { id: "thread-1", title: "Updated" },
      { id: "thread-2", title: "Created while waiting" },
    ]);
  });
});
