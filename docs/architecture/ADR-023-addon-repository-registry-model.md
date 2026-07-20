# ADR-023: Add-on Repository And Registry Model

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: Add-on registry
- Decision date: 2026-04-28
- Alpha note: Bundled manifests, provenance, and explicit grants apply.
  External registry distribution is deferred.

## Decision

ResonantOS core and ResonantOS add-ons must be separated at the repository and distribution level.

The core repository owns:

- ResonantOS shell
- core agents
- Living Archive host service
- provider fabric
- Rust privileged services
- add-on SDK contracts and validators until the SDK is extracted
- built-in add-on catalog UI

The core repository must not become the permanent home for experimental add-on implementations.

The target repository model is:

- `resonantos-vnext`: core application and host contracts
- `resonantos-addon-sdk`: extracted SDK package, manifest schema, validator, examples, and developer docs
- `resonantos-addons-registry`: curated registry metadata, reviewed manifests, release references, hashes, signatures, compatibility data, and review state
- creator-owned add-on repositories such as `creator/resonantos-addon-name`
- optional personal collection repositories such as `ManoloRemiddi/resonantos-manolo-addons` for private or experimental add-ons before curation

## Why

ResonantOS is meant to become a modular platform, not a monorepo of every possible tool.

Keeping add-ons in creator-owned repositories preserves:

- clear ownership
- isolated release cycles
- smaller core review scope
- safer community experimentation
- a clean path from sideloaded add-on to curated add-on

The official registry should decide what appears as curated and recommended. It should not require every add-on source repo to live inside the ResonantOS organization.

## Rules

- Every add-on must have a manifest that passes SDK validation.
- Add-on source code may live in any repository controlled by its creator.
- Sideloaded add-ons are never implicitly trusted.
- Curated add-ons must be reviewed, versioned, signed or hash-pinned, and listed in the curated registry.
- The curated registry stores metadata and release references, not necessarily source code.
- The core app may include catalog manifests for preview or first-party add-ons, but those manifests do not imply installation or trust.
- No add-on is installed, enabled, or granted capabilities by default for public or external alpha builds unless explicitly approved by release policy.
- Add-on binaries, sidecars, or service bundles must be installed per add-on, not silently embedded into the core shell.
- Personal add-ons can live in personal repositories and remain sideload-only until accepted into a curated registry.
- Community add-ons may become curated when they satisfy manifest, security, documentation, compatibility, and maintenance requirements.

## Add-on Promotion Path

### Sideloaded

The user installs a local manifest or repository reference.

Rules:

- provenance: `sideloaded-unverified`
- no default grants
- clear warning in UI
- user must approve every requested capability

### Community

The add-on is publicly available in a creator-owned repository.

Rules:

- still sideloaded unless listed by a registry
- may include docs, examples, and releases
- may request registry review

### Curated

The add-on appears in an official or trusted curated registry.

Rules:

- provenance: `curated-signed` or stronger
- reviewed manifest
- hash-pinned or signed release artifact
- compatibility range declared
- recommended grants may be shown, but the user can inspect and revoke them

### First-Party

The add-on is maintained by the ResonantOS organization.

Rules:

- still capability-gated
- still versioned independently where practical
- may be listed as curated by default
- does not bypass Living Archive, provider, wallet, or filesystem boundaries

## Repository Layout For Add-ons

A creator-owned add-on repository should use this shape:

```text
resonantos-addon-example/
  resonantos-addon.json
  README.md
  CHANGELOG.md
  LICENSE
  src/
  dist/
  scripts/
  tests/
  docs/
```

Required files:

- `resonantos-addon.json`
- `README.md`
- license declaration
- install/run instructions
- capability rationale

Recommended files:

- tests
- screenshots
- threat model notes for privileged capabilities
- release checksums
- examples

## Registry Record

A curated registry entry must include:

- add-on id
- name
- current version
- manifest URL or embedded manifest
- source repository URL
- release artifact URL
- checksum or signature metadata
- provenance tier
- compatibility range
- requested capabilities
- recommended grant presets
- review status
- last reviewed date

The registry is the discovery layer. The add-on repository is the implementation layer.

## Registry V0 In Core

Until the external registry repository exists, the core app owns a minimal registry snapshot model in `src/sdk/addons`.

V0 rules:

- a registry entry is a catalog/discovery object, not an installation record
- installation, enablement, and granted capabilities come only from the host-owned `AddOnInstallation` state
- bundled catalog manifests resolve to `bundled-catalog` entries
- sideloaded manifests resolve to `sideloaded-local` entries
- sideloaded entries are forced to `sideloaded-unverified`, `unverified`, and `unreviewed`, even if their manifest claims stronger provenance
- no V0 registry helper may install, enable, or grant an add-on
- no bundled add-on may be installed, enabled, or granted by default unless a future release policy explicitly supersedes this rule

The V0 registry model intentionally avoids marketplace behavior. Its job is to give the shell, SDK, and future curated registry a shared vocabulary for provenance, review state, artifact references, and install state.

## Alpha Policy

For the current internal alpha:

- core ResonantOS is shareable for preview
- add-ons are catalog concepts, not bundled trusted installations
- Obsidian, Browser, Terminal, OpenCode, OpenClaw, Hermes, and Audio2TOL should remain disabled unless explicitly installed and granted
- experimental add-on implementations may remain in the core repo temporarily while contracts settle
- before public alpha, those experimental add-ons should move to separate repositories or be hidden behind an internal/developer catalog flag

## Consequences

- Add-on development can proceed without bloating core ResonantOS.
- Community members can publish their own add-ons without organization-level repo access.
- ResonantOS can support sideloading early while preserving a path to curated distribution.
- The SDK must become stable enough for external authors before public community add-ons are encouraged.
- The release process must distinguish core app artifacts from add-on artifacts.

## Implementation Notes

Near-term work:

- add an alpha build workflow for core app artifacts
- add a documented alpha distribution profile
- keep the V0 registry snapshot as a discovery layer separate from host-owned installation state
- add an internal/developer catalog mode after the registry model is stable
- keep add-ons unavailable by default for external reviewers
- extract `src/sdk/addons` to a package when the SDK reaches V1 stability

Related documents:

- `ADR-006: Add-on Runtime & SDK`
- `ADR-018: Add-on SDK V0`
- `docs/release/ALPHA_DISTRIBUTION.md`
