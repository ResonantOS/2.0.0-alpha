# Changelog

All notable ResonantOS changes are documented here. Current release state lives
in [docs/STATUS.md](docs/STATUS.md); planned work lives in
[docs/ROADMAP.md](docs/ROADMAP.md).

## [2.0.0-alpha.0] - Unreleased

### Added

- Chrome Manifest V3 side-panel extension with a new-tab main workspace,
  Augmentor chat, browser job monitor, Settings, Add-ons, and Living Archive
  surfaces.
- Local Node.js bridge with session authentication, scoped route capabilities,
  provider routing, Agent Control planning, memory services, diagnostics, and
  governed add-on delegation.
- Browser action planning and execution with persistent job state, page locks,
  approval states, and result evidence.
- Living Archive source intake, snapshots, review artifacts, verification,
  promotion, restore, and external memory-service/MCP examples.
- Typed add-on contracts, manifest validation, registry helpers, capability
  grants, and governed Hermes/OpenCode delegation.

### Changed

- The Alpha release boundary is the extension plus local bridge. Historical
  desktop and native systems are not Alpha runtime or release gates.
- Provider routing supports explicit model choice and policy-based automatic
  fallback without exposing provider credentials to extension pages or add-ons.
- The unreachable `primary-unavailable` provider-routing resolution reason was
  removed so the public type matches the reasons emitted by route resolution.

### Fixed

- Opening a new tab now resolves to `src/main-workspace.html`, and startup
  selects the `answer` workspace when no deep link is present.
- Browser-first side-panel control routing, chat startup rendering, composer
  keyboard behavior, clipboard handling, status presentation, and blank draft
  chat visibility.
- Provider bridge endpoint validation and scoped capability enforcement for
  privileged routes.

### Security

- Bridge requests require session authentication; privileged routes require
  scoped capability tokens, and capability bootstrap returns only requested
  capabilities.
- Wallet, signing, credential, payment, purchase, transfer, and related browser
  actions are blocked from autonomous execution.
- Add-ons cannot claim direct trusted-wiki write authority; Living Archive
  promotion remains a draft, verification, and review operation.
- Distribution scanning excludes generated bridge configuration and rejects
  provider-key-like strings, local founder paths, runtime state, and default
  trusted add-ons.

## [0.1.0] - 2026-06-02

Initial public source preview of the browser-first ResonantOS direction,
including the extension shell, local bridge boundary, browser control
foundation, Living Archive intake/review foundation, Provider Fabric, and Add-on
SDK contracts.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
