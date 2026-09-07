# Add-On Lifecycle Uninstall Design

## Current lifecycle

The current add-on lifecycle is driven by `installed` and `enabled` booleans,
not by a complete status-state transition table. `InstallationStatus` is
`"available" | "installed" | "enabled" | "disabled" | "degraded" |
"update-available" | "incompatible"` and does not include `uninstalled`
(`src/core/contracts.ts:79`). `AddOnInstallation` stores `installed`,
`enabled`, `status`, `grantedCapabilities`, `privateProviderProfileIds`,
optional `config`, notes, verification fields, provenance, and source
(`src/core/contracts.ts:2180`).

| Current state | Allowed transition | Mutation |
| --- | --- | --- |
| Missing installation record | None | The toggle returns the draft unchanged (`src/modules/addons/controller.ts:63`). |
| Not installed, usually `available` | Install and enable | Sets `installed = true`, `enabled = true`, `status = "enabled"`, and replaces notes with an install note (`src/modules/addons/controller.ts:67`). |
| Installed and enabled | Disable | Sets `enabled = false`, `status = "disabled"`, and notes that the add-on was disabled without uninstalling (`src/modules/addons/controller.ts:72`). |
| Installed and not enabled, usually `disabled` | Re-enable | Sets `enabled = true`, `status = "enabled"`, and replaces notes with a re-enable note (`src/modules/addons/controller.ts:76`). |
| Enabled with status such as `degraded` | Disable | Because the branch checks only `enabled`, the toggle disables it and overwrites status with `disabled` (`src/modules/addons/controller.ts:72`). |
| Installed but not enabled with status such as `degraded`, `update-available`, or `incompatible` | Re-enable | Because the branch checks only `installed` and `enabled`, the toggle re-enables and overwrites status with `enabled` (`src/modules/addons/controller.ts:76`). |

Capability chips toggle one matching `CapabilityGrant` in place and recompute
status from `enabled`/`installed`; they do not uninstall or clear grant records
(`src/modules/addons/controller.ts:91`). Reviewed setup through
`grantAddonCapabilities` has install as a side effect: it sets `installed =
true`, `enabled = true`, grants selected capabilities, and sets status to
`enabled` (`src/modules/addons/controller.ts:110`). Add-on config writes merge
new keys into `AddOnInstallation.config` and keep existing keys
(`src/modules/addons/controller.ts:140`).

The Add-ons workspace exposes Install, Disable, or Enable as the primary
action; there is no Uninstall control (`src/modules/addons/AddOnsWorkspace.tsx:93`).
`App.tsx` wires those controls only to `toggleAddonInstallation`,
`toggleAddonCapabilityGrant`, `grantAddonCapabilities`, and `updateAddonConfig`
(`src/App.tsx:2418`). `updateRuntimeState` persists the changed state after
each mutation (`src/App.tsx:614`), and browser-preview persistence writes the
whole runtime state under `resonantos-vnext.runtime-state` in `localStorage`
(`src/core/runtime.ts:102`, `src/core/runtime.ts:1369`).

Gaps:

- There is no `uninstalled` status in the contract (`src/core/contracts.ts:79`).
- There is no uninstall mutation or UI path in `src/modules/addons/`; grep finds
  only disable copy and tests that use "uninstalled" informally.
- Disabled add-ons keep `grantedCapabilities`, `privateProviderProfileIds`, and
  `config` because disable only flips `enabled` and `status`
  (`src/modules/addons/controller.ts:72`).
- `grantAddonCapabilities` implicitly installs and enables an add-on
  (`src/modules/addons/controller.ts:121`).
- The issue cites `host_state.rs:466`, but this repository has no `*.rs` files.
  The Alpha boundary in this checkout is the Node bridge, and the ownership
  contract states `src-tauri/src/` is not present here
  (`docs/architecture/MODULE-OWNERSHIP.md:87`).
- `src/core/defaults.ts` creates default installation records from manifests
  passed into `buildDefaultState`; it does not enumerate the bundled catalog
  (`src/core/defaults.ts:886`, `src/core/defaults.ts:902`). The bundled catalog
  is loaded from `public/addons/index.json`, with a smaller development index in
  `public/addons/dev-index.json` (`src/core/runtime.ts:130`).

Browser-first host persistence has add-on status and execution settings, but no
host-owned `AddOnInstallation` install/grant persistence. The add-on host routes
include `/addons/status` and `/addons/execution-settings`
(`browser-first/host/addon-delegation-host-service.mjs:10`). The host stores
only Hermes/OpenCode `localCliExecution` in
`BrowserFirst/Settings/addon-execution.json` and appends operator events to
`BrowserFirst/Settings/addon-governance-audit.jsonl`
(`browser-first/host/addon-delegation-service.mjs:402`). `/addons/status`
returns hard-coded add-on status records with requested/granted capability
arrays (`browser-first/host/addon-delegation-service.mjs:1745`), not persisted
install records.

## Target lifecycle

Add `uninstalled` to `InstallationStatus` in `src/core/contracts.ts`. Uninstall
is allowed from `installed`, `enabled`, `disabled`, `degraded`,
`update-available`, and `incompatible`. It is not meaningful from `available`
or already `uninstalled`, so those transitions should be idempotent no-ops that
append no duplicate audit entry.

The uninstall mutation must be atomic for one `AddOnInstallation`:

- Set `status = "uninstalled"`.
- Set `installed = false`.
- Set `enabled = false`.
- Clear `grantedCapabilities` to `[]`.
- Clear `privateProviderProfileIds` to `[]`.
- Delete `config` rather than replacing it with `{}`.
- Append a note such as `Uninstalled; capability grants and add-on config were cleared. User data was retained.`
- Apply any add-on-specific coupled state, such as disabling the Hermes channel,
  in the same state update (`src/modules/addons/controller.ts:81`).

Clearing the grant list is better than preserving grants with `granted = false`
because uninstall should leave no stale grant record, no stale scope, and no
record of withdrawn manifest capabilities. Reinstall can reconstruct fresh
requested capabilities from the current manifest, which is already how
`createInstallationSnapshot` rebuilds grant entries from `manifest.requestedCapabilities`
while preserving only capabilities present in the current manifest
(`src/core/policies.ts:321`). UI that needs to preview requested capabilities
for an uninstalled add-on should read `AddOnManifest.requestedCapabilities`,
not old installation grants (`src/core/contracts.ts:531`).

Reinstall after uninstall must be a fresh grant flow: installing sets installed
state, but prior grants, private provider profile ids, and config are not
remembered. If the user chooses a reviewed grant preset again, it should be
applied from the manifest or current preset, not from pre-uninstall state.

## Data policy

Default policy: uninstall deletes add-on config and capability/private-provider
links, but retains user data with a warning.

In this codebase, add-on config means `AddOnInstallation.config`, including:

- Hermes `profileHome` (`src/modules/addons/HermesAddonPanel.tsx:33`).
- Telegram `channelId`, `allowedChatIds`, and `preferredModel`
  (`src/modules/addons/TelegramAddonPanel.tsx:58`).
- Obsidian `vaultPath`, `lastVaultRefreshAt`, `queuedIntakes`, and
  `queuedNoteIndex` (`src/modules/addons/ObsidianAddonPanel.tsx:107`,
  `src/modules/addons/ObsidianAddonPanel.tsx:267`).

In this codebase, user data means content or records outside
`AddOnInstallation.config` that were created by a human, copied from a human
source, or emitted as reviewable add-on output:

- External source files, such as an Obsidian vault path selected or pasted by
  the user; the Obsidian panel is read-only toward the vault and copies selected
  notes into intake (`src/modules/addons/ObsidianAddonPanel.tsx:310`).
- Living Archive raw intake and review records. The memory schema defines
  `INTAKE/` as raw artifacts and add-on outputs, `REVIEW/` as draft updates and
  verification evidence, and trusted `AI_MEMORY/wiki/` as host-mediated only
  (`browser-first/host/memory-schema.mjs:34`).
- Obsidian note intake artifacts and ingest requests written through
  `archive_write_intake_artifact` and `archive_request_ingest`
  (`src/modules/addons/ObsidianAddonPanel.tsx:115`,
  `src/core/runtime.ts:1055`).
- Browser-first add-on draft, delegation, and result artifact records under
  `BrowserFirst/AddOnDrafts`, `BrowserFirst/Delegations`, and
  `BrowserFirst/DelegationArtifacts`
  (`browser-first/host/addon-delegation-service.mjs:390`).
- Telegram channel message history if and when a host implementation exists.
  The current `browser-first/host` grep found no `telegram_service_*` route
  handlers; the shared runtime has helper names for those commands, and the
  browser fallback records only a configured marker for the bot token rather
  than the token itself (`src/core/runtime.ts:211`, `src/core/runtime.ts:232`).

Confirmation warning copy:

> Uninstall clears this add-on's grants, private provider links, and settings.
> It keeps source files, Living Archive intake/review records, delegation
> packets, drafts, and result artifacts. Review those records separately before
> deleting them.

"Also delete user data" should be an explicit second step after uninstall, not
the default. That second step must show the exact app-owned paths it will
delete, must never delete external source roots such as an Obsidian vault by
default, and must refuse if a path cannot be proven inside an app-owned root.

## Audit record

Keep one audit entry per successful uninstall in the existing add-on governance
audit log:
`BrowserFirst/Settings/addon-governance-audit.jsonl`
(`browser-first/host/addon-delegation-service.mjs:406`). The current writer
creates the parent directory, appends one JSON object per line, and chmods the
file to `0o600` (`browser-first/host/addon-delegation-service.mjs:444`). Existing
tests assert that real setting changes append entries with `addonId`, `field`,
`from`, `to`, and `at`, and that no-op writes do not append extra entries
(`browser-first/test/addon-delegation-service-error-handling.test.mjs:123`).

Recommended uninstall audit fields:

- `at`: ISO timestamp.
- `event`: `addonUninstalled`.
- `addonId`: manifest id.
- `source`: `bundled` or `sideload`.
- `previousStatus`: status before uninstall.
- `previousInstalled`: boolean before uninstall.
- `previousEnabled`: boolean before uninstall.
- `clearedCapabilities`: capability names cleared.
- `clearedPrivateProviderProfileIds`: count only, not ids.
- `configDeleted`: boolean.
- `userDataRetained`: boolean.
- `alsoDeleteUserDataOffered`: boolean.
- `actor`: `human`.

The controller-level mutation should return enough structured detail for the
bridge/UI caller to append this audit entry without putting secrets or raw user
content into the log.

## Kernel-adjacent add-ons (ADR-026)

ADR-026 says the minimal kernel owns add-on registry, installer, lifecycle,
launcher, and capability grant broker, while Augmentor Chat and Living Archive
are bundled recommended add-ons that must be disableable and replaceable
(`docs/architecture/ADR-026-minimal-kernel-replaceable-default-addons.md:28`,
`docs/architecture/ADR-026-minimal-kernel-replaceable-default-addons.md:40`).
It also says no non-kernel add-on is installed, enabled, or granted by default
(`docs/architecture/ADR-026-minimal-kernel-replaceable-default-addons.md:133`).

The catalog source discrepancy matters: `src/core/defaults.ts` does not list the
catalog; `public/addons/index.json` does. In the bundled catalog, the
kernel-adjacent default system-slot providers are:

- `addon.augmentor-chat`: recommended `primary-agent` and `chat-interface`
  default provider (`public/addons/augmentor-chat.json:112`).
- `addon.living-archive`: recommended `memory-system` default provider
  (`public/addons/living-archive.json:106`).

Rule: uninstall is blocked for bundled recommended default-provider add-ons
while they are the active provider for a kernel-adjacent system slot; disable is
still allowed. Sideloaded add-ons are always uninstallable. Once a replacement
owns the affected slot, the bundled default can be uninstalled because ADR-026
requires replaceability.
The typed selection lives in `ResonantShellState.activeSystemSlotProviderIds`, `activeSystemSlotProvider` consults it first, and changing a selection is a later task.

Build-testable predicate:

```ts
const uninstallBlocked =
  installation.source === "bundled" &&
  manifest.systemSlots?.some(
    (slot) =>
      slot.role === "default-provider" &&
      slot.recommended === true &&
      activeSystemSlotProviderIds[slot.id] === manifest.id,
  ) === true;
```

If `installation.source === "sideload"`, the predicate must return false even
when the sideloaded add-on provides a system slot.

## Open questions for the release owner

1. Should `uninstalled` appear as a catalog badge distinct from `available`?
   Recommended default: yes, because `available` means never installed while
   `uninstalled` means previously removed with an audit record.
2. Should uninstall stop or cancel currently running local add-on work first?
   Recommended default: yes, attempt a best-effort stop before the state
   mutation and block uninstall if the runtime cannot reach a safe stopped
   state. **Answered 2026-09-07 (release owner): yes — implemented in task 2.** Scope of the stop hook in task 3: the desktop shell has no delegation-cancel primitive, and task workspaces are listable but carry no run status; the in-flight registry covers Logician script and hook runs, browser engine install, and Hermes install. The Hermes dashboard, OpenCode service start/stop, OpenCode task execution from the Delegation workspace, task-workspace creation from chat, and browser sessions are not stopped by uninstall in task 3; the host-side running-delegation check lands with task 4.
3. Which surface owns active system-slot provider selection?
   Recommended default: add an explicit typed field under shared runtime state
   before enforcing kernel-adjacent uninstall blocking. **Answered 2026-09-07 (release owner): yes — implemented in task 2.**
4. Should "also delete user data" delete app-owned delegation and intake records
   together or as separate choices?
   Recommended default: separate choices, because Living Archive intake/review
   has a different retention policy than delegation artifacts.
5. Should uninstall audit retention be user-prunable?
   Recommended default: retain governance audit indefinitely for Alpha/Beta and
   add export/prune policy later.

## Scoped build plan

1. Contracts and state semantics (S)
   - Files: `src/core/contracts.ts`, `src/core/policies.ts`,
     `src/core/runtime.test.ts`.
   - TDD first: add `rebaseStateOnManifests preserves uninstalled state without restoring grants` and `createInstallationSnapshot rebuilds fresh grants after reinstall`.
   - Implementation: add `uninstalled` to `InstallationStatus`; ensure rebasing
     does not turn `uninstalled` back into `available` or restore cleared grants.

2. Controller uninstall mutation (M)
   - Files: `src/modules/addons/controller.ts`,
     `src/modules/addons/controller.test.ts`.
   - TDD first: add `uninstallAddon clears grants provider profiles and config`,
     `uninstallAddon disables enabled add-ons and appends an uninstall note`,
     `uninstallAddon disables Hermes channel in the same mutation`,
     `uninstallAddon is a no-op for available add-ons`,
     `uninstallAddon blocks active bundled default system-slot providers`, and
     `uninstallAddon allows sideloaded system-slot providers`.
   - Implementation: export `uninstallAddon(manifest, activeSystemSlotProviderIds, updateRuntimeState)` and return an audit payload or callback input with the fields named above.

3. UI control and confirmation (M)
   - Files: `src/modules/addons/AddOnsWorkspace.tsx`,
     `src/modules/addons/AddOnsWorkspace.test.tsx`, `src/App.tsx`. **Implemented in task 3 (2026-09-07).**
   - TDD first: add `shows Uninstall for installed add-ons`, `confirmation copy states config is deleted and user data retained`, `shows a disabled Uninstall with the slot reason for blocked active bundled defaults`, and `calls uninstall handler only after confirmation`.
   - Implementation: add an Uninstall secondary action in the detail panel,
     show the warning copy from this design, and wire the handler through
     `App.tsx`.

4. Browser-first host audit integration (S)
   - Files: `browser-first/host/addon-delegation-service.mjs`,
     `browser-first/host/addon-delegation-host-service.mjs`,
     `browser-first/test/addon-delegation-service-error-handling.test.mjs`,
     `browser-first/test/addon-delegation-host-service.test.mjs`.
   - TDD first: add `add-on uninstall appends governance audit entry without secrets` and `uninstall audit route requires addon-record-write`.
   - Implementation: add a narrow audit-write route or reuse an existing
     add-on record-write path to append `addonUninstalled` entries to
     `addon-governance-audit.jsonl`.

5. Optional user-data deletion flow (M)
   - Files: `src/modules/addons/AddOnsWorkspace.tsx`,
     `src/modules/addons/AddOnsWorkspace.test.tsx`,
     `browser-first/host/addon-delegation-service.mjs`,
     `browser-first/test/addon-delegation-service-error-handling.test.mjs`.
   - TDD first: add `also delete user data lists app-owned paths before delete`,
     `also delete user data refuses external vault paths`, and `also delete user data deletes selected delegation artifacts only after confirmation`.
   - Implementation: expose a second-step cleanup flow limited to app-owned
     roots and keep external source files out of scope.

6. Docs update (S)
   - Files: `docs/addons/addon-lifecycle-uninstall-design.md`,
     `docs/README.md`, `docs/augmentor-tester-runbook.md`,
     `docs/RELEASE_NOTES_BETA1.md`, `docs/ROADMAP.md`.
   - TDD first: run `npm run -s docs:check` before and after doc edits.
   - Implementation: link the design note from the documentation router and
     update beta.2/deferred wording after implementation lands, keeping beta.1
     notes clear that disable is not uninstall.
