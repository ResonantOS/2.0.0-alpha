# ADR-022: Portable User State & Secure Vault Boundary

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: Local state
- Decision date: 2026-04-28
- Alpha note: The external user-state root applies. Encrypted vault persistence
  is deferred; Alpha provider credentials remain session-only or process
  environment inputs.

## Decision

ResonantOS must keep user-owned private state under one explicit **Portable User State Root**.

The default product target is:

```text
ResonantOS_User/
  Memory/
    HUMAN_KNOWLEDGE/
    EXTERNAL_KNOWLEDGE/
    AI_MEMORY/
    INTAKE/
    INDEX/
    MANIFESTS/
  Config/
    user-profile.json
    provider-profiles.json
    routing-policies.json
    addon-registry.json
    workspace-state.json
  Secrets/
    encrypted-vault.resvault
    recovery-hints.json
  Wallets/
    encrypted-wallet-vault.resvault
    public-wallet-registry.json
  Logs/
    audit-ledger.jsonl
    recovery-reports/
  Backups/
    snapshots/
```

This root is the user's portable ResonantOS identity, memory, configuration, and recovery package.
By default, ResonantOS creates this folder directly under the user's home directory, not inside protected platform folders such as macOS Documents/Desktop/Downloads. Users may explicitly choose another location, but automatic defaults must avoid recurring operating-system privacy prompts.

A user should be able to copy this folder to a new computer, install ResonantOS, select the folder, unlock the secure vault, and regain a working system in minutes.

## Why

- User private data must be easy to understand, back up, migrate, and protect.
- ResonantOS should not scatter user memory, provider configuration, secrets, wallet state, and logs across source folders or app internals.
- A sovereign local-first system must make ownership legible: the user should know where their system lives.
- Provider secrets and wallet keys must remain secure while still supporting migration.
- The Living Archive needs a canonical memory location that is independent from whichever folder was imported.

## Rules

- All user-owned private data belongs under the Portable User State Root unless there is a documented exception.
- Living Archive managed memory belongs under `Memory/`, not inside the imported source folder.
- Imported folders and Obsidian vaults are sources. The managed copy under `Memory/` becomes the active ResonantOS knowledge base after import.
- Provider profiles, routing policies, add-on registry, workspace state, and non-secret configuration belong under `Config/`.
- API keys, OAuth tokens, passwords, refresh tokens, wallet seed material, and signing keys must not be stored as plaintext configuration files.
- Secrets and wallet key material must be stored in encrypted vault files or OS secure storage mediated by Rust-side services.
- The system may cache convenience unlock material in the OS keychain, but the portable encrypted vault remains the migration authority.
- Add-ons and agents never receive raw filesystem access to the full root by default.
- Add-ons and agents access memory, secrets, wallet actions, and provider credentials only through scoped host-mediated APIs.
- Generated indexes may be copied as performance artifacts, but they must be rebuildable from memory sources, manifests, and logs.
- Audit logs and recovery reports must stay inside the Portable User State Root so migration preserves system history.

## Portable Versus Machine-Bound State

Portable state:

- Human Knowledge, External Knowledge, AI Memory, intake artifacts, manifests, and provenance
- provider profiles without raw secret values
- model routing policies and cost/fallback strategy
- add-on installation records and granted capabilities
- workspace/session metadata
- encrypted secret vaults
- encrypted wallet vaults and public wallet registry
- audit logs and recovery reports

Machine-bound state:

- installed application binaries
- local runtime binaries and model files unless explicitly imported as portable runtime assets
- OS keychain convenience entries
- hardware-backed key handles where the private key cannot be exported
- temporary build/cache folders
- per-machine window placement and device-specific preferences unless explicitly synced

Machine-bound state must be recoverable or clearly reconfigured during Setup or Recovery.

## Secure Vault Model

The secure vault is an encrypted portable container managed by Rust-side services.

Minimum requirements:

- encryption at rest
- explicit unlock flow
- user-controlled recovery method such as passphrase, hardware key, or future secure recovery mechanism
- per-secret metadata for provider, scope, owner, created time, last used time, and revocation state
- no raw secret values in TypeScript state, logs, manifests, add-on manifests, or normal configuration files
- export/import behavior that preserves encrypted payloads without weakening security

The vault may integrate with platform keychains:

- macOS Keychain
- Windows Credential Manager or DPAPI-backed storage
- Linux Secret Service or equivalent

Platform keychain integration is a convenience layer, not the only authority. A copied Portable User State Root must remain unlockable on another machine through the user's recovery method.

## Wallet Boundary

Wallet state follows `ADR-008`.

Rules:

- wallet key material belongs in `Wallets/encrypted-wallet-vault.resvault` or an equivalent Rust-mediated secure store
- public wallet registry metadata may be stored as JSON
- signing happens only through the Rust wallet service
- add-ons may request signing actions, but never receive raw signing keys
- every signing request must be capability-gated and auditable
- moving the Portable User State Root to a new machine must not silently enable unattended signing without reapproval policy checks

## Living Archive Boundary

This ADR supersedes source-local `_LivingArchive` storage as the long-term product target.

The current implementation may still create `_LivingArchive` under a selected source root during migration, but new architecture work must move toward:

```text
ResonantOS_User/Memory/
```

Target mapping:

- `Memory/HUMAN_KNOWLEDGE/` maps to ADR-013 Human Knowledge
- `Memory/EXTERNAL_KNOWLEDGE/` maps to ADR-013 External Knowledge
- `Memory/AI_MEMORY/` maps to ADR-013 AI Memory
- `Memory/INTAKE/` stores raw add-on outputs, imported libraries awaiting review, chat captures, and review queues
- `Memory/INDEX/` stores rebuildable search/index data
- `Memory/MANIFESTS/` stores library manifests, source-version ledgers, classification artifacts, and provenance manifests

The Living Archive must not recursively import its own generated memory, indexes, logs, or vault files as source data.

## Import And Migration Behavior

When importing a folder or vault:

- ResonantOS preflights the folder before copying
- noisy technical folders are flagged before import
- the user sees supported/skipped file counts and estimated storage cost
- copy-on-import remains the safe default
- browser-first move-on-import is available only through audited host preflight, exact human confirmation, content-hash verification, ledgered rollback, empty-directory/root preservation, and guarded source deregistration
- the managed copy lands under the Portable User State Root
- the original path is preserved as provenance
- the original folder is not considered the active memory source unless explicitly linked as a watched external source

When selecting an existing Portable User State Root on a new machine:

- Setup validates folder shape and manifest versions
- secure vaults remain locked until the user unlocks them
- missing machine-bound runtimes are reported as repair tasks
- indexes are validated and rebuilt if incompatible
- provider health is rechecked
- add-ons are marked degraded if their binaries or host integrations are missing

## Interfaces Constrained By This ADR

### PortableUserStateRoot

Must represent:

- absolute root path
- root version
- owner identity metadata
- creation and last migration timestamps
- folder health state
- manifest compatibility state

### SecureVault

Must represent:

- vault id
- vault type: `secrets` or `wallets`
- encryption metadata
- locked/unlocked state
- recovery method metadata
- secret or key reference ids, not raw values

### SecretReference

Must represent:

- stable reference id
- secret kind
- owning service
- capability scope
- revocation state
- last validation state

### PortableStateManifest

Must represent:

- ResonantOS version compatibility
- memory schema version
- config schema version
- vault schema version
- index compatibility
- migration history

### UserStateMigrationPlan

Must represent:

- source root
- target root
- required migrations
- rebuildable indexes
- machine-bound gaps
- user confirmations required
- rollback notes

## Consequences

- The next Living Archive implementation pass should add a user-state root resolver before adding more import features.
- Import destinations should migrate away from source-local `_LivingArchive` and into `ResonantOS_User/Memory`.
- Provider secret storage must be hardened into an encrypted portable vault instead of remaining a simple local app-state secret file.
- Wallet work must not begin until the secure vault boundary exists.
- Setup Agent and Resonant Engineer Agent must understand the Portable User State Root as the primary recovery object.
- UI should expose this as "Your ResonantOS Folder" or equivalent, not as a technical config directory.
- Backups should target the Portable User State Root, with warnings when machine-bound dependencies need reinstallation.

## Exceptions

Allowed exceptions:

- application binaries and caches
- generated build artifacts
- temporary files
- OS keychain convenience entries
- external source folders explicitly linked in reference or watch mode
- local model files explicitly kept outside the portable root because of size, license, or hardware placement

Every exception must be non-authoritative or recoverable from the Portable User State Root plus user action.
