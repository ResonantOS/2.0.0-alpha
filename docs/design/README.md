# Design

Community-contributed design reference for ResonantOS. Nothing here is
imported by the runtime; these are the visual contracts and source material
for anyone building panels, add-ons, or app-shell UI.

## Resonant Extension Framework V0.1

The framework package lived here during design; on ADR-038 acceptance
the proposal moved to [`docs/architecture/ADR-038-resonant-extension-framework.md`](../architecture/ADR-038-resonant-extension-framework.md)
and the specifications moved to
[`docs/addons/resonant-extension-framework/`](../addons/resonant-extension-framework/README.md).
See that folder for the canonical list of framework specs, conflict
documents, and resolution records.


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
