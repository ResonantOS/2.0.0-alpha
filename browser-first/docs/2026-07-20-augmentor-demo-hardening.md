# Augmentor demo hardening — 2026-07-20

Record of the changes on branch `feat/augmentor-ux-and-hermes-fixes` (draft PR
[#270](https://github.com/ResonantOS/2.0.0-alpha/pull/270)). Covers side-panel
UX, agent-control behavior, the Hermes delegation runtime fix, and the local
bridge infrastructure (documented here because it lives outside the repo).

## Commits

| SHA | Summary |
|---|---|
| `5e52589` | fix(hermes): accept uv-created venv interpreters in the runtime allowlist |
| `92c6053` | feat(agent-control): natural browser commands and a visible click spotlight |
| `befead7` | feat(side-panel): collapsible context-dock panels and browser-workspace UX |
| `79299ec` | feat(side-panel): top-tab popouts for Site / Agent Control / Jobs |

> `befead7`'s per-panel Show/Hide collapse toggles were superseded by `79299ec`'s
> top-tab popouts; the collapse controller was removed. The readability fixes
> from `befead7` (wrapped action text, scrollable summary, taller job list) were
> kept because they also serve the popout.

## Changes by area

### 1. Jobs monitor declutter (`befead7`)
- **Clear done** button removes settled jobs (`completed` / `cancelled` /
  `denied`); `blocked` / `failed` are kept (they usually still need a human).
- Settled jobs collapse to a **one-line card**; active/approval jobs keep full
  detail.
- **Active-first ordering** so jobs that need a human surface first.
- Files: `src/lib/browser-job-store.js` (`clearCompletedJobs`,
  `isClearableBrowserJobStatus`), `src/lib/monitor-renderers.js`.

### 2. Workspace toggle + new-tab handling (`befead7`)
- New tabs no longer force the Augmentor workspace. The workspace is opt-in via
  a **toggle in the composer** (`main-workspace-toggle.js` — show / focus / hide
  with a last-tab guard).
- The extension does **not** override Chrome's new-tab page. (An earlier build
  redirected new tabs to a configurable default via `chrome_url_overrides.newtab`
  + a small redirect page; that redirect — and the host-side new-tab ownership
  seeding — was removed so the browser keeps whatever new-tab page the human has
  configured.)

### 3. Agent-control natural commands (`92c6053`)
- Compound "go to `<site>` and `<act>`" commands route to agent control **without
  a `/control` prefix**. `parseBrowserNavigationTaskIntent`
  (`browser-command-parser.js`) fires only when both a navigation target and a
  follow-up action are present, and is checked before the single-action click
  rule so it can't be swallowed against the wrong page. Bare single-page actions
  and pure navigation are unchanged.

### 4. Visible click spotlight (`92c6053`)
- `clickElement` (`content.js`) is now async: it scrolls the target into view,
  spotlights it, and **dwells ~650ms** (`CONTROL_ACTION_DWELL_MS`) so the
  highlight paints before the click navigates away — Comet / teach-mode style.
- Blocked / human-only actions (#240 public-submit, wallet, login) still return
  immediately with no dwell. Tests set `globalThis.__resonantosControlDwellMs = 0`.

### 5. Hermes venv allowlist fix (`5e52589`)
- The Hermes delegation runtime rejected a `uv`-created venv because the venv's
  `python` symlinks to the uv Python store, outside `~/.hermes`, and the security
  allowlist required the interpreter's real path to stay inside the install root.
- `hermesPythonRuntimeDiagnostics` (`browser-first/host/hermes-runtime.mjs`) now
  accepts the interpreter when its resolved path stays in the root **or** it is a
  genuine venv proven by an in-root `pyvenv.cfg`. A bare malicious symlink is
  still rejected. It also returns the **venv launcher** (not the resolved base)
  so the venv's site-packages activate.
- Verified against the real filesystem (`installed: true`, spawns the launcher)
  and with anti-false-green mutation proofs in both directions.

### 6. Top-tab popout panels (`79299ec`)
- **Site · Agent Control · Jobs** are now links at the top of the sidecar. Click
  a link → the panel pops out as a **full-size overlay over the chat**; click
  again or the ✕ closes it; panels stay hidden otherwise. One open at a time.
- A **per-link activity dot** lights when a panel gains new content while closed
  (compared by a content signature so identical re-renders don't false-flag) and
  clears when opened. `dock-tabs.js` controller.
- The panels relocate into `#dock-popout` at runtime; `updateContextDockVisibility`
  no longer counts them. The **approval preflight**, consent, and activity panels
  stay in the inline context-dock so they auto-surface — the primary
  "Approve Agent Control?" gate is never hidden behind a tab. A per-step approval
  inside the Agent Control popout lights its activity dot (fail-closed).

## Chats feature — project → folder → chat, in tandem across surfaces

Codex/Claude-style chat organization, built in four phases. Both surfaces
already read/write the same chat storage keys, so this is one dataset shared by
the sidecar and the main workspace.

| Phase | Commit | What it adds |
|---|---|---|
| P1 | `bfdbdf1` | **Data model** — a `folders[]` tier (each folder belongs to a project) + `folderId` on sessions → project → folder → chat. Folder CRUD + move-to-folder; moving projects or deleting a folder/project unfiles chats; hydrate drops orphaned folders. New key `augmentorBrowserFolders`. |
| P2 | `1ca4102` | **Main rail** — folders render under each project (expand/collapse, rename, delete); **New folder** per project; per-chat **Move to folder** menu; drag-onto-folder. Folder names via `textContent` (no HTML injection). Pure `groupProjectSessionsByFolder` helper. |
| P3 | `657cded` | **Sidecar Chats tab** — a 4th top link whose popout renders the same tree from the shared store (shared `buildChatTree` helper); expand state is shared with the rail; click-to-open switches the active session and reveals its transcript. `dock-tabs` gains an `onOpen` hook. |
| P4 | `0f23576` | **Live tandem sync** — each surface listens to `storage.onChanged` and re-hydrates + re-renders on the other's chat/folder/project/active-session changes. Self-writes are skipped via a per-write `writer` token (`instanceId:seq`) and a pure `shouldSyncChatChange` guard, so no flicker or loop. |

New pure, tested helpers: `groupProjectSessionsByFolder`, `buildChatTree`,
`shouldSyncChatChange`. New modules: `side-panel-chats-tree.js`, `chat-sync.js`.
Every new guard is anti-false-green mutation-proven. Suite stayed green each
phase (ended at browser-first 760 / vitest 312). Also fixed a lingering-timer
test-hygiene issue in the rail move menu (attach the outside-click listener
immediately since the trigger stops propagation).

## Shared step-list + spinner component

A reusable Claude-app-style task/plan step list, used identically in the sidecar
and the main panel — both import `src/lib/step-list.js` and the shared
`src/styles/shared/step-list.css`, so it is consistent by construction. Numbered
steps carry a per-state glyph (✓ done + strikethrough, animated spinner
in-progress, ○ pending, ! blocked, ✕ failed, – cancelled) and a floating
"N of M" progress pill with a spinner. Structure-only renderer; all visuals in
CSS; `prefers-reduced-motion` respected.

**Certified at full rig tier.** A three-vendor review panel — `cursor-agent`,
`codex` (OpenAI gpt-5.5), `pi` (Google gemini-2.5-flash) — drove accessibility
fixes my single pass missed: a `role="status"` pill that was rebuilt each render
(2-vendor corroboration) is now a **persistent node updated in place**; each step
gained screen-reader state text; `role=list`/`role=listitem` restore VoiceOver
list semantics; a missing cancelled-state glyph, unreliable pill centering, and
low text contrast were all fixed. 9 jsdom tests; progress/spinner/persistent-pill
guards mutation-proven.

> **Not yet wired to a live step source** — it is a reusable renderer; the
> natural first use site is the agent-control step list in both surfaces
> (see Open follow-ups).

## Local infrastructure (not in the repo)

These configure the local machine and are recorded here for reproducibility.
Neither contains secret values — provider keys are read from the user's own
files at runtime.

### Single launchd-managed bridge on 47773
The LaunchAgent `~/Library/LaunchAgents/resonantos.browser-first.bridge.plist`
was rewired so its `ProgramArguments` run the launcher script (below) instead of
`node run-bridge-minimal.mjs` directly, so the always-on bridge loads **all five
providers** (OpenAI, MiniMax, Anthropic, DeepSeek, OpenRouter) at boot. The
plist already set `PATH` (incl. `/opt/homebrew/bin`) and `WorkingDirectory`, and
`KeepAlive` restarts it. Backup: `…plist.bak-20260720141516`.

```
ProgramArguments:
  /bin/bash
  <repo-root>/start-augmentor-bridge.sh
```

### `start-augmentor-bridge.sh` (repo root, untracked — out of release scope)

```bash
#!/usr/bin/env bash
# Starts the Augmentor bridge on port 47773 with ALL available provider keys.
# Keys are read from your own files at runtime and passed only via the env var —
# they are never printed or written to disk by this script.
set -euo pipefail
cd "$(dirname "$0")"
OC="$HOME/.openclaw/auth-profiles.json"
SF="$HOME/ResonantOS_User/Secrets/provider-secrets.json"
[ -f "$OC" ] || OC="/dev/null"
[ -f "$SF" ] || SF="/dev/null"
export RESONANTOS_BROWSER_FIRST_BRIDGE_PORT="${RESONANTOS_BROWSER_FIRST_BRIDGE_PORT:-47773}"
export RESONANTOS_PROVIDER_SECRETS_JSON="$(jq -n \
  --slurpfile base "$SF" \
  --arg deepseek   "$(jq -r '.deepseek.apiKey   // empty' "$OC")" \
  --arg openrouter "$(jq -r '.openrouter.apiKey // empty' "$OC")" \
  '($base[0] // {})
   + (if $deepseek   != "" then {"openai-compatible-deepseek":   $deepseek}   else {} end)
   + (if $openrouter != "" then {"openai-compatible-openrouter": $openrouter} else {} end)')"
echo "Bridge starting with providers: $(printf '%s' "$RESONANTOS_PROVIDER_SECRETS_JSON" | jq -r 'keys | join(", ")')"
exec node run-bridge-minimal.mjs
```

### Reviewer-CLI provider fixes (for the rig's multi-vendor panel)
Both cross-vendor review CLIs were broken and were fixed during the step-list
certification (recorded in the `multi-model-review-access-map` memory):
- **codex** — `~/.codex/config.toml` had `model = "gpt-5.6-sol"` (CLI 0.142.0
  rejects it) and `model_reasoning_effort = "ultra"` (invalid enum). Fixed to
  `gpt-5.5` + `high`; `codex exec --skip-git-repo-check "…"` verified. Backup at
  `~/.codex/config.toml.bak-*`.
- **pi** — `~/.pi/agent/settings.json` defaults to keyless `deepseek`, and pi
  reads keys from env vars (not the openclaw/ResonantOS stores). Working form:
  `GEMINI_API_KEY="$(jq -r .google.apiKey ~/.openclaw/auth-profiles.json)" pi --model google/gemini-2.5-flash "…"` (never `--api-key`, which leaks into argv).

## Verification (at the tip of the branch)

| Command | Result |
| --- | --- |
| `npm run test:browser-first` | 769 / 769 pass |
| `npm test` (vitest) | 312 / 312 pass |
| `node scripts/browser-first-release-scope-audit.mjs --committed --strict` | 0 deferred, 0 manual review |
| `scripts/rig-mutate` anti-false-green (hermes ×2, routing, click-dwell, dock-tabs, folders, buildChatTree, chat-sync, step-list ×3) | all NON-VACUOUS |

## Excluded from the repo, and why
- `start-augmentor-bridge.sh` — a machine-specific dev launcher; out of the
  browser-first release scope (documented above instead).
- The launchd plist — local system configuration under `~/Library/LaunchAgents`.

## Open follow-ups
- **Wire the step-list into a live use site** — the certified component renders no
  real steps yet; the natural site is the agent-control step list (`#control-step-list`)
  in both surfaces.
- **Blocking red-blink tab dot** — the sidecar top-bar tab dots should go red +
  blinking (vs green) when the panel holds a blocking/needs-human message
  (approval, blocked/failed job or step). Spec in the `queued-blocking-red-blink-dot`
  memory.
- **Visual check of the popout overlay** — the CSS positioning was not verified in
  a live extension; reload and confirm the overlay covers the chat (not the
  composer).
- **Per-step approval auto-open** — deliberately not added; the per-step approval
  lights the Agent Control dot (fail-closed). Can be added if auto-popping is
  wanted.
- **PR #270** is a held **draft**; link an issue and attach live-cert evidence
  before marking it ready.
