# ADR-016: Context Memory Compaction

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Conversation memory
- Decision date: Not recorded
- Alpha note: The full host-owned Context Memory Pipeline is not an Alpha
  release requirement.

## Decision

ResonantOS must implement context compaction as a host-owned **Context Memory Pipeline**, not as blind chat summarization.

The chat context meter may show a simple percentage in the UI, but the underlying system must preserve continuity through structured, source-linked memory layers:

- immutable raw transcript
- user intent and why
- rolling working summary
- decision ledger
- facts, entities, and user preferences
- open tasks and commitments
- artifact and code pointers
- recent uncompressed conversation window
- retrieval from System Architecture Memory and the Living Archive

Older chat turns may be compacted out of the active provider prompt only after their important content has been captured into structured memory and linked back to raw source turns or artifacts.

## Why

Long-running AI relationships fail when the system silently drops old context, summarizes too aggressively, or relies on a single opaque provider conversation object. ResonantOS cannot assume one provider will preserve state forever because the provider fabric can route across OpenAI, MiniMax, Anthropic, Gemini, local models, and user-owned runtime nodes.

The goal is not to keep every token in every prompt. The goal is to preserve meaning, user intent, the why behind the work, decisions, obligations, architecture constraints, user preferences, and work state in a way that survives provider switches, context limits, app restarts, and recovery mode.

## External Evidence

Public documentation shows several relevant patterns:

- Anthropic Claude Code exposes `/compact [instructions]` to compact a conversation and `/memory` / `CLAUDE.md` mechanisms for durable instruction memory. Source: <https://docs.anthropic.com/en/docs/claude-code/slash-commands> and <https://docs.anthropic.com/en/docs/claude-code/memory>.
- Gemini emphasizes large context windows, token counting, and context caching. Its docs still frame the context window as limited short-term memory and recommend caching/reuse for large repeated context. Source: <https://ai.google.dev/gemini-api/docs/long-context> and <https://ai.google.dev/gemini-api/docs/caching/>.
- OpenAI documents conversation state, context-window management, prompt caching, and an advanced `/responses/compact` flow. OpenAI compaction is stateless at the API boundary and returns a compacted window for the next response. Source: <https://platform.openai.com/docs/guides/conversation-state> and <https://platform.openai.com/docs/guides/prompt-caching/prompt-caching>.
- OpenAI Agents SDK separates local application context from LLM-visible context, which matches the ResonantOS rule that host state and LLM prompt state must not be treated as the same thing. Source: <https://openai.github.io/openai-agents-python/context/>.

These mechanisms are useful references, but ResonantOS must not depend on any one provider's opaque compaction to maintain user memory.

## Rules

- Raw transcript is append-only and recoverable.
- Compaction must be explicit, auditable, and reversible from raw transcript where possible.
- The active prompt must include a compact state block plus recent turns, not only an LLM-written prose summary.
- Every compact state block must record source message ids, artifact ids, or document paths for important claims.
- User intent and rationale must be first-class fields, not inferred from task lists or summaries.
- If the user explains why something matters, compaction must preserve that reason even when the associated implementation detail changes.
- User preferences must be separated from project decisions.
- Open tasks must be separated from completed tasks.
- Architecture decisions must be written to ADRs or System Architecture Memory, not buried only in chat summary.
- Living Archive knowledge writes remain governed by ADR-007, ADR-011, ADR-012, ADR-013, and ADR-014.
- Provider-side compaction may be used when available, but it is an optimization, not the authority for memory.
- Provider prompt caching may be used for cost and latency, but it is not memory and must not be treated as memory.

## Memory Layers

### Raw Transcript

The raw transcript stores every user, assistant, tool, and system-visible event that ResonantOS is allowed to persist.

Required fields:

- `threadId`
- `messageId`
- `role`
- `agentId`
- `channelId`
- `createdAt`
- `content`
- `attachments`
- `toolEvents`
- `providerRunId`
- `tokenEstimate`
- `redactionState`

### Rolling Working Summary

The rolling summary preserves the practical state of the conversation.

It answers:

- What are we trying to do?
- What has already been decided?
- What has already been tried?
- What is currently broken or uncertain?
- What is the next likely step?

### Decision Ledger

The decision ledger stores binding choices separately from general summary.

Required fields:

- `decisionId`
- `title`
- `decision`
- `reason`
- `scope`
- `status`
- `sourceMessageIds`
- `relatedDocPaths`

### Facts, Entities, and Preferences

This layer stores stable user facts, project facts, named entities, and preferences.

Rules:

- User identity and preference facts must be explicit and source-linked.
- Project facts must include project scope and freshness.
- Unverified facts must be marked `unverified`.
- Time-sensitive facts must include observed date.

### Open Tasks and Commitments

The system must preserve what the AI has committed to doing.

Required fields:

- `taskId`
- `owner`
- `status`
- `description`
- `blockingReason`
- `verificationRequired`
- `sourceMessageIds`

### Artifact and Code Pointers

The compaction state must prefer stable pointers over copied bulk content.

Examples:

- ADR path
- source file path and symbol name
- commit hash
- screenshot path
- archive document id
- add-on manifest id

## Compaction Triggers

Each provider profile must declare or derive:

- max context tokens
- output token reserve
- reasoning token reserve where applicable
- system prompt reserve
- retrieval reserve
- recent-turn reserve
- compaction threshold
- hard-stop threshold
- tokenizer or estimation method

ResonantOS stores this in per-model context policy metadata on the provider
profile. The metadata is the first source of truth for the model ceiling and
reserved-token budgets. If the model has no configured metadata, ResonantOS may
fall back to a conservative provider/runtime heuristic, but the UI must label
that estimate as heuristic.

Default thresholds:

- `70%`: soft warning in UI
- `80%` of usable input budget: prepare compact state in background when possible
- `90%` of usable input budget: require compaction before another long response
- `95%` of usable input budget: hard stop unless provider-native compaction is available and policy allows it

The usable input budget is the model context ceiling minus reserved output,
reasoning, system, and retrieval tokens. UI percentages and automatic triggers
must use the same usable-input denominator so the user sees compaction near the
same percentage the system uses internally.

The user may also trigger `Compact now`.

## Compaction Flow

1. Capture raw messages since the previous compaction.
2. Classify content into decisions, facts, preferences, tasks, artifacts, risks, and unresolved questions.
3. Extract user intent and rationale before compressing implementation detail.
4. Generate a structured compact state object.
5. Verify the compact state against a loss checklist.
6. Persist the compact state beside the transcript and, where appropriate, write archive intake artifacts.
7. Build the next provider prompt from stable system instructions, relevant System Architecture Memory, relevant Living Archive context, the compact state, and recent uncompressed turns.
8. Keep the raw transcript available for audit, replay, branch, and regeneration.

## Loss Checklist

A compaction is invalid if it loses:

- current user intent
- the why behind the user's request
- success criteria from the user's perspective
- user frustration, caution, or priority signals that affect how work should proceed
- binding decisions
- explicit user preferences
- unresolved blockers
- open tasks
- tool results that affect future actions
- file paths, commands, commits, or artifacts needed to continue work
- safety/security constraints
- provider/cost strategy
- active agent identity and channel state
- recovery or degraded-state status

## Provider-Aware Behavior

OpenAI:

- Use `/responses/compact` where available and policy-approved.
- Still persist ResonantOS structured compaction because OpenAI compacted state is provider-specific and may be opaque.
- Structure stable prompt prefixes to benefit from prompt caching.

Gemini:

- Use token counting and context caching for repeated large context.
- Treat large context as useful but still finite and costly.
- Do not assume long context removes the need for structured memory.

Claude / Anthropic:

- Treat documented `/compact` and memory-file behavior as a product reference, not as a portable implementation.
- If Anthropic APIs expose suitable mechanisms in future, wrap them behind the provider fabric.

Local models:

- Prefer shorter compact state and retrieval because local context windows and throughput may be constrained.
- Keep raw transcript and full state host-side so local fallback can recover continuity without holding everything in prompt.

MiniMax and other providers:

- Use provider token metadata where available.
- Fall back to host estimation and ResonantOS structured compaction.

## UI Requirements

The chat rail context indicator must remain minimal, but accurate enough to guide the user.

Required UI:

- compact percentage pill
- hover/tap detail showing used tokens, estimated maximum, response reserve, and compaction threshold
- visible `Compacting...` state when background compaction is active
- `Compact now` action
- warning before hard-stop
- post-compaction note showing what was preserved
- access to raw transcript through chat history or archive/debug view

Touch-first rule:

- context actions must be reachable without hover
- tooltips must have tap equivalents
- destructive reset/clear actions require confirmation

## Interfaces

```ts
type ContextMemoryState = {
  threadId: string;
  compactedAt: string;
  sourceRange: {
    fromMessageId: string;
    toMessageId: string;
  };
  userIntent: {
    goal: string;
    why: string;
    successCriteria: string[];
    prioritySignals: string[];
    sourceMessageIds: string[];
  };
  workingSummary: string;
  decisions: ContextDecision[];
  facts: ContextFact[];
  preferences: ContextPreference[];
  openTasks: ContextTask[];
  artifacts: ContextArtifactRef[];
  risks: ContextRisk[];
  unresolvedQuestions: ContextQuestion[];
  preservedRecentMessageIds: string[];
  checksum: string;
};

type ContextBudget = {
  providerId: string;
  modelId: string;
  maxContextTokens: number;
  usedInputTokens: number;
  reservedOutputTokens: number;
  reservedReasoningTokens: number;
  reservedSystemTokens: number;
  reservedRetrievalTokens: number;
  compactionThreshold: number;
  hardStopThreshold: number;
  estimateQuality: "provider" | "tokenizer" | "heuristic";
};

type ProviderModelContextPolicy = {
  model: string;
  maxContextTokens: number;
  tokenEstimateMethod: "provider-metadata" | "local-tokenizer" | "heuristic";
  reservedOutputTokens?: number;
  reservedReasoningTokens?: number;
  reservedSystemTokens?: number;
  reservedRetrievalTokens?: number;
  source: "provider-default" | "runtime-node" | "user-config";
};

type ProviderUsageTelemetry = {
  providerId: string;
  model: string;
  source: "provider" | "local-runtime";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  tokensPerSecond?: number;
};

When a provider/runtime returns usage metadata, ResonantOS attaches it to the
assistant message and transcript event. This telemetry is authoritative for the
completed turn. It does not replace pre-flight estimation yet, because
compaction decisions must happen before the provider call; it gives the system a
real measurement trail that can be used to calibrate future estimates. Local
runtime messages may also expose completion duration and tokens-per-second when
the runtime reports those fields.

type CompactionRequest = {
  threadId: string;
  agentId: string;
  providerRouteId: string;
  reason: "manual" | "threshold" | "provider_limit" | "branch" | "session_close";
  sourceMessageIds: string[];
  instructions?: string;
};
```

## Implementation Consequences

- The current chat context pill is only a visual placeholder and must be replaced with provider-aware budget tracking.
- Chat persistence must store raw transcript and structured compaction state separately.
- Branching a chat must copy compact state plus the selected source range, not only visible messages.
- Archive save actions should capture compact state when saving a long conversation.
- The Resonant Engineer Agent must include recent recovery actions and current diagnosis in compact state before switching provider/runtime.
- System Architecture Memory remains the authority for architecture facts; compaction may point to it but must not duplicate it as unverified prose.
- Context compaction should be implemented as a module/service boundary, not inside `App.tsx`.

## Exception Policy

Provider-native compaction may be treated as sufficient for a single short-lived provider session only when:

- the user is not switching provider
- no critical decisions or tasks were introduced
- raw transcript remains persisted
- the next turn does not involve code edits, archive promotion, wallet actions, recovery, or destructive operations

For all high-trust flows, ResonantOS structured compaction is required.
