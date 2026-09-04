# Changelog

All notable ResonantOS changes are documented here. Current release state lives
in [docs/STATUS.md](docs/STATUS.md); planned work lives in
[docs/ROADMAP.md](docs/ROADMAP.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security

- OpenCode's local server now binds to an ephemeral loopback port with a bridge-minted credential; unauthenticated access to the former fixed port 4231 is closed, the bridge and side panel authenticate their requests and event stream, and orphaned servers are reaped on the next bridge start (#320).

### Changed

- The OpenCode cockpit handoff button is disabled while the server is credential-protected; governed cockpit access returns with the bridge reverse proxy (#321).

## [2.0.0-beta.1] - 2026-08-22

### Added

- Added Augmentor page understanding fixture coverage for article, PDF-like, and media-only pages (#218, #292 by @vonstegen, #310).
- Added inline counterpoint and explain-jargon actions with restricted-surface gating (#219, #295 by @vonstegen, #306).
- Added Alt+A inline panel and Alt+S page summary shortcuts with conflict handling (#241, #305).
- Added one-click and question-driven summary prompt contracts (#221, #307 by @vonstegen).
- Added cross-tab comparison with deterministic tab provenance (#220, #308 by @vonstegen).
- Added restart-safe session summary artifacts for Augmentor context continuity (#222, #309 by @vonstegen, #324).
- Added visible Augmentor mode and permission-state explanation in Settings (#230, #316).
- Added Augmentor workflow recipes for job search, travel, education, and product research (#237, #291 by @vonstegen, #304).
- Added ROSI design-system reference material under docs/design with credit to @michelnavarra (#208, #311).
- Added co-located controller and selector tests from @HenrikeGbinigie (#126, #273).

### Changed

- Refreshed the Augmentor acceptance matrix to match closed beta.1 issues and epics (#210, #211, #212, #213, #214, #215, #313).
- Documented add-on disable-versus-uninstall semantics, manual cleanup, and capability-chip meaning for testers (#215, #317).
- Changed OpenCode cockpit access to an execution-gated external-tab handoff with intent audit rather than an iframe (#323).
- Expanded the OpenCode governed workspace parity layer for host session management, live diffs, pickers, resume, and panel rendering (#303, #322).
- Added `/session` to the canonical side-panel command reference (#324).

### Fixed

- Fixed Agent Control stop/cancel so runs halt by their own job id and surface recovery state (#226, #301).
- Fixed summary templates after review so deterministic fallback labels match counterpoint and explain-jargon behavior (#219, #221, #312).
- Fixed cross-tab comparison review gaps around tab provenance and scope (#220, #308).
- Fixed OpenCode live-session rendering for the v1.18 event schema (#298).
- Fixed high-severity nanoid and undici dependency advisories (#297).
- Fixed provider/model dropdown readability on Chrome for Windows 11 (#206, #257).
- Fixed provider propagation into Provider Fabric routing and removal behavior (#207, #255).

### Security

- Hardened the human-only public-submit boundary so Agent Control cannot convert approval into executable public form submission (#240, #268, #281 by @Resonant-Jones, #314 crediting @GeneraI44).
- Enforced Agent Control field-typing boundaries for credential aliases including `passwd`, `pwd`, `pin`, `passkey`, and `security-code` (#224, #282 by @Resonant-Jones, #299).
- Added durable Agent Control trace artifacts with hardened secret redaction and visible step-counter proof (#225, #302).
- Added the add-on governance audit trail for execution toggles and honest capability-contract chips (#215, #317).
- Blocked protected system roots and `~/Library` in browser-first move-import paths at any depth (#319).
- Stabilized live Agent Control certification target discovery and job settling from @Resonant-Jones (#267, #286).
- Added safe click/type/scroll and blocked high-risk Agent Control certification fixtures (#223, #300).

## [2.0.0-alpha.0]

### Added

- Established the browser-first Alpha runtime as a Chrome Manifest V3 extension plus authenticated local Node.js bridge (#182, #209).
- Shipped Alpha foundations for Provider Fabric, Agent Control, Living Archive, Settings, Add-ons, and the side-panel workspace (#197, #207, #209).

### Changed

- Scoped release validation to the browser-first extension and bridge while excluding desktop shells, native hosts, terminal add-ons, and Audio2TOL (#182, #209).

### Fixed

- Stabilized first-run bridge setup, `/auth` mirroring, capability bootstrap diagnostics, provider propagation, and Chrome/Windows dropdown readability (#199, #200, #203, #204, #206, #207).

### Security

- Added session-only provider credential handling, scoped capability-token enforcement, renderer-controlled route rejection, and release-scope secret scanning (#85, #89, #143, #183, #184).
