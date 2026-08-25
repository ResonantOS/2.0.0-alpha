# Design

Community-contributed design reference for ResonantOS. Nothing here is
imported by the runtime; these are the visual contracts and source material
for anyone building panels, add-ons, or app-shell UI.

## Resonant Extension Framework V0.1 (proposal)

Design-stage proposal for evolving the internal Add-on SDK V0 (ADR-018) into
a governed add-on ecosystem: trust tiers, `.rpkg` packaging, certification,
signing, and a developer CLI. Staged here pending acceptance as ADR-038.

- [README](resonant-extension-framework/README.md) — package overview, staging, and terminology
- [Proposal](resonant-extension-framework/PROPOSAL-resonant-extension-framework.md) — draft for ADR-038
- [Add-on SDK spec](resonant-extension-framework/RESONANT_ADDON_SDK_SPEC_V0.1.md)
- [Package and manifest spec](resonant-extension-framework/ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md)
- [Certification and signing](resonant-extension-framework/ADDON_CERTIFICATION_AND_SIGNING_V0.1.md)
- [Developer workflow and CLI](resonant-extension-framework/ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md)
- [Implementation roadmap](resonant-extension-framework/IMPLEMENTATION_ROADMAP_V0.1.md)
- [Conflict resolutions](resonant-extension-framework/RESOLUTIONS_V0.1.md) — fork-author decisions on the 13 conflicts, carried into ADR-038
- [Open design conflicts](resonant-extension-framework/OPEN_DESIGN_CONFLICTS_V0.1.md) — 13 unresolved questions for external review

- [External review feedback](resonant-extension-framework/EXTERNAL_REVIEW_FEEDBACK_V0.1.md) — first external review of this package, with verification record
- [Code review feedback](resonant-extension-framework/ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md) — engineering review of the existing SDK and the public/third-party evolution path
- [Personal/local plugin governance](resonant-extension-framework/ADDON_PERSONAL_PLUGIN_GOVERNANCE.md) — fork policy proposal for personal/local add-ons (SDK required, Resonant review optional)
- [SDK reviewer agent](resonant-extension-framework/SDK_REVIEWER_AGENT_V0.1.md) — Augmentor/Logician review copilot for add-on certification

## ROSI — Resonant OS Interface design system

Contributed by Michel Navarra (PR #208). Extracted from the live Browser
extension UI into a token catalog.

- [README](rosi-design-system/README.md) — system overview and principles
- [ROADMAP](rosi-design-system/ROADMAP.md) — phased plan toward components and
  token-sync automation
- [CHANGELOG](rosi-design-system/CHANGELOG.md)
- [DEV-TEAM-REPORT](rosi-design-system/DEV-TEAM-REPORT.md) — contributor's
  build report
- [LICENSE](rosi-design-system/LICENSE)
- [Visual guide (HTML)](rosi-design-system/guide/rosi-design-system.html) —
  open in a browser to see every token rendered

### Tokens (source of truth)

- [tokens.json](rosi-design-system/tokens/tokens.json) — W3C Design Tokens
  format, 60 tokens across 12 categories
- [tokens.css](rosi-design-system/tokens/tokens.css) — the same tokens as CSS
  custom properties (`--rosi-*`)
- [Color palette v0.2](rosi-design-system/tokens/color-palette-v0.2.md) —
  current palette documentation
- [Color palette v0.1](rosi-design-system/tokens/color-palette-v0.1.md) —
  archived (Phosphor Green era)

### Reference (extracted source material)

- [ADR-017 — Resonant browser addon](rosi-design-system/reference/ADR-017-resonant-browser-addon.md)
- [DESIGN spec](rosi-design-system/reference/DESIGN-spec.md)
- [DESIGN — browser community](rosi-design-system/reference/DESIGN-browser-community.md)
- [UX-001 — ResonantOS app shell](rosi-design-system/reference/UX-001-resonantos-app-shell.md)
- [browser-live.css](rosi-design-system/reference/browser-live.css) — live CSS
  captured from the Browser module
- [base-styles.css](rosi-design-system/reference/base-styles.css) — base
  variables from the app shell
- [shell-styles.css](rosi-design-system/reference/shell-styles.css) — app
  shell layout styles
- [UI extraction notes](rosi-design-system/reference/ui-extraction-browser.md)
  and [v3](rosi-design-system/reference/ui-extraction-browser-v3.md)
- Screenshots: [browser home](rosi-design-system/reference/screenshots/screenshot01-browser-home.png),
  [browser agent](rosi-design-system/reference/screenshots/screenshot04-browser-agent.png)
