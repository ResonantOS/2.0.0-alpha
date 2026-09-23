// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// UX citation: docs/architecture/ADR-004-chat-rail.md

import type { MutableRefObject } from "react";
import type {
  ChatRunPhase,
  ContextMemoryState,
  ConversationMessage,
  ConversationThread,
  ResonantShellState,
} from "../../core/contracts";
import {
  appendTranscriptEvent,
  branchTranscriptPayload,
  compactThreadContext,
  copyCompactStatesForFork,
  messageTranscriptPayload,
} from "../../core/context-memory";
import { abortProviderServiceChatCompletion } from "../../core/runtime";
import { activateChatThread } from "../strategist/controller";
import { cancelRegisteredHarnessTurn, type HarnessChatRuntime } from "./harness-turn";
import type { ComposerAttachment } from "./types";

type RuntimeStateUpdater = (updater: (current: ResonantShellState) => ResonantShellState) => void;
type SetComposer = (value: string) => void;
type SetAttachments = (value: ComposerAttachment[]) => void;
type SetNotice = (value: string | null) => void;

export type CompactMemoryPatch = {
  compactedAt: string;
  userIntent: Pick<ContextMemoryState["userIntent"], "goal" | "why" | "successCriteria" | "prioritySignals">;
  workingSummary: string;
  facts: string[];
  decisions: string[];
  preferences: string[];
  openTasks: string[];
};

const nowIso = (): string => new Date().toISOString();

export function branchChatFromMessageAction({
  activeThread,
  message,
  updateRuntimeState,
  setComposer,
  setAttachments,
  setChatNotice,
}: {
  activeThread: ConversationThread | null;
  message: ConversationMessage;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setAttachments: SetAttachments;
  setChatNotice: SetNotice;
}): void {
  if (!activeThread || message.threadId !== activeThread.id) {
    return;
  }

  updateRuntimeState((draft) => {
    const sourceThread = draft.conversationThreads.find((thread) => thread.id === activeThread.id);
    if (!sourceThread) {
      return draft;
    }

    const messageIndex = sourceThread.messages.findIndex((item) => item.id === message.id);
    if (messageIndex < 0) {
      return draft;
    }

    const forkId = `thread-fork-${Date.now()}`;
    const forkedMessages = sourceThread.messages.slice(0, messageIndex + 1).map((item) => ({
      ...item,
      threadId: forkId,
    }));
    const forkThread = {
      ...sourceThread,
      id: forkId,
      title: `${sourceThread.title} fork`,
      summary: `Forked after ${message.author}'s message.`,
      messages: forkedMessages,
    };
    draft.conversationThreads.push(forkThread);
    draft.contextMemoryStates = copyCompactStatesForFork(
      draft.contextMemoryStates ?? [],
      sourceThread.id,
      forkThread,
      message.id,
    );
    draft.uiPreferences.activeChatThreadId = forkId;
    return appendTranscriptEvent(draft, {
      action: "thread-branched",
      threadId: forkId,
      channelId: forkThread.channelId,
      agentId: forkThread.owningAgentId,
      sourceThreadId: sourceThread.id,
      sourceMessageId: message.id,
      payload: branchTranscriptPayload(sourceThread, forkThread, message.id),
    });
  });
  setComposer("");
  setAttachments([]);
  setChatNotice("Branched this conversation into a new chat.");
}

export function editUserMessageAction({
  activeThread,
  message,
  updateRuntimeState,
  setComposer,
  setChatNotice,
}: {
  activeThread: ConversationThread | null;
  message: ConversationMessage;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setChatNotice: SetNotice;
}): void {
  if (message.role !== "user") {
    return;
  }

  setComposer(message.content);
  updateRuntimeState((draft) =>
    appendTranscriptEvent(draft, {
      action: "message-edit-requested",
      threadId: message.threadId,
      channelId: message.channelId,
      messageId: message.id,
      role: message.role,
      agentId: activeThread?.owningAgentId,
      payload: messageTranscriptPayload(message),
    }),
  );
  setChatNotice("Message loaded into the composer. Edit and send when ready.");
}

export function deleteChatMessageAction({
  message,
  updateRuntimeState,
  setChatNotice,
}: {
  message: ConversationMessage;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  updateRuntimeState((draft) => {
    const targetThread = draft.conversationThreads.find((thread) => thread.id === message.threadId);
    if (!targetThread) {
      return draft;
    }

    targetThread.messages = targetThread.messages.filter((item) => item.id !== message.id);
    return appendTranscriptEvent(draft, {
      action: "message-deleted",
      threadId: message.threadId,
      channelId: message.channelId,
      messageId: message.id,
      role: message.role,
      agentId: targetThread.owningAgentId,
      payload: messageTranscriptPayload(message),
    });
  });
  setChatNotice("Message deleted from this chat.");
}

export function togglePinnedChatThreadAction({
  threadId,
  updateRuntimeState,
}: {
  threadId: string;
  updateRuntimeState: RuntimeStateUpdater;
}): void {
  updateRuntimeState((draft) => {
    const pinned = new Set(draft.uiPreferences.pinnedChatThreadIds ?? []);
    if (pinned.has(threadId)) {
      pinned.delete(threadId);
    } else {
      pinned.add(threadId);
    }
    draft.uiPreferences.pinnedChatThreadIds = Array.from(pinned);
    return draft;
  });
}

export function renameChatThreadAction({
  threadId,
  title,
  updateRuntimeState,
  setChatNotice,
}: {
  threadId: string;
  title: string;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  const trimmed = title.trim();
  if (!trimmed) {
    return;
  }

  updateRuntimeState((draft) => {
    const thread = draft.conversationThreads.find((item) => item.id === threadId);
    if (thread) {
      thread.title = trimmed;
      thread.summary = thread.summary || trimmed;
    }
    return draft;
  });
  setChatNotice("Chat renamed.");
}

export function branchChatThreadAction({
  threadId,
  updateRuntimeState,
  setComposer,
  setAttachments,
  setChatNotice,
}: {
  threadId: string;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setAttachments: SetAttachments;
  setChatNotice: SetNotice;
}): void {
  updateRuntimeState((draft) => {
    const sourceThread = draft.conversationThreads.find((thread) => thread.id === threadId);
    if (!sourceThread) {
      return draft;
    }

    const forkId = `thread-fork-${Date.now()}`;
    const forkThread = {
      ...sourceThread,
      id: forkId,
      title: `${sourceThread.title} fork`,
      summary: `Forked from ${sourceThread.title}.`,
      messages: sourceThread.messages.map((message) => ({
        ...message,
        id: `${forkId}:${message.id.split(":").at(-1) ?? "m"}`,
        threadId: forkId,
      })),
    };
    draft.conversationThreads.unshift(forkThread);
    draft.contextMemoryStates = copyCompactStatesForFork(draft.contextMemoryStates ?? [], sourceThread.id, forkThread);
    draft.uiPreferences.activeChatThreadId = forkId;
    draft.uiPreferences.pinnedChatThreadIds = (draft.uiPreferences.pinnedChatThreadIds ?? []).filter((id) => id !== forkId);
    return appendTranscriptEvent(draft, {
      action: "thread-branched",
      threadId: forkId,
      channelId: forkThread.channelId,
      agentId: forkThread.owningAgentId,
      sourceThreadId: sourceThread.id,
      payload: branchTranscriptPayload(sourceThread, forkThread),
    });
  });
  setComposer("");
  setAttachments([]);
  setChatNotice("Chat branched into a new thread.");
}

export function createChatProjectAction({
  title,
  updateRuntimeState,
  setChatNotice,
}: {
  title: string;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  const trimmed = title.trim();
  if (!trimmed) {
    return;
  }

  const projectId = `chat-project-${Date.now()}`;
  updateRuntimeState((draft) => {
    draft.chatProjects = [
      ...(draft.chatProjects ?? []),
      {
        id: projectId,
        title: trimmed,
        pinned: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    ];
    return draft;
  });
  setChatNotice("Project created. Use its + button to create a chat inside it, or move existing chats from their menu.");
}

export function createAgentChatThreadAction({
  agentId,
  projectId,
  state,
  updateRuntimeState,
  setComposer,
  setAttachments,
  setChatNotice,
}: {
  agentId: string;
  projectId?: string;
  state: ResonantShellState;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setAttachments: SetAttachments;
  setChatNotice: SetNotice;
}): void {
  const agent = state.agents.find((item) => item.id === agentId);
  const channel =
    state.channels.find((item) => item.owningAgentId === agentId && item.enabled) ??
    state.channels.find((item) => item.owningAgentId === agentId) ??
    null;

  if (!agent || !channel) {
    setChatNotice("That agent is not available yet. Install or enable its channel first.");
    return;
  }

  const threadId = `thread-${agentId.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
  const existingThreads = state.conversationThreads.filter((thread) => thread.owningAgentId === agentId).length;
  const title = `New ${agent.displayName} chat ${existingThreads + 1}`;
  const thread: ConversationThread = {
    id: threadId,
    title,
    owningAgentId: agentId,
    workspaceId: channel.workspaceId,
    channelId: channel.id,
    summary: `Fresh ${agent.displayName} workspace.`,
    projectId,
    messages: [],
  };

  updateRuntimeState((draft) => {
    const nextState = appendTranscriptEvent(draft, {
      action: "thread-created",
      threadId,
      channelId: channel.id,
      agentId,
      payload: {
        title,
        workspaceId: channel.workspaceId,
        projectId,
      },
    });
    nextState.conversationThreads = [thread, ...nextState.conversationThreads];
    nextState.uiPreferences.activeChatThreadId = threadId;
    nextState.uiPreferences.chatSidebarOpen = true;
    if (projectId) {
      const project = (nextState.chatProjects ?? []).find((item) => item.id === projectId);
      if (project) {
        project.updatedAt = nowIso();
      }
    }
    return nextState;
  });
  setComposer("");
  setAttachments([]);
  setChatNotice(null);
}

export function moveChatThreadToProjectAction({
  threadId,
  projectId,
  updateRuntimeState,
  setChatNotice,
}: {
  threadId: string;
  projectId: string | null;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  updateRuntimeState((draft) => {
    const thread = draft.conversationThreads.find((item) => item.id === threadId);
    if (thread) {
      thread.projectId = projectId ?? undefined;
    }
    if (projectId) {
      const project = (draft.chatProjects ?? []).find((item) => item.id === projectId);
      if (project) {
        project.updatedAt = nowIso();
      }
    }
    return draft;
  });
  setChatNotice(projectId ? "Chat moved into project." : "Chat moved back to Chats.");
}

export function renameChatProjectAction({
  projectId,
  title,
  updateRuntimeState,
  setChatNotice,
}: {
  projectId: string;
  title: string;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  const trimmed = title.trim();
  if (!trimmed) {
    return;
  }

  updateRuntimeState((draft) => {
    const project = (draft.chatProjects ?? []).find((item) => item.id === projectId);
    if (project) {
      project.title = trimmed;
      project.updatedAt = nowIso();
    }
    return draft;
  });
  setChatNotice("Project renamed.");
}

export function togglePinnedChatProjectAction({
  projectId,
  updateRuntimeState,
}: {
  projectId: string;
  updateRuntimeState: RuntimeStateUpdater;
}): void {
  updateRuntimeState((draft) => {
    const pinned = new Set(draft.uiPreferences.pinnedChatProjectIds ?? []);
    if (pinned.has(projectId)) {
      pinned.delete(projectId);
    } else {
      pinned.add(projectId);
    }
    draft.uiPreferences.pinnedChatProjectIds = Array.from(pinned);
    draft.chatProjects = (draft.chatProjects ?? []).map((project) =>
      project.id === projectId ? { ...project, pinned: pinned.has(projectId), updatedAt: nowIso() } : project,
    );
    return draft;
  });
}

export function branchChatProjectAction({
  projectId,
  updateRuntimeState,
  setChatNotice,
}: {
  projectId: string;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  updateRuntimeState((draft) => {
    const sourceProject = (draft.chatProjects ?? []).find((project) => project.id === projectId);
    if (!sourceProject) {
      return draft;
    }

    const forkProjectId = `chat-project-fork-${Date.now()}`;
    const sourceThreads = draft.conversationThreads.filter((thread) => thread.projectId === projectId);
    const forkThreads = sourceThreads.map((thread, index) => {
      const forkThreadId = `${forkProjectId}-thread-${index + 1}`;
      return {
        ...thread,
        id: forkThreadId,
        title: `${thread.title} fork`,
        summary: `Forked from ${thread.title}.`,
        projectId: forkProjectId,
        messages: thread.messages.map((message) => ({
          ...message,
          id: `${forkThreadId}:${message.id.split(":").at(-1) ?? "m"}`,
          threadId: forkThreadId,
        })),
      };
    });

    draft.chatProjects = [
      ...(draft.chatProjects ?? []),
      {
        id: forkProjectId,
        title: `${sourceProject.title} fork`,
        pinned: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    ];
    draft.conversationThreads = [...forkThreads, ...draft.conversationThreads];
    if (forkThreads[0]) {
      draft.uiPreferences.activeChatThreadId = forkThreads[0].id;
    }
    return draft;
  });
  setChatNotice("Project branched into a new project.");
}

export function deleteChatProjectAction({
  projectId,
  updateRuntimeState,
  setChatNotice,
}: {
  projectId: string;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  updateRuntimeState((draft) => {
    draft.chatProjects = (draft.chatProjects ?? []).filter((project) => project.id !== projectId);
    draft.uiPreferences.pinnedChatProjectIds = (draft.uiPreferences.pinnedChatProjectIds ?? []).filter((id) => id !== projectId);
    draft.conversationThreads = draft.conversationThreads.map((thread) =>
      thread.projectId === projectId ? { ...thread, projectId: undefined } : thread,
    );
    return draft;
  });
  setChatNotice("Project deleted. Its chats were moved back to Chats.");
}

export function deleteChatThreadAction({
  activeThread,
  threadId,
  updateRuntimeState,
  setComposer,
  setAttachments,
  setChatNotice,
}: {
  activeThread: ConversationThread | null;
  threadId: string;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setAttachments: SetAttachments;
  setChatNotice: SetNotice;
}): void {
  updateRuntimeState((draft) => {
    if (draft.conversationThreads.length <= 1) {
      return draft;
    }

    const remainingThreads = draft.conversationThreads.filter((thread) => thread.id !== threadId);
    if (remainingThreads.length === draft.conversationThreads.length) {
      return draft;
    }

    draft.conversationThreads = remainingThreads;
    draft.uiPreferences.pinnedChatThreadIds = (draft.uiPreferences.pinnedChatThreadIds ?? []).filter((id) => id !== threadId);
    if (draft.uiPreferences.activeChatThreadId === threadId) {
      const sameAgentThread = remainingThreads.find((thread) => thread.owningAgentId === activeThread?.owningAgentId);
      draft.uiPreferences.activeChatThreadId = sameAgentThread?.id ?? remainingThreads[0]?.id ?? "";
    }
    return draft;
  });
  setComposer("");
  setAttachments([]);
  setChatNotice("Chat deleted.");
}

export function compactActiveChatContextAction({
  activeThread,
  updateRuntimeState,
  setChatNotice,
}: {
  activeThread: ConversationThread | null;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  if (!activeThread) {
    setChatNotice("No active chat is available to compact.");
    return;
  }

  let preservedSummary = "";
  updateRuntimeState((draft) => {
    const nextState = compactThreadContext(draft, activeThread.id);
    const compactState = nextState.contextMemoryStates.at(-1);
    if (compactState?.threadId === activeThread.id) {
      preservedSummary = [
        `${compactState.preservedRecentMessageIds.length} recent message${compactState.preservedRecentMessageIds.length === 1 ? "" : "s"}`,
        `${compactState.decisions.length} decision${compactState.decisions.length === 1 ? "" : "s"}`,
        `${compactState.openTasks.length} task${compactState.openTasks.length === 1 ? "" : "s"}`,
        `${compactState.preferences.length} preference${compactState.preferences.length === 1 ? "" : "s"}`,
        `${compactState.artifacts.length} artifact${compactState.artifacts.length === 1 ? "" : "s"}`,
      ].join(", ");
    }
    return nextState;
  });
  setChatNotice(
    preservedSummary
      ? `Context compacted. Preserved ${preservedSummary}, plus user intent and rationale.`
      : "Context compaction did not run because this thread was not found.",
  );
}

export function updateCompactMemoryAction({
  activeThread,
  patch,
  updateRuntimeState,
  setChatNotice,
}: {
  activeThread: ConversationThread | null;
  patch: CompactMemoryPatch;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  if (!activeThread) {
    setChatNotice("No active chat is available for memory editing.");
    return;
  }

  let updated = false;
  updateRuntimeState((draft) => {
    const memoryIndex = [...(draft.contextMemoryStates ?? [])]
      .map((state, index) => ({ state, index }))
      .reverse()
      .find(({ state }) => state.threadId === activeThread.id && state.compactedAt === patch.compactedAt)?.index;
    if (typeof memoryIndex !== "number") {
      return draft;
    }

    const current = draft.contextMemoryStates[memoryIndex];
    const firstSourceId = current.userIntent.sourceMessageIds[0] ?? current.sourceRange.fromMessageId;
    const mapStatements = <T extends { sourceMessageIds: string[] }>(
      values: string[],
      existing: T[],
      create: (statement: string, index: number, sourceMessageIds: string[]) => T,
    ): T[] =>
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value, index) => ({
          ...(existing[index] ?? create(value, index, [firstSourceId])),
          ...create(value, index, existing[index]?.sourceMessageIds ?? [firstSourceId]),
        }));

    draft.contextMemoryStates[memoryIndex] = {
      ...current,
      userIntent: {
        ...current.userIntent,
        goal: patch.userIntent.goal.trim() || current.userIntent.goal,
        why: patch.userIntent.why.trim() || current.userIntent.why,
        successCriteria: patch.userIntent.successCriteria.map((value) => value.trim()).filter(Boolean),
        prioritySignals: patch.userIntent.prioritySignals.map((value) => value.trim()).filter(Boolean),
      },
      workingSummary: patch.workingSummary.trim() || current.workingSummary,
      facts: mapStatements(patch.facts, current.facts, (statement, index, sourceMessageIds) => ({
        factId: current.facts[index]?.factId ?? `fact-user-edit-${index + 1}`,
        statement,
        scope: current.facts[index]?.scope ?? "project",
        confidence: "verified",
        observedAt: current.facts[index]?.observedAt ?? nowIso(),
        sourceMessageIds,
      })),
      decisions: mapStatements(patch.decisions, current.decisions, (decision, index, sourceMessageIds) => ({
        decisionId: current.decisions[index]?.decisionId ?? `decision-user-edit-${index + 1}`,
        title: decision.slice(0, 72) || `Decision ${index + 1}`,
        decision,
        reason: current.decisions[index]?.reason ?? "Corrected by the user in the context-memory review panel.",
        scope: current.decisions[index]?.scope ?? "conversation",
        status: current.decisions[index]?.status ?? "accepted",
        sourceMessageIds,
        relatedDocPaths: current.decisions[index]?.relatedDocPaths ?? [],
      })),
      preferences: mapStatements(patch.preferences, current.preferences, (statement, index, sourceMessageIds) => ({
        preferenceId: current.preferences[index]?.preferenceId ?? `preference-user-edit-${index + 1}`,
        statement,
        appliesTo: current.preferences[index]?.appliesTo ?? "current ResonantOS workstream",
        sourceMessageIds,
      })),
      openTasks: mapStatements(patch.openTasks, current.openTasks, (description, index, sourceMessageIds) => ({
        taskId: current.openTasks[index]?.taskId ?? `task-user-edit-${index + 1}`,
        owner: current.openTasks[index]?.owner ?? "agent",
        status: current.openTasks[index]?.status ?? "open",
        description,
        blockingReason: current.openTasks[index]?.blockingReason,
        verificationRequired: current.openTasks[index]?.verificationRequired ?? ["deterministic checks before completion"],
        sourceMessageIds,
      })),
    };
    updated = true;
    return appendTranscriptEvent(draft, {
      action: "context-memory-edited",
      threadId: activeThread.id,
      channelId: activeThread.channelId,
      agentId: activeThread.owningAgentId,
      payload: {
        compactedAt: patch.compactedAt,
        editedFields: ["intent", "summary", "facts", "decisions", "preferences", "tasks"],
      },
    });
  });

  setChatNotice(updated ? "Context memory updated. Future replies will use the corrected compact memory." : "No compact memory was found to update.");
}

export function selectChatAgentAction({
  agentId,
  state,
  updateRuntimeState,
  setComposer,
  setChatNotice,
  setAttachments,
}: {
  agentId: string;
  state: ResonantShellState;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setChatNotice: SetNotice;
  setAttachments: SetAttachments;
}): void {
  const nextThread = state.conversationThreads.find((thread) => thread.owningAgentId === agentId);
  if (!nextThread) {
    setChatNotice("No chat thread exists for that agent yet.");
    return;
  }

  activateChatThread(nextThread.id, updateRuntimeState, setComposer, setChatNotice, setAttachments);
}

export function stopChatGenerationAction({
  chatBusy,
  harnessRuntime,
  activeThread,
  activeChatRunTokenRef,
  updateRuntimeState,
  setChatBusy,
  setChatRunPhase,
  setAgentActivityLabel,
  setChatNotice,
}: {
  chatBusy: boolean;
  harnessRuntime?: HarnessChatRuntime;
  activeThread: ConversationThread | null;
  activeChatRunTokenRef: MutableRefObject<string | null>;
  updateRuntimeState: RuntimeStateUpdater;
  setChatBusy: (value: boolean) => void;
  setChatRunPhase: (value: ChatRunPhase) => void;
  setAgentActivityLabel: (value: string) => void;
  setChatNotice: SetNotice;
}): void {
  if (!chatBusy || !activeThread) {
    return;
  }

  const stoppedRunToken = activeChatRunTokenRef.current;
  activeChatRunTokenRef.current = null;
  const harnessTurn = harnessRuntime?.active;
  if (harnessRuntime && harnessTurn && harnessTurn.runToken === stoppedRunToken) {
    harnessTurn.interrupt();
    harnessTurn.interrupted = true;
    harnessTurn.abort.abort();
    cancelRegisteredHarnessTurn(harnessRuntime, harnessTurn);
    setChatBusy(false);
    setChatRunPhase("interrupted");
    setAgentActivityLabel("Response interrupted. You can send the correction now.");
    setChatNotice("Response interrupted. Partial assistant message kept in the chat.");
    return;
  }
  if (stoppedRunToken) {
    void abortProviderServiceChatCompletion(stoppedRunToken);
  }

  updateRuntimeState((draft) => {
    const targetThread = draft.conversationThreads.find((thread) => thread.id === activeThread.id);
    if (!targetThread) {
      return draft;
    }
    const interruptedMessage: ConversationMessage = {
      id: `${targetThread.id}:m${targetThread.messages.length + 1}`,
      threadId: targetThread.id,
      channelId: targetThread.channelId,
      role: "assistant",
      author:
        targetThread.owningAgentId === draft.recoverySession.engineerAgentId
          ? draft.agents.find((agent) => agent.id === draft.recoverySession.engineerAgentId)?.displayName ?? "Resonant Engineer Agent"
          : draft.strategistIdentity.customName ?? draft.strategistIdentity.defaultName,
      content: "Response stopped by the user before a complete reply was returned.",
      createdAt: new Date().toISOString(),
      status: "interrupted",
    };
    targetThread.messages = [...targetThread.messages, interruptedMessage];
    return appendTranscriptEvent(draft, {
      action: "generation-interrupted",
      threadId: interruptedMessage.threadId,
      channelId: interruptedMessage.channelId,
      messageId: interruptedMessage.id,
      role: interruptedMessage.role,
      agentId: targetThread.owningAgentId,
      payload: messageTranscriptPayload(interruptedMessage),
    });
  });
  setChatBusy(false);
  setChatRunPhase("interrupted");
  setAgentActivityLabel("Response interrupted. You can send the correction now.");
  setChatNotice("Response interrupted. Partial assistant message kept in the chat.");
}
