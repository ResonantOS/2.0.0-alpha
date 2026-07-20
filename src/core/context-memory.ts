// Intent citation: docs/architecture/ADR-016-context-memory-compaction.md

import type {
  ContextBudget,
  ContextMemoryState,
  ConversationMessage,
  ConversationThread,
  ConversationTranscriptEvent,
  ProviderProfile,
  ProviderRuntimeNode,
  ResonantShellState,
} from "./contracts";

export type ContextBudgetAttachment = {
  name: string;
  content?: string;
};

export type TranscriptEventInput = Omit<ConversationTranscriptEvent, "id" | "createdAt"> & {
  createdAt?: string;
};

export type ContextBudgetInput = {
  thread: ConversationThread | null;
  composer: string;
  attachments: ContextBudgetAttachment[];
  provider?: ProviderProfile;
  runtimeNode?: ProviderRuntimeNode;
  modelId: string;
};

export const DEFAULT_CLOUD_CONTEXT_TOKENS = 64_000;
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 8_192;
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

const MESSAGE_OVERHEAD_TOKENS = 6;
const ATTACHMENT_OVERHEAD_TOKENS = 12;

const knownModelBudgets: Record<string, number> = {
  "zai/glm-5.2": 195_000,
  "batiai/gemma4-e2b:q4": 8_192,
  "llama3.2:1b": 8_192,
  "qwen3:4b": 32_000,
};

export const estimateTextTokens = (text: string): number => {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
};

const estimateThreadTokens = (thread: ConversationThread | null): number =>
  thread?.messages.reduce(
    (total, message) => total + MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(`${message.role}: ${message.content}`),
    0,
  ) ?? 0;

const estimateAttachmentTokens = (attachments: ContextBudgetAttachment[]): number =>
  attachments.reduce(
    (total, attachment) =>
      total + ATTACHMENT_OVERHEAD_TOKENS + estimateTextTokens(attachment.content ?? attachment.name),
    0,
  );

const maxContextFor = (
  provider: ProviderProfile | undefined,
  runtimeNode: ProviderRuntimeNode | undefined,
  modelId: string,
): number => {
  const providerPolicy = provider?.modelContext?.find((policy) => policy.model === modelId);
  if (providerPolicy) {
    return providerPolicy.maxContextTokens;
  }

  const knownBudget = knownModelBudgets[modelId];
  if (knownBudget) {
    return knownBudget;
  }

  if (runtimeNode?.kind === "local" || provider?.providerType === "local") {
    return DEFAULT_LOCAL_CONTEXT_TOKENS;
  }

  return DEFAULT_CLOUD_CONTEXT_TOKENS;
};

const modelContextPolicyFor = (provider: ProviderProfile | undefined, modelId: string) =>
  provider?.modelContext?.find((policy) => policy.model === modelId);

export const buildContextBudget = ({
  thread,
  composer,
  attachments,
  provider,
  runtimeNode,
  modelId,
}: ContextBudgetInput): ContextBudget => {
  const modelContextPolicy = modelContextPolicyFor(provider, modelId);
  const maxContextTokens = maxContextFor(provider, runtimeNode, modelId);
  const reservedOutputTokens =
    modelContextPolicy?.reservedOutputTokens ?? Math.max(1_024, Math.round(maxContextTokens * 0.08));
  const reservedReasoningTokens =
    modelContextPolicy?.reservedReasoningTokens ?? (provider?.providerType === "openai" ? Math.round(maxContextTokens * 0.05) : 0);
  const reservedSystemTokens =
    modelContextPolicy?.reservedSystemTokens ?? Math.max(1_024, Math.round(maxContextTokens * 0.04));
  const reservedRetrievalTokens =
    modelContextPolicy?.reservedRetrievalTokens ?? Math.max(1_024, Math.round(maxContextTokens * 0.08));
  const usableInputTokens = Math.max(
    1,
    maxContextTokens -
      reservedOutputTokens -
      reservedReasoningTokens -
      reservedSystemTokens -
      reservedRetrievalTokens,
  );
  const usedInputTokens =
    estimateThreadTokens(thread) + estimateTextTokens(composer) + estimateAttachmentTokens(attachments);

  return {
    providerId: provider?.id ?? "unknown-provider",
    modelId: modelId || provider?.primaryModel || "unknown-model",
    maxContextTokens,
    usedInputTokens,
    reservedOutputTokens,
    reservedReasoningTokens,
    reservedSystemTokens,
    reservedRetrievalTokens,
    compactionThreshold: Math.round(usableInputTokens * 0.8),
    hardStopThreshold: Math.round(usableInputTokens * 0.95),
    estimateQuality: modelContextPolicy ? "provider" : "heuristic",
  };
};

export const usableContextTokens = (budget: ContextBudget): number =>
  Math.max(
    1,
    budget.maxContextTokens -
      budget.reservedOutputTokens -
      budget.reservedReasoningTokens -
      budget.reservedSystemTokens -
      budget.reservedRetrievalTokens,
  );

export const contextUsageRatio = (budget: ContextBudget): number =>
  Math.min(budget.usedInputTokens / usableContextTokens(budget), 1);

export const shouldAutoCompactContext = (budget: ContextBudget): boolean =>
  budget.usedInputTokens >= budget.compactionThreshold;

export const shouldHardStopContext = (budget: ContextBudget): boolean =>
  budget.usedInputTokens >= budget.hardStopThreshold;

export const formatTokenCount = (value: number): string => {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
};

export const contextBudgetTitle = (budget: ContextBudget): string => {
  const usable = usableContextTokens(budget);
  return [
    `Heuristic context estimate for ${budget.modelId}.`,
    `${formatTokenCount(budget.usedInputTokens)} tokens used out of ~${formatTokenCount(usable)} usable input tokens.`,
    `Model ceiling: ~${formatTokenCount(budget.maxContextTokens)} tokens.`,
    `Compaction threshold: ~${formatTokenCount(budget.compactionThreshold)} tokens.`,
    `Hard-stop threshold: ~${formatTokenCount(budget.hardStopThreshold)} tokens.`,
    budget.estimateQuality === "provider"
      ? "Context ceiling comes from provider/model metadata; live input usage is still estimated until provider tokenizer telemetry is available."
      : "This is not provider-tokenizer exact yet.",
  ].join(" ");
};

const transcriptEventId = (threadId: string, index: number): string => `${threadId}:e${index + 1}`;

export const appendTranscriptEvent = (
  state: ResonantShellState,
  input: TranscriptEventInput,
): ResonantShellState => {
  const ledger = state.transcriptLedger ?? [];
  const createdAt = input.createdAt ?? new Date().toISOString();
  const event: ConversationTranscriptEvent = {
    ...input,
    id: transcriptEventId(input.threadId, ledger.length),
    createdAt,
  };

  return {
    ...state,
    transcriptLedger: [...ledger, event],
  };
};

export const messageTranscriptPayload = (message: ConversationMessage): Record<string, unknown> => ({
  author: message.author,
  content: message.content,
  status: message.status ?? "complete",
  archiveCitations: message.archiveCitations ?? [],
  providerUsage: message.providerUsage,
});

export const branchTranscriptPayload = (
  sourceThread: ConversationThread,
  forkThread: ConversationThread,
  sourceMessageId?: string,
): Record<string, unknown> => ({
  sourceTitle: sourceThread.title,
  forkTitle: forkThread.title,
  sourceMessageId,
  copiedMessageIds: forkThread.messages.map((message) => message.id),
});

const sentenceFrom = (content: string): string =>
  content
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)[0]
    ?.slice(0, 240) ?? "";

const sentencesFrom = (content: string): string[] =>
  content
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.slice(0, 240))
    .filter(Boolean);

const sourceRangeFor = (messages: ConversationMessage[]): ContextMemoryState["sourceRange"] => ({
  fromMessageId: messages[0]?.id ?? "",
  toMessageId: messages.at(-1)?.id ?? "",
});

const checksumOf = (content: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv32:${(hash >>> 0).toString(16)}`;
};

const userMessagesOf = (thread: ConversationThread): ConversationMessage[] =>
  thread.messages.filter((message) => message.role === "user");

const prioritySignalsFrom = (messages: ConversationMessage[]): string[] =>
  messages
    .filter((message) => /\b(important|critical|careful|quality|risk|dangerous|must|don't|do not|before)\b/i.test(message.content))
    .slice(-5)
    .map((message) => sentenceFrom(message.content))
    .filter(Boolean);

const successCriteriaFrom = (messages: ConversationMessage[]): string[] =>
  messages
    .filter((message) => /\b(done|working|test|validate|deterministic|pass|success|must be able|needs to)\b/i.test(message.content))
    .slice(-5)
    .map((message) => sentenceFrom(message.content))
    .filter(Boolean);

const artifactRefsFrom = (messages: ConversationMessage[]): ContextMemoryState["artifacts"] => {
  const refs: ContextMemoryState["artifacts"] = [];
  const pathPattern = /(?:\.{0,2}\/|\/Users\/|docs\/|src\/|public\/)[^\s),`]+/g;
  const urlPattern = /https?:\/\/[^\s),`]+/g;
  const commitPattern = /\b[0-9a-f]{7,40}\b/gi;

  for (const message of messages) {
    for (const ref of message.content.match(pathPattern) ?? []) {
      refs.push({
        artifactId: `artifact-${refs.length + 1}`,
        kind: ref.match(/\.(png|jpg|jpeg|gif|webp)$/i) ? "screenshot" : "file",
        label: ref.split("/").at(-1) ?? ref,
        ref,
        sourceMessageIds: [message.id],
      });
    }
    for (const ref of message.content.match(urlPattern) ?? []) {
      refs.push({
        artifactId: `artifact-${refs.length + 1}`,
        kind: "external-url",
        label: ref,
        ref,
        sourceMessageIds: [message.id],
      });
    }
    for (const ref of message.content.match(commitPattern) ?? []) {
      refs.push({
        artifactId: `artifact-${refs.length + 1}`,
        kind: "commit",
        label: ref.slice(0, 12),
        ref,
        sourceMessageIds: [message.id],
      });
    }
  }

  return refs;
};

const factScopeFor = (content: string): ContextMemoryState["facts"][number]["scope"] => {
  if (/\b(i am|my|for me|in my case|i have|i use)\b/i.test(content)) {
    return "user";
  }
  if (/\b(resonantos|augmentor|engineer|living archive|openclaw|hermes|obsidian)\b/i.test(content)) {
    return "system";
  }
  if (/\b(research|external|company|client|meeting|document)\b/i.test(content)) {
    return "external";
  }
  return "project";
};

const factsFrom = (messages: ConversationMessage[]): ContextMemoryState["facts"] =>
  messages
    .filter((message) => factPattern.test(message.content))
    .slice(-12)
    .flatMap((message) =>
      sentencesFrom(message.content)
        .filter((sentence) => factPattern.test(sentence))
        .map((sentence) => ({
          statement: sentence,
          scope: factScopeFor(sentence),
          confidence: message.role === "user" ? ("verified" as const) : ("unverified" as const),
          observedAt: message.createdAt,
          sourceMessageIds: [message.id],
        })),
    )
    .slice(-12)
    .map((fact, index) => ({
      factId: `fact-${index + 1}`,
      ...fact,
    }))
    .filter((fact) => fact.statement.length > 0);

const factPattern = /\b(is|are|has|have|uses|runs|contains|supports|currently|default|available|installed|configured)\b/i;

const decisionsFrom = (messages: ConversationMessage[]): ContextMemoryState["decisions"] =>
  messages
    .filter((message) => /\b(agreed|decision|decide|we need|must|should)\b/i.test(message.content))
    .slice(-10)
    .map((message, index) => ({
      decisionId: `decision-${index + 1}`,
      title: sentenceFrom(message.content).slice(0, 72) || `Decision ${index + 1}`,
      decision: sentenceFrom(message.content),
      reason: "Extracted from explicit user/assistant planning language during deterministic compaction.",
      scope: "conversation",
      status: "accepted" as const,
      sourceMessageIds: [message.id],
      relatedDocPaths: [],
    }));

const preferencesFrom = (messages: ConversationMessage[]): ContextMemoryState["preferences"] =>
  messages
    .filter((message) => /\b(i want|i need|my preference|prefer|priority|for me|in my case)\b/i.test(message.content))
    .slice(-10)
    .map((message, index) => ({
      preferenceId: `preference-${index + 1}`,
      statement: sentenceFrom(message.content),
      appliesTo: "current ResonantOS workstream",
      sourceMessageIds: [message.id],
    }));

const tasksFrom = (messages: ConversationMessage[]): ContextMemoryState["openTasks"] =>
  messages
    .filter((message) => /\b(next|implement|fix|add|create|test|validate|need to|go ahead)\b/i.test(message.content))
    .slice(-10)
    .map((message, index) => {
      const status = /\b(done|implemented|fixed|passed|validated|completed)\b/i.test(message.content)
        ? ("done" as const)
        : /\b(blocked|cannot|can't|failed|not available)\b/i.test(message.content)
          ? ("blocked" as const)
          : ("open" as const);
      return {
        taskId: `task-${index + 1}`,
        owner: message.role === "user" ? "agent" : "unknown",
        status,
        description: sentenceFrom(message.content),
        blockingReason: status === "blocked" ? "Extracted from blocked/failed language during deterministic compaction." : undefined,
        verificationRequired: status === "done" ? [] : ["deterministic checks before completion"],
        sourceMessageIds: [message.id],
      };
    });

export const buildDeterministicCompactState = (
  thread: ConversationThread,
  preservedRecentCount = 8,
): ContextMemoryState => {
  const messages = thread.messages;
  const userMessages = userMessagesOf(thread);
  const latestUserMessage = userMessages.at(-1);
  const firstUserMessage = userMessages[0];
  const preservedRecentMessageIds = messages.slice(-preservedRecentCount).map((message) => message.id);
  const transcriptDigest = messages.map((message) => `${message.id}:${message.role}:${message.content}`).join("\n");

  return {
    threadId: thread.id,
    compactedAt: new Date().toISOString(),
    sourceRange: sourceRangeFor(messages),
    userIntent: {
      goal: latestUserMessage ? sentenceFrom(latestUserMessage.content) : thread.summary,
      why: firstUserMessage ? sentenceFrom(firstUserMessage.content) : "No explicit user rationale captured yet.",
      successCriteria: successCriteriaFrom(userMessages),
      prioritySignals: prioritySignalsFrom(userMessages),
      sourceMessageIds: userMessages.map((message) => message.id),
    },
    workingSummary: [
      `Thread: ${thread.title}.`,
      `Summary: ${thread.summary}.`,
      latestUserMessage ? `Latest user direction: ${sentenceFrom(latestUserMessage.content)}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    decisions: decisionsFrom(messages),
    facts: factsFrom(messages),
    preferences: preferencesFrom(userMessages),
    openTasks: tasksFrom(messages),
    artifacts: artifactRefsFrom(messages),
    risks: messages
      .filter((message) => /\b(risk|danger|unsafe|security|broken|failed|problem)\b/i.test(message.content))
      .slice(-8)
      .map((message, index) => ({
        riskId: `risk-${index + 1}`,
        description: sentenceFrom(message.content),
        severity: "medium" as const,
        sourceMessageIds: [message.id],
      })),
    unresolvedQuestions: messages
      .filter((message) => message.content.includes("?"))
      .slice(-8)
      .map((message, index) => ({
        questionId: `question-${index + 1}`,
        question: sentenceFrom(message.content),
        owner: message.role === "user" ? "agent" : "user",
        sourceMessageIds: [message.id],
      })),
    preservedRecentMessageIds,
    checksum: checksumOf(transcriptDigest),
  };
};

export const compactThreadContext = (
  state: ResonantShellState,
  threadId: string,
  preservedRecentCount = 8,
): ResonantShellState => {
  const thread = state.conversationThreads.find((item) => item.id === threadId);
  if (!thread) {
    return state;
  }

  const compactState = buildDeterministicCompactState(thread, preservedRecentCount);
  const withCompactState = {
    ...state,
    contextMemoryStates: [...(state.contextMemoryStates ?? []), compactState],
  };

  return appendTranscriptEvent(withCompactState, {
    action: "context-compacted",
    threadId,
    channelId: thread.channelId,
    agentId: thread.owningAgentId,
    payload: {
      compactedAt: compactState.compactedAt,
      checksum: compactState.checksum,
      sourceRange: compactState.sourceRange,
      preservedRecentMessageIds: compactState.preservedRecentMessageIds,
    },
  });
};

export const copyCompactStatesForFork = (
  contextMemoryStates: ContextMemoryState[],
  sourceThreadId: string,
  forkThread: ConversationThread,
  sourceMessageId?: string,
): ContextMemoryState[] => {
  const sourceStates = contextMemoryStates.filter((compactState) => compactState.threadId === sourceThreadId);
  if (!sourceStates.length) {
    return contextMemoryStates;
  }

  const forkMessageIds = new Set(forkThread.messages.map((message) => message.id));
  const copiedStates = sourceStates.map((compactState) => {
    const preservedRecentMessageIds = compactState.preservedRecentMessageIds
      .map((messageId) => messageId.replace(`${sourceThreadId}:`, `${forkThread.id}:`))
      .filter((messageId) => forkMessageIds.has(messageId));
    return {
      ...compactState,
      threadId: forkThread.id,
      compactedAt: new Date().toISOString(),
      sourceRange: {
        fromMessageId: compactState.sourceRange.fromMessageId.replace(`${sourceThreadId}:`, `${forkThread.id}:`),
        toMessageId: (sourceMessageId ?? compactState.sourceRange.toMessageId).replace(`${sourceThreadId}:`, `${forkThread.id}:`),
      },
      userIntent: {
        ...compactState.userIntent,
        sourceMessageIds: compactState.userIntent.sourceMessageIds
          .map((messageId) => messageId.replace(`${sourceThreadId}:`, `${forkThread.id}:`))
          .filter((messageId) => forkMessageIds.has(messageId)),
      },
      preservedRecentMessageIds,
      checksum: `${compactState.checksum}:fork:${forkThread.id}`,
    };
  });

  return [...contextMemoryStates, ...copiedStates];
};

export const latestCompactStateForThread = (
  state: Pick<ResonantShellState, "contextMemoryStates">,
  threadId: string,
): ContextMemoryState | null =>
  [...(state.contextMemoryStates ?? [])].reverse().find((compactState) => compactState.threadId === threadId) ?? null;

export const promptMessagesForThread = (
  thread: ConversationThread,
  compactState: ContextMemoryState | null,
): ConversationMessage[] => {
  const usableProviderMessage = (message: ConversationMessage): boolean => {
    if (!message.content.trim()) {
      return false;
    }
    if (message.role === "assistant" && (message.status === "failed" || message.status === "interrupted")) {
      return false;
    }
    return true;
  };
  const dropMessagesBeforeFirstUser = (messages: ConversationMessage[]): ConversationMessage[] => {
    const firstUserIndex = messages.findIndex((message) => message.role === "user");
    return firstUserIndex >= 0 ? messages.slice(firstUserIndex) : [];
  };

  if (!compactState) {
    return dropMessagesBeforeFirstUser(thread.messages.filter(usableProviderMessage));
  }

  const preserved = new Set(compactState.preservedRecentMessageIds);
  const compactEndIndex = thread.messages.findIndex((message) => message.id === compactState.sourceRange.toMessageId);
  if (compactEndIndex < 0) {
    return dropMessagesBeforeFirstUser(thread.messages.filter(usableProviderMessage));
  }
  return dropMessagesBeforeFirstUser(thread.messages.filter((message, index) => {
    if (!usableProviderMessage(message)) {
      return false;
    }
    return preserved.has(message.id) || index > compactEndIndex;
  }));
};

export const formatCompactStateForPrompt = (compactState: ContextMemoryState | null): string => {
  if (!compactState) {
    return "";
  }

  const lines = [
    "ResonantOS compacted conversation memory:",
    `- User goal: ${compactState.userIntent.goal}`,
    `- User why: ${compactState.userIntent.why}`,
    `- Success criteria: ${compactState.userIntent.successCriteria.join("; ") || "none captured"}`,
    `- Priority signals: ${compactState.userIntent.prioritySignals.join("; ") || "none captured"}`,
    `- Working summary: ${compactState.workingSummary}`,
    `- Decisions: ${compactState.decisions.map((decision) => decision.decision).join("; ") || "none captured"}`,
    `- Facts: ${compactState.facts.map((fact) => `${fact.statement} [${fact.scope}, ${fact.confidence}]`).join("; ") || "none captured"}`,
    `- Preferences: ${compactState.preferences.map((preference) => preference.statement).join("; ") || "none captured"}`,
    `- Tasks: ${compactState.openTasks.map((task) => `${task.description} [${task.status}]`).join("; ") || "none captured"}`,
    `- Artifacts: ${compactState.artifacts.map((artifact) => artifact.ref).join("; ") || "none captured"}`,
    `- Risks: ${compactState.risks.map((risk) => risk.description).join("; ") || "none captured"}`,
    `- Unresolved questions: ${compactState.unresolvedQuestions.map((question) => question.question).join("; ") || "none captured"}`,
    `- Preserved recent message ids: ${compactState.preservedRecentMessageIds.join(", ") || "none"}`,
    `- Compact checksum: ${compactState.checksum}`,
    "Use this compact memory as continuity context. Do not treat it as permission to invent facts absent from the raw transcript or cited artifacts.",
  ];

  return lines.join("\n");
};
