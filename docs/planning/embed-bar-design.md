# ResonantOS bar for embedded harness panels

Status: design approved by Tom Pennington in chat on 2026-10-09. Testing branch
`testing/augmentor-embed-sidecar`; not for merge into `dev` as is.

## Goal

When the side panel shows an external harness's own interface, starting with
Manolo Remiddi's Augmentor embed panel, ResonantOS stays one click away without
any change to that interface. The harness panel looks exactly as it does
standalone; ResonantOS adds one slim row above it.

## Decisions

1. **Placement.** The bar is one row rendered by the ResonantOS side-panel page,
   above the frame that holds the harness panel. It is never drawn inside the
   harness frame. The harness frame takes all remaining height.
2. **When it shows.** In embed mode the bar shows all controls. In normal mode it
   shows only when the bridge reports that an embedded assistant is available,
   and then only the Assistant switch, because the normal chat header already
   has the workspace button and status. With no embedded assistant available,
   normal mode renders exactly as it does today.
3. **Controls in embed mode, in order:**
   - **Workspace** opens, focuses or closes the main workspace tab. It reuses
     `createMainWorkspaceToggle`, and `aria-pressed` reflects whether the
     workspace is visible, matching the existing `#workspace-toggle`.
   - **Assistant** offers "Augmentor" and "ResonantOS". The choice is stored in
     `chrome.storage.local` under `resonantos.agentView` (`embed` or `normal`)
     and the side-panel document reloads so the chosen mode boots cleanly. An
     explicit `?agentView=` query keeps precedence, as it does today.
   - **Page** sends one `augmentor-context` message,
     `{ source: "resonantos", page: { title, url } }`, for the page the side
     panel is attached to, resolved the same way existing page capture resolves
     it. Title and address pass through the existing `safeContextText` and
     `safeContextUrl`. Nothing is sent when the ResonantOS site permission for
     that site is blocked or cannot be read; the bar shows a short inline notice
     instead. The serialized context stays within 16,000 bytes. The harness
     sends no result for context, so the bar confirms locally with
     "Page shared".
   - **Approvals** shows the count of pending Agent Control approvals, using a
     read path the extension already has. Clicking it opens or focuses the
     workspace. If no such read path exists without a new bridge route, this
     control is omitted and the plan records why.
   - **Status** reflects the relayed `augmentor-status`: online and idle, busy,
     or offline. It has a text label for assistive technology and no animation
     under `prefers-reduced-motion`.
4. **Availability.** A new capability-gated route, `GET /embed/status`
   (`addon-runtime-control`), returns `{ available, profile }` and never a
   credential.
5. **Launchers outside the side panel.** A new command,
   `open-resonantos-workspace` (suggested key Alt+Shift+W), and a toolbar
   right-click item, "Open ResonantOS workspace", both open or focus the
   workspace tab. The item needs the `contextMenus` permission.
6. **Look and access.** At most 36 px tall; icon buttons with tooltips and
   accessible names; fits a 320 px side panel; visible keyboard focus; Escape
   closes the Assistant menu. Colors come from a dark-only token set, because
   both panels the bar sits on are dark whatever the system theme. (Amended
   2026-10-10 after the live proof showed a light bar above dark panels.)
7. **Boundaries.** The bar never receives bridge or harness credentials. It
   talks to the harness only through the existing host-page relay allowlist
   (`augmentor-prompt`, `augmentor-new-chat`, `augmentor-focus`,
   `augmentor-context`). No new message types.

## Failure behavior

If the embed session or the harness fails to load, the bar still renders with
Status offline, and Workspace and Assistant still work, so the user can always
switch back to ResonantOS chat. A failed availability probe in normal mode hides
the bar rather than showing an error.

## Out of scope

Keeping several copies of the harness panel in sync, showing the harness inside
the workspace, page control by ResonantOS on the harness's behalf, and voice.

## Testing

- Unit tests (node:test): bar rendering and control behavior, mode and
  availability selection, the blocked-site path sending nothing, the background
  command and toolbar-menu handlers, `GET /embed/status`, and the route
  capability audit.
- Live proof (`browser-first/test/embed-live.mjs`, run by hand against the real
  harness): at 420 px the bar sits above the harness panel; Status reaches
  online; Workspace opens the workspace tab; Page on a local fixture page,
  followed by a prompt asking for the page title, returns the fixture title;
  Assistant switches to ResonantOS chat and back. Screenshots of both modes.
- Mutation proof that breaking the site-permission guard turns its test red.
