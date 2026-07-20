# ADR-004: Strategist Chat Rail

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: Extension experience
- Decision date: 2026-04-23
- Alpha note: Conversation and composer rules apply. Desktop-shell rail and
  window placement do not; Alpha uses the MV3 side panel and new-tab workspace.

## Decision

The Strategist chat is a persistent right-side rail in the ResonantOS shell.

## UX Principles

- The left side is navigation.
- The center is the active workspace surface.
- The right side is the persistent Strategist conversation rail.
- The chat rail may be collapsed, but it remains a first-class working surface.

## Composer Rules

- Composer controls sit on the same lane under the input area.
- Send uses a compact icon button with accent emphasis.
- Active responses expose a Stop control in the same composer action lane.
- Stopped responses remain visible as interrupted assistant messages so the user can inspect, delete, branch, or regenerate from the interrupted point.
- File attach and dictate use minimal icon buttons.
- Model and depth selectors remain present but visually quiet.
- Context usage is shown as an estimate until real compaction and tokenizer-aware accounting exist.
- Hover text must explain what the context indicator means and what it does not mean yet.

## Runtime Rules

- Chat runtime state must distinguish idle, thinking, retrieving, tool-running, interrupted, failed, and completed phases.
- A user follow-up during an active response must not be silently accepted into an ambiguous state.
- Until provider streaming and true IPC abort are implemented, Stop must invalidate the active run token, preserve an interrupted message, and suppress any late provider response from being appended.
- Provider streaming should use host-mediated Tauri events, not direct renderer-owned provider calls.
- Stop must request host-side cancellation for the active run where the provider/runtime supports it, while retaining stale-response suppression as the fallback guard.
- Providers that cannot stream must fall back to the existing request/response path without breaking the chat rail.

## Trust Rules

- The chat rail represents the main trusted Strategist relationship.
- It is not a generic demo chat box.
- Provider failures and capability gaps should surface honestly in the rail.

## Implementation Implication

- The chat rail belongs to `src/modules/chat/`.
- Shell composition may place it, but shell files should not own its internal rendering.
