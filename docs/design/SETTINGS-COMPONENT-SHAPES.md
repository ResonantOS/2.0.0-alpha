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

`npm run test:browser-first:settings-shapes` checks computed radii and keyboard
focus in the rendered Overview, Appearance, and Provider modal at 390, 768, and
1280px for Comfortable, Compact, and Touch density. It uses synthetic,
network-isolated data and waits for the asynchronous Appearance preference load
before each measurement. At those same states it checks applicable 40px and
42px control minimums, preserves the compact Overview action's smaller height,
and confirms the textarea remains multiline. It also injects the original
important card override and a pill-button override to confirm both are caught.
The check saves Overview and Provider modal screenshots for each width in its
Comfortable state; the live-browser CI lane retains those artifacts. CI uses
headless Chrome; local runs use a visible window unless `CI=true` is set. Use
stable Chrome or set `RESONANTOS_LIVE_CHROME_PATH` to its executable.

The automated check covers only those rendered sections and assertions. A human
still needs to inspect Start Here, Profile, Providers, Routing, Appearance, and
Bridge Target in live Chrome for text wrapping, clipping, action states, nested
rows, badges, keyboard focus, and narrow-layout fit. It does not replace
extension or bridge certification.

When changing these rules, check actual computed styles in Chrome: Start Here,
Profile, Providers (including its modal), Routing, Appearance and Bridge Target.
Compare the same viewport and state before and after; inspect textareas, nested
rows, badges, enabled/disabled actions, keyboard focus and narrow layouts.
