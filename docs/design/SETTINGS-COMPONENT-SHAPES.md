# Browser-first Settings component shapes

This contract covers the extension Settings workspace and provider modal. It
normalizes component shapes without changing the runtime palette, typography,
control density, or the compact skin in other workspaces.

The [ROSI v3 extraction](rosi-design-system/reference/ui-extraction-browser-v3.md)
provides historical Button, Card, and Input shape guidance. The ROSI README describes
v0.2; it is historical context, not a command to replace the runtime palette.
This scoped contract does not resolve the extraction's outstanding brand signoff.

| Role | CSS token | Radius |
| --- | --- | --- |
| Text, search and select fields | `--settings-radius-input` | 12px |
| Action buttons and model-option controls | `--settings-radius-action` | 12px (shares the input radius) |
| Textareas, nested rows, compact cards and nav items | `--settings-radius-compact` | 16px |
| Standard cards and disclosure containers | `--settings-radius-card` | 20px |
| Setup, personalization and modal panels | `--settings-radius-panel` | 22px |
| Subnav container | `--settings-radius-subnav` | 24px |
| Badges and circular markers | `--settings-radius-pill` | 999px |

The extraction contains conflicting button guidance. This Settings contract
uses 12px rounded rectangles for actions, matching adjacent fields. Its historical
pill-button rule does not apply to Settings actions. Navigation items and compact
rows use the 16px scale step; they do not introduce additional 14px, 15px or 18px values.

Implementation lives in
`browser-first/resonantos-side-panel-extension/src/styles/main-workspace/settings.css`.
The later `responsive.css` compact-skin rules must not override these Settings
shapes. Existing color, border and density rules remain in effect. Keep visible
keyboard focus distinct from hover using the existing accent token.

Run `npm run test:browser-first:settings-shapes` with stable Chrome installed
(or set `RESONANTOS_LIVE_CHROME_PATH`). The live-browser CI lane runs this check
and retains screenshots with its evidence. CI uses headless Chrome; local runs
use a visible window unless `CI=true` is set. It renders actual extension modules
and styles with synthetic, network-isolated data at 390/768/1280px; it does not
replace extension/bridge certification. It also injects the old important
override and a pill-button override to verify that the regression detector rejects both.

When changing these rules, check actual computed styles in Chrome: Start Here,
Profile, Providers (including its modal), Routing, Appearance and Bridge Target.
Compare the same viewport and state before and after; inspect textareas, nested
rows, badges, enabled/disabled actions, keyboard focus and narrow layouts.
