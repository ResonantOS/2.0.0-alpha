// Intent citation: docs/architecture/ADR-004-chat-rail.md
// Intent citation: docs/architecture/ADR-007-living-archive-boundaries.md
import { HARNESS_PUBLIC_ERROR_MESSAGES, type HarnessPublicErrorCode } from "../../core/contracts";
import type { AddOnManifest, ChatRunPhase, ConversationThread, ResonantShellState } from "../../core/contracts";
import type { createHarnessClient } from "../../core/harness-client";
import type { HarnessSession } from "../../core/web-transport";
import { appendAssistantMessage, threadById, updateConversationMessage } from "../../core/chat";
import { resolveMemoryProviderBroker } from "../../core/memory-provider";
import { buildArchiveContextBundle, buildChatContextSources, buildSystemMemoryContextBundle, buildTrustedChatContextGuidance } from "./archive-context";
import type { ComposerAttachment } from "./types";
import { attachmentPromptBlock } from "./utils";

type Client = ReturnType<typeof createHarnessClient>;
export type HarnessChatRuntime = {
  client: Client;
  // App-owned, ephemeral session references. No credentials or governance writes.
  sessions: Map<string, Promise<HarnessSession>>;
  active: {
    runToken: string;
    session?: HarnessSession;
    turnId?: string;
    interrupted: boolean;
    cancelRequested: boolean;
    abort: AbortController;
    interrupt: () => void;
  } | null;
};

export const createHarnessChatRuntime = (client: Client): HarnessChatRuntime => ({ client, sessions: new Map(), active: null });

function ownerIdentity(client: Client): HarnessSession | null {
  const projection = client.getSnapshot();
  const owner = projection?.slots["primary-agent"];
  return projection && owner?.addonId && owner.available
    ? { addonId: owner.addonId, generation: owner.generation, bootEpoch: projection.bootEpoch, sessionId: "" }
    : null;
}
function owns(client: Client, session: HarnessSession): boolean {
  const current = ownerIdentity(client);
  return current !== null && current.addonId === session.addonId && current.bootEpoch === session.bootEpoch && current.generation === session.generation;
}
function publicError(code: HarnessPublicErrorCode): Error {
  return Object.assign(new Error(HARNESS_PUBLIC_ERROR_MESSAGES[code]), { code });
}

async function sessionFor(runtime: HarnessChatRuntime, threadId: string): Promise<HarnessSession> {
  const owner = ownerIdentity(runtime.client);
  if (!owner) throw publicError("runtime-unavailable");
  const key = JSON.stringify([threadId, owner.bootEpoch, owner.addonId, owner.generation]);
  let pending = runtime.sessions.get(key);
  if (!pending) {
    // Drop references from previous owners/boots; never restore them from UI storage.
    for (const cached of runtime.sessions.keys()) {
      const [thread, boot, addon, generation] = JSON.parse(cached) as [string, string, string, number];
      if (thread === threadId || boot !== owner.bootEpoch || addon !== owner.addonId || generation !== owner.generation) runtime.sessions.delete(cached);
    }
    if (!owns(runtime.client, owner)) throw publicError("ownership-conflict");
    pending = runtime.client.createSession(owner.addonId).then(({ session }) => {
      // A post-create ownership change can orphan this session. The host fences
      // it by ownership generation and cleans it on removal/shutdown. A session-
      // dispose operation is Phase 2 backlog; cancel requires an active turn.
      if (!owns(runtime.client, owner) || !owns(runtime.client, session)) throw publicError("ownership-conflict");
      return session;
    });
    runtime.sessions.set(key, pending);
  }
  try { return await pending; }
  catch (error) { if (runtime.sessions.get(key) === pending) runtime.sessions.delete(key); throw error; }
}

// Cancellation always uses the host-issued registration, including a late ack.
export function cancelRegisteredHarnessTurn(runtime: HarnessChatRuntime, active: NonNullable<HarnessChatRuntime["active"]>): void {
  if (!active.session || !active.turnId || active.cancelRequested) return;
  active.cancelRequested = true;
  void runtime.client.cancel(active.session, active.turnId).catch(() => {});
}

// Explicit user choice is acknowledged by the host; provider policy/state is never consulted.
export async function selectHarnessModel(runtime: HarnessChatRuntime, threadId: string, value: string): Promise<void> {
  const separator = value.indexOf("/");
  const provider = value.slice(0, separator).trim();
  const model = value.slice(separator + 1).trim();
  if (separator < 1 || !provider || !model) throw new Error("Enter a host provider/model.");
  const session = await sessionFor(runtime, threadId);
  if (!owns(runtime.client, session)) throw new Error("Primary harness changed.");
  await runtime.client.selectModel(session, { provider, model });
  if (!owns(runtime.client, session)) throw new Error("Primary harness changed.");
}

function historyMessages(history: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!history || typeof history !== "object" || !("messages" in history) || !Array.isArray(history.messages)) {
    throw new Error("Harness history unavailable.");
  }
  return history.messages.filter((message): message is { role: "user" | "assistant"; content: string } =>
    message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
    .map(({ role, content }) => ({ role, content }));
}

export async function executeHarnessTurn(input: {
  runtime: HarnessChatRuntime;
  state: ResonantShellState;
  thread: ConversationThread;
  manifests: AddOnManifest[];
  outgoing: string;
  attachments: ComposerAttachment[];
  overrideContextPrompt?: string;
  runToken: string;
  isRunCurrent: (token: string) => boolean;
  commitReadyState: (state: ResonantShellState) => void;
  setChatRunPhase: (phase: ChatRunPhase) => void;
  setAgentActivityLabel: (label: string) => void;
  setChatNotice: (notice: string | null) => void;
}): Promise<void> {
  const { runtime, thread, runToken } = input;
  const identity = ownerIdentity(runtime.client);
  let state = input.state;
  let messageId: string | null = null;
  let text = "";
  let complete = false;
  let failed = false;
  const clone = () => JSON.parse(JSON.stringify(state)) as ResonantShellState;
  const write = (status?: "complete" | "interrupted" | "failed") => {
    if (!messageId) {
      state = appendAssistantMessage(clone(), thread.id, text);
      messageId = threadById(state, thread.id)?.messages.at(-1)?.id ?? null;
    }
    if (messageId) state = updateConversationMessage(clone(), thread.id, messageId, message => ({
      ...message, author: identity?.addonId ?? "Primary harness", content: text, status,
    }));
    input.commitReadyState(state);
  };
  const active: NonNullable<HarnessChatRuntime["active"]> = {
    runToken, interrupted: false, cancelRequested: false, abort: new AbortController(),
    interrupt: () => {
      if (complete || active.interrupted) return;
      active.interrupted = true;
      active.abort.abort();
      if (!text) text = "Response stopped before a complete reply was returned.";
      write("interrupted");
    },
  };
  runtime.active = active;
  const current = () => !active.interrupted && input.isRunCurrent(runToken) && identity !== null && owns(runtime.client, identity);
  const unsubscribe = runtime.client.subscribe(() => {
    if (!complete && !active.interrupted && input.isRunCurrent(runToken) && identity && !owns(runtime.client, identity)) {
      active.interrupt();
      cancelRegisteredHarnessTurn(runtime, active);
      input.setChatRunPhase("interrupted");
      input.setChatNotice("Primary harness changed. Partial reply kept.");
    }
  });
  try {
    active.session = await sessionFor(runtime, thread.id);
    if (!current()) return;
    const operations = runtime.client.getSnapshot()?.installations[active.session.addonId]?.supportedOperations;
    const { history } = operations && !operations.includes("history")
      ? { history: { messages: [] } }
      : await runtime.client.history(active.session);
    if (!current()) return;
    const memory = resolveMemoryProviderBroker(state, input.manifests, runtime.client.getSnapshot());
    const systemMemoryContext = await buildSystemMemoryContextBundle(memory).catch(() => null);
    if (!current()) return;
    const archiveContext = await buildArchiveContextBundle(input.outgoing, memory).catch(() => null);
    if (!current()) return;
    const contextSources = buildChatContextSources({ systemMemoryContext, compactState: null, archiveContext,
      overrideContextPrompt: input.overrideContextPrompt, threadId: thread.id, includeArchiveContext: true });
    const result = await runtime.client.turn(active.session, {
      messages: [...historyMessages(history), { role: "user", content: input.outgoing }],
      contextSources,
      runtimeContext: input.attachments.length ? attachmentPromptBlock(input.attachments) : undefined,
      systemPrompt: buildTrustedChatContextGuidance({ recoveryAgentActive: false,
        systemMemoryAvailable: systemMemoryContext !== null, compactMemoryPresent: false,
        archiveEvidencePresent: Boolean(archiveContext?.pages.length || archiveContext?.sources.length) }),
    });
    active.turnId = result.turnId;
    if (!current()) { cancelRegisteredHarnessTurn(runtime, active); return; }
    for await (const event of runtime.client.events(active.session, { signal: active.abort.signal })) {
      if (!current()) break;
      if (event.turnId !== active.turnId) continue;
      if (event.type === "delta" || event.type === "final") {
        text = event.type === "final" ? event.data.text : text + event.data.text;
        write(event.type === "final" ? "complete" : undefined);
        input.setChatRunPhase(event.type === "final" ? "completed" : "streaming");
        input.setAgentActivityLabel(event.type === "final" ? "Reply ready." : `Replying through ${active.session.addonId}.`);
        if (event.type === "final") { complete = true; break; }
      } else if (event.type === "error" || event.type === "cancelled") {
        break;
      }
    }
  } catch (error) {
    // Only the fixed host vocabulary is public; raw transport errors may contain secrets.
    if (input.isRunCurrent(runToken) && !active.interrupted) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const failure = typeof code === "string" && Object.hasOwn(HARNESS_PUBLIC_ERROR_MESSAGES, code)
        ? HARNESS_PUBLIC_ERROR_MESSAGES[code as HarnessPublicErrorCode] : null;
      if (!text) {
        failed = true;
        text = failure ?? HARNESS_PUBLIC_ERROR_MESSAGES["runtime-unavailable"];
        write("failed");
        input.setChatRunPhase("failed");
        input.setAgentActivityLabel(text);
        input.setChatNotice(text);
      } else {
        input.setChatNotice(failure ?? "Harness reply interrupted. Partial reply kept.");
      }
    }
  } finally {
    unsubscribe();
    if (!complete && !failed && !active.interrupted && input.isRunCurrent(runToken)) active.interrupt();
    if (!complete) cancelRegisteredHarnessTurn(runtime, active);
    if (!complete && !failed && input.isRunCurrent(runToken)) input.setChatRunPhase("interrupted");
    if (runtime.active === active) runtime.active = null;
  }
}
