import { describe, expect, it, vi } from "vitest";
import { buildDefaultState } from "../../core/defaults";
import { createHarnessClient } from "../../core/harness-client";
import { executeHarnessTurn, createHarnessChatRuntime } from "./harness-turn";
import type { HarnessEvent } from "../../core/contracts";
import { stopChatGenerationAction } from "./thread-controller";

vi.mock("../../core/runtime", () => ({ abortProviderServiceChatCompletion: vi.fn() }));
import { abortProviderServiceChatCompletion } from "../../core/runtime";

vi.mock("./archive-context", async original => ({
  ...await original<typeof import("./archive-context")>(),
  buildSystemMemoryContextBundle: vi.fn().mockResolvedValue(null),
  buildArchiveContextBundle: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../core/memory-provider", () => ({ resolveMemoryProviderBroker: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("harness Stop", () => {
  it("Stop cancels the registered harness turn", async () => {
    let state = buildDefaultState([]);
    const thread = state.conversationThreads[0];
    const session = { addonId: "addon.dsh", sessionId: "registered-session", bootEpoch: "boot", generation: 4 };
    const partial = deferred();
    const release = deferred();
    const rejected: string[] = [];
    const invoke = vi.fn(async (command: string) => {
      if (command === "harness_session") return { session };
      if (command === "harness_history") return { history: { messages: [] } };
      if (command === "harness_turn") return { turnId: "registered-turn" };
      return {};
    });
    const frame = (text: string, sequence: number): HarnessEvent => ({
      ...session, turnId: "registered-turn", sequence, type: "delta", data: { text },
    });
    const client = createHarnessClient({ invoke: invoke as never, events: async function* () {
      // Reject a previous ownership generation even while this turn is active.
      rejected.push("older generation");
      yield { ...frame("Stale generation", 1), generation: session.generation - 1 };
      yield frame("Partial answer", 2);
      partial.resolve();
      await release.promise;
      rejected.push("late chunk");
      yield frame("Late answer", 3);
      rejected.push("late older generation");
      yield { ...frame("Late stale generation", 4), generation: session.generation - 1 };
    } });
    client.applySnapshot({ bootEpoch: "boot", revision: 1, governanceActivated: true, candidates: [], installations: {},
      slots: { "primary-agent": { addonId: session.addonId, generation: session.generation, available: true } } });
    const harnessRuntime = createHarnessChatRuntime(client);
    const tokenRef = { current: "registered-run" as string | null };
    const commits: string[] = [];
    const running = executeHarnessTurn({ runtime: harnessRuntime, state, thread, manifests: [], outgoing: "Question",
      attachments: [], runToken: "registered-run", isRunCurrent: token => tokenRef.current === token,
      commitReadyState: next => { state = next; commits.push(JSON.stringify(next)); },
      setChatRunPhase: vi.fn(), setAgentActivityLabel: vi.fn(), setChatNotice: vi.fn() });
    await partial.promise;
    const active = harnessRuntime.active!;
    const interrupt = vi.spyOn(active, "interrupt");
    const last = () => state.conversationThreads.find(item => item.id === thread.id)!.messages.at(-1)!;
    expect(last().content).toBe("Partial answer");
    stopChatGenerationAction({ chatBusy: true, activeThread: thread, activeChatRunTokenRef: tokenRef,
      harnessRuntime, updateRuntimeState: vi.fn(), setChatBusy: vi.fn(), setChatRunPhase: vi.fn(),
      setAgentActivityLabel: vi.fn(), setChatNotice: vi.fn() });
    expect(invoke).toHaveBeenCalledWith("harness_cancel", { session, turnId: "registered-turn" });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(active.interrupted).toBe(true);
    expect(active.abort.signal.aborted).toBe(true);
    expect(tokenRef.current).toBeNull();
    expect(abortProviderServiceChatCompletion).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ content: "Partial answer", status: "interrupted" });
    release.resolve();
    await running;
    expect(last()).toMatchObject({ content: "Partial answer", status: "interrupted" });
    expect(rejected).toContain("older generation");
    expect(rejected).toContain("late chunk");
    expect(commits.join(" ")).not.toMatch(/Stale generation|Late answer|Late stale generation/);
  });
});
