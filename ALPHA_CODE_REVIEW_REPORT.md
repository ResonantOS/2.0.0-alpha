# ResonantOS 2.0.0 Alpha Code Review Report

## Report metadata

| Field | Value |
| --- | --- |
| Repository | `github.com/GeneraI44/2.0.0-alpha.git` |
| Branch reviewed | `dev` |
| Commit reviewed | `80dcd79677ad73b21dbaded12e0e9cd47aace82b` |
| Review date | 2026-08-03 |
| Primary runtime reviewed | Chrome MV3 extension plus the authenticated Node bridge |
| Change status | Review only; no repairs were implemented |

## Executive decision

**Recommendation: do not release this Alpha until the High-severity findings are repaired and regression-tested.**

The repository has useful architecture documentation, a substantial automated test suite, strong random bridge-token generation, timing-safe token comparison, and generally clear separation between the active Alpha runtime and future/supporting surfaces. However, the active extension and bridge currently violate several of their own key guarantees:

- bridge credentials can cross origin boundaries;
- human-only browser actions can be executed programmatically;
- password selections can reach a model and persistent chat storage;
- one browser command can activate the same action multiple times;
- local sidecars and proxy paths bypass parts of the authenticated bridge boundary; and
- secret-bearing agent output can be persisted without redaction.

These are release-blocking issues because they affect credentials, destructive actions, authentication flows, or irreversible browser operations. Passing the current unit and security-registry checks does not prove these paths safe.

## Plain-language walkthrough

These short explanations supplement the detailed findings below. They describe what each part does, what can go wrong, and the simple shape of the repair.

### R-01 — Bridge credentials

Bridge credentials are like passwords that let the browser extension talk to the local ResonantOS service. The problem is that the extension may send one bridge's password to the wrong bridge or another local service. The fix is to tie every token to one exact bridge and never reuse it when the bridge address changes.

### R-02 — Dangerous browser actions

This check is the last safety gate before the extension clicks something on a webpage. The problem is that a button such as "Delete account" or a neutral "Continue" inside a login form may look safe to the checker. The fix is to inspect the button and its surrounding page context and require you to take over for anything destructive or sensitive.

### R-03 — Unsafe search-form submission

This logic decides whether the extension can finish a search for you or must stop before submitting the form. The problem is that a dangerous POST form can be made to look like an ordinary search box. The fix is to allow automatic submission only for clearly safe GET searches and stop for anything that changes data.

### R-04 — Sensitive text selection

This path moves selected webpage text into the provider and chat workflow. The problem is that selecting a password or similar secret may send it to the AI provider and save it in chat history. The fix is to detect sensitive fields first and block their contents from leaving the page or being stored.

### R-05 — Duplicate browser actions

This code is meant to turn one instruction into one browser action in one selected frame. The problem is that one click can be sent twice and possibly sent to several frames. The fix is to choose one target and trigger exactly one action.

### R-06 — OpenCode sidecar

The OpenCode sidecar is a local helper process used for coding or agent work. The problem is that it receives more credentials than it needs and can be contacted without the same protection as the main bridge. The fix is to give it only the required credentials and require a short-lived authentication token for every connection.

### R-07 — Delegated-agent output

Delegated agents temporarily receive provider access and then return results to ResonantOS. The problem is that an agent can print a secret and that secret may be saved in mission files or shown in the extension. The fix is to redact all output before it is parsed, saved, or returned.

### R-08 — Hermes proxy

The Hermes proxy carries dashboard and API traffic between the browser and the Hermes service. The problem is that some routes and WebSockets may accept requests from an untrusted website. The fix is to require authentication and check the browser origin before forwarding anything sensitive.

### R-09 — Archive paths

The archive service decides which folders the system may read and change. The problem is that a path can look like it starts in the approved folder and then escape elsewhere after path cleanup. The fix is to clean and resolve the path first, then verify it remains inside the exact approved folder.

### R-10 — Provider endpoints

The provider service checks where the bridge is allowed to connect. The problem is that a caller can label a private or cloud-metadata address as a local service and bypass the normal protection. The fix is to enforce the network allowlist on the server and validate redirects and DNS results.

### R-11 — Alpha verification

The Alpha verification command is the release checklist for proving the project is safe to build and distribute. The problem is that parts of it do not run correctly on Windows, so a green result is not guaranteed on every supported machine. The fix is to make the checks cross-platform and run them on both Windows and Ubuntu.

### A-01 — Browser job scheduler

The scheduler starts queued browser jobs and should make sure each job runs once. The problem is that overlapping timer events can start the same job twice. The fix is to claim the job before waiting or processing begins and reject duplicate claims.

### A-02 — Cached tab context

Context hydration carries saved tab information from the background service into the page-action code. The problem is that the two sides use different field names, so valid context can be lost. The fix is to use one shared response format and test the real sender and receiver together.

### A-03 — Security certification

Security certification checks whether known privileged parts of the code have evidence and tests. The problem is that a new sensitive process, network, credential, or filesystem path could be added without being registered. The fix is to discover those paths automatically and fail when one has no security record.

### A-04 — Live CI filtering

The CI path filter decides which changes trigger the live Chrome certification tests. The problem is that some important bridge and extension files are not included, so a risky change may avoid those tests. The fix is to make all active runtime changes trigger the live certification lane.

### A-05 — Optional browser host

The optional browser host launches Chromium and performs browser actions when that separate package is enabled. The problem is that a caller may choose an arbitrary executable or falsely say that a sensitive action is safe. The fix is to allow only approved browser executables and have the trusted host decide when approval is required.

### A-06 — Shared application state

The shared React state is used by settings and chat screens to remember the user's current work. The problem is that a slow background operation can overwrite newer changes the user already made. The fix is to apply small, current-state updates instead of replacing everything from an old snapshot.

### A-07 — Engineer runner

The engineer runner checks whether required development commands stayed within the allowed files. The problem is that it records the file list before commands run, so a command can create an unapproved file afterward without being noticed. The fix is to check the file list again after each command and before reporting success.

### A-08 — Chat cancellation

The chat transport sends provider requests and should stop them when the user presses Stop. The problem is that Stop can change the screen while the provider request keeps running and using time or money. The fix is to connect Stop to real request cancellation and streaming.

### A-09 — Provider-secret status

Provider settings tell the user whether a provider secret was actually saved. The problem is that the screen can say "saved" even though only a placeholder was kept and the status disappears after reload. The fix is to securely save and verify the secret or clearly tell the user that it was not saved.

## Recommended repair order

1. Stop bridge credential leakage and rotate any credentials used during testing.
2. Enforce the human-only action boundary at the final content-script execution point.
3. Block password and other sensitive-field capture before any provider or storage call.
4. Make click, submit, frame selection, and job execution exactly-once.
5. Authenticate and isolate OpenCode, Hermes proxy, and delegated-agent output paths.
6. Repair path containment and provider endpoint validation.
7. Make the complete release gate run on both Windows and Ubuntu, then add adversarial regression tests for every item below.

---

## R-01 — Bridge credentials are not bound to an origin

**Severity:** High  
**Release status:** Blocker  
**Affected code:** `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js:110-124,204-215,271-274,313-315,401-481`

### The issue

### Where it fits in the system

The bridge is the controlled doorway between the Chrome extension and the local Node services. The extension uses these credentials to prove which client is calling and which sensitive route it is allowed to use.

When a user configures a different bridge URL but leaves its credential fields blank, the client can inherit the credentials generated for the default bridge. It also stores capability tokens in one module-global cache rather than associating them with the exact bridge origin and bridge instance that issued them.

The discovery flow sends the inherited bridge token to candidate `/status` endpoints before it has authenticated the endpoint. A service only needs to return the expected public JSON shape to be accepted for the next bootstrap step.

### What this would mean

A typo, stale saved URL, malicious local service, or attacker-controlled override can receive the main bridge token, capability-bootstrap token, or a capability token issued by another bridge. Possession of those tokens can turn an otherwise untrusted endpoint or local process into an authenticated bridge client.

This also means switching from bridge A to bridge B does not reliably create a new security boundary: tokens minted by A can be attached to requests sent to B.

### Confirmed reproduction

A blank-token override for `https://attacker.example` received headers equivalent to:

```text
X-ResonantOS-Bridge-Token: LOCAL_TOKEN
X-ResonantOS-Capability-Bootstrap-Token: LOCAL_BOOTSTRAP
```

After seeding a capability token on one bridge, a client for a second origin also sent the first bridge's capability token.

### Repair

1. Normalize every bridge URL to an exact origin: scheme, hostname, and effective port.
2. Bind the bridge token, bootstrap token, and capability-token set to that normalized origin and a server-instance identifier.
3. Never inherit credentials when an override origin differs from the generated origin. A blank override must mean “no credentials configured.”
4. Replace the global capability cache with a map keyed by normalized origin and authenticated bridge instance.
5. Clear the relevant cache whenever the target or authenticated server instance changes.
6. Probe `/status` without credentials. Attach secrets only after an authenticated challenge, pairing step, or pinned server-identity check.
7. Never send a remote target's credential to default localhost probe ports.
8. Remove or reverse the existing test that treats cross-port credential inheritance as intended behaviour.

### Regression criteria

- Origin B inherits no credentials from origin A.
- Localhost probes receive no remote-origin token.
- Explicit credentials for B are sent only to B.
- A capability minted by A is absent from every request to B.
- A forged `/status` response cannot trigger bootstrap-token disclosure.
- If same-origin inheritance is retained, it requires exact normalized-origin and bridge-instance equality.

---

## R-02 — Human-only destructive and login actions can bypass the guard

**Severity:** High  
**Release status:** Blocker  
**Affected code:** `browser-first/resonantos-side-panel-extension/src/lib/side-panel-command-router.js:89-93`, `browser-first/resonantos-side-panel-extension/src/lib/side-panel-browser-action-controller.js:86-89`, `browser-first/resonantos-side-panel-extension/src/content.js:428-457`

### The issue

### Where it fits in the system

Agent Control turns a user or model instruction into a browser event. This classifier is the final safety gate immediately before the extension emits a click into the page.

Direct side-panel click commands route to the page action without passing through the planner's destructive-term filtering. The final content-script guard inspects mainly the target element's text and attributes. It does not recognise several common destructive verbs, including `delete`, `remove`, `destroy`, `erase`, `revoke`, and `deactivate`, and it does not reliably inspect the surrounding form or page context.

### What this would mean

Buttons such as **Delete account** can be activated by automation even though the architecture declares destructive actions human-only. A neutral-looking **Continue** button inside a password, login, payment, or wallet form can also pass because the sensitive meaning is held by the surrounding form rather than the button label.

This is especially dangerous because page text and markup are untrusted input. A hostile page can deliberately label a destructive control in a way that evades the small element-only classifier.

### Confirmed reproduction

- `<button type="button">Delete account</button>` returned success.
- A neutral `Continue` button inside a password form also returned success.

### Repair

1. Create one shared action-boundary classifier used by planner commands, direct side-panel commands, reference-based actions, scheduled jobs, and final content-script execution.
2. Treat the content script as the last mandatory enforcement point; a caller-provided `userApproved` flag must never bypass hard boundaries.
3. Classify the target together with its closest form, labels, nearby fields, form method/action, page role, and login/payment/wallet/destructive context.
4. Expand destructive terms and use semantic attributes such as `autocomplete`, input type, ARIA roles, and associated labels.
5. Return a non-executable human-handoff result for destructive, login, payment, wallet, credential, and public-commit actions.
6. Do not convert a hard handoff into an “Approve once” job that can later be executed programmatically.

### Regression criteria

- Natural-language, slash-command, reference-based, and scheduled clicks cannot activate **Delete account**.
- A neutral button inside password, login, payment, or wallet context is blocked.
- `userApproved: true` cannot bypass a hard boundary.
- A benign `Continue` button outside sensitive context remains clickable.
- A blocked target receives zero pointer, mouse, or click events.

---

## R-03 — A search-looking POST form can be auto-submitted

**Severity:** High  
**Release status:** Blocker  
**Affected code:** `browser-first/resonantos-side-panel-extension/src/lib/content-field-safety.js:45-52`, `browser-first/resonantos-side-panel-extension/src/content.js:715-783`

### The issue

### Where it fits in the system

The form logic decides whether the extension may finish a read-only search for the user or must stop and request a human handoff before submitting a state-changing form.

An input with `type="search"` is treated as intrinsically safe to submit. The validation skips search fields, checks only a limited set of button labels, and does not require the surrounding form to use `GET`, have a safe destination, or possess genuine search semantics.

The implementation can dispatch Enter and then invoke `form.requestSubmit()`, which also risks duplicate submission.

### What this would mean

An untrusted website can disguise an irreversible or public action as a search form. The extension may then send a state-changing POST request without a human handoff. A neutral submit label such as **Go** is enough to avoid the current commit-term check.

### Confirmed reproduction

The following form returned success and fired its submit handler:

```html
<form method="post" action="/irreversible">
  <input type="search" aria-label="Query">
  <button type="submit">Go</button>
</form>
```

### Repair

1. Auto-submit only a verified search-only form using `GET`.
2. Resolve and inspect `action`, `method`, the chosen submitter, and any `formaction` or `formmethod` override.
3. Require genuine search semantics and reject forms containing credential, payment, personal-contact, public-commit, or destructive controls.
4. Treat every POST/PUT/PATCH/DELETE or ambiguous submission as human-only.
5. Use one validated submission mechanism. Do not dispatch Enter and then call `requestSubmit()` for the same command.
6. If the form is not unequivocally safe, fill the field but stop before submission and request human action.

### Regression criteria

- A search input inside a POST form emits no key or submit event.
- A valid search-only GET form submits exactly once.
- An unsafe `formaction` or `formmethod` override is blocked.
- A neutral **Go** label does not make a state-changing form safe.
- Forms containing credential, payment, contact, or public-commit controls remain human-only.

---

## R-04 — Selected passwords can be sent to a model and persistent chat

**Severity:** High  
**Release status:** Blocker  
**Affected code:** `browser-first/resonantos-side-panel-extension/src/content.js:904-919,951-953,1016-1029,1054-1062,1106-1119`, `browser-first/resonantos-side-panel-extension/src/lib/background-message-policy.js:179-187`, `browser-first/resonantos-side-panel-extension/src/lib/tab-context-controller.js:48-60`, `browser-first/resonantos-side-panel-extension/src/lib/chat-session-store.js:320-334`

### The issue

### Where it fits in the system

The selection and inline-assistant path transfers text from the current webpage into the provider/chat workflow. It is therefore a data-loss boundary, not just a convenience UI.

Selection extraction reads selected text from any input, including `type="password"`, without first applying the field-safety classifier. Opening the inline assistant can immediately send the selected value for summarization. The background policy truncates generic text but does not reject or redact it based on field type or context. The **Send** path can place it in normal persistent chat storage.

### What this would mean

A user selecting characters to inspect or replace a password can accidentally disclose that password to the configured provider. The same value can remain in local chat history, diagnostics, backups, or exported state after the page itself has been closed.

The risk also applies to OTPs, recovery codes, payment values, wallet secrets, and sensitive personal-contact fields if only their raw selection is considered.

### Confirmed reproduction

Selecting `ordinary-password-42` inside a password input and requesting the current selection returned the exact value.

### Repair

1. Classify the editable root before reading its selected value or showing the inline-assistant control.
2. Return no selection for password, credential, login, OTP, recovery, payment, wallet, and sensitive personal-contact fields.
3. Use input type, `autocomplete`, labels, form context, and nearby controls rather than relying only on one attribute.
4. Add a second rejection layer in the background message handler so a compromised or stale content script cannot submit marked-sensitive content.
5. Ensure sensitive selections never enter drafts, logs, `storage.local`, chat sessions, or provider requests.
6. Consider a bounded, explicit user-confirmation flow only for non-secret sensitive text; passwords and authentication secrets should remain unconditionally blocked.

### Regression criteria

- Selecting a password returns null/redacted context and shows no inline-assistant button.
- No bridge request, diagnostic entry, draft, or storage write contains the selected secret.
- Fields identified through `autocomplete`, label, or form context receive the same protection.
- Benign textarea and contenteditable selections continue to work.
- The background handler rejects a request marked as sensitive before calling `/augmentor/inline`.

---

## R-05 — One browser command can execute an action multiple times

**Severity:** High  
**Release status:** Blocker  
**Affected code:** `browser-first/resonantos-side-panel-extension/src/content.js:508-512`, `browser-first/resonantos-side-panel-extension/src/lib/browser-page-actions.js:19-26,241-263`

### The issue

### Where it fits in the system

The action executor is supposed to translate one approved intent into one DOM mutation and choose one deterministic frame when pages contain iframes.

For an accepted click, the content script manually dispatches a synthetic `click` and then calls `element.click()`, producing two click events. Separately, the frame dispatcher sends mutating actions such as click and type to every frame before choosing the first successful response.

### What this would mean

A single instruction can activate a button twice in the top page and twice again in every matching iframe. Counters may increment twice, toggles can switch on and immediately off, purchases or other state changes can be duplicated, and one-shot flows can advance unexpectedly.

### Confirmed reproduction

- One click command invoked a button handler exactly twice.
- With matching targets in frame `0` and frame `7`, both frames received the mutation.

### Repair

1. Use one canonical activation. If pointer/mouse-down/up events are needed for fidelity, finish by calling `element.click()` once and do not separately dispatch `click`.
2. Split multi-frame execution into discovery and mutation phases: query frames for candidates, choose one deterministic target, then execute only in that frame.
3. Return ambiguity rather than mutating several frames when multiple equally valid candidates exist.
4. Attach an action identifier and make the final executor idempotent for retries.

### Regression criteria

- One command invokes one button listener exactly once.
- A checkbox or toggle changes state exactly once.
- The final event sequence contains one `click`.
- Exactly one selected frame receives a mutation.
- Navigation and SPA handlers execute once.
- Retrying the same action identifier cannot repeat a completed mutation.

---

## R-06 — The OpenCode sidecar bypasses part of the authenticated bridge boundary

**Severity:** High  
**Release status:** Blocker when OpenCode delegation is enabled  
**Affected code:** `browser-first/host/run-bridge-minimal.mjs:185-195`, `browser-first/host/opencode-client.mjs:14-23,43-96`, `browser-first/host/opencode-session-host-service.mjs:63-81`

### The issue

### Where it fits in the system

OpenCode is a local delegated runtime used for coding or agent work. The bridge starts it as a child process and should give it only the minimum credentials and an authenticated path back to the bridge.

The bridge passes its complete process environment into `opencode serve`. The sidecar therefore receives unrelated provider, bridge, bootstrap, and cloud credentials. Its fixed-port API has no equivalent bridge authentication, and the client trusts any process that already owns the expected port and returns HTTP 200 from `/doc`.

Prompts and permission decisions are then sent directly to that service, and a reusable direct event/base URL is exposed.

### What this would mean

A local process can pre-bind the port, impersonate OpenCode, and capture prompts or permission replies. A compromised or misconfigured OpenCode process receives substantially more credentials than it needs and can print, retain, or misuse them. Clients can also bypass bridge capabilities by talking directly to the unauthenticated sidecar.

### Confirmed reproduction

A spawned child received sentinel values representing both an `OPENAI_API_KEY` and the main ResonantOS bridge token.

### Repair

1. Build a minimal explicit child environment; never pass `process.env` wholesale.
2. Supply only the provider credential required for the selected account and operation, preferably through a short-lived scoped broker credential.
3. Launch on an ephemeral port selected by the parent rather than reusing an unauthenticated fixed service.
4. Generate per-launch authentication and require it on every HTTP, SSE, and permission endpoint.
5. Verify a nonce or authenticated server identity tied to the child process; `200 /doc` is not proof of ownership.
6. Proxy events through the capability-gated bridge instead of exposing a direct reusable URL.
7. Track the exact child PID/instance and stop only that owned process during teardown.

### Regression criteria

- Unrelated provider, bridge, bootstrap, and cloud credentials are absent from the child environment.
- A fake pre-bound process is rejected and receives no prompt or permission reply.
- Direct API/SSE access without the per-launch credential fails.
- The extension receives no reusable unauthenticated sidecar URL.
- Teardown stops only the bridge-owned child instance.

---

## R-07 — Successful delegated-agent output can persist secrets

**Severity:** High  
**Release status:** Blocker when delegation is enabled  
**Affected code:** `browser-first/host/addon-delegation-service.mjs:933-1027,1122-1133,1327-1416,1459-1496,1589-1600`

### The issue

### Where it fits in the system

The delegation runner intentionally gives a child process temporary access to provider credentials, then converts the child's result into mission artifacts and extension messages. Output handling is the boundary that must prevent temporary secrets becoming durable data.

Provider credentials are intentionally added to delegated Hermes/OpenCode process environments. Error output is redacted, but successful stdout is returned and parsed without the same secret-scrubbing step. Parsed values can be written to mission/task artifacts and returned to the extension.

### What this would mean

A prompt, tool, accidental debug statement, or compromised delegated runtime can print a provider credential. That value may then appear in `finalSummary`, `changedFiles`, task files, diagnostics, extension UI, or backups under the user-state directory.

The child having temporary access to a credential does not justify making that credential durable or visible to the rest of the application.

### Repair

1. Treat all child stdout and stderr as untrusted, on both success and failure paths.
2. Sanitize output before parsing, logging, persistence, task-file updates, diagnostics, or return to the extension.
3. Recursively redact the exact current secret values in every string and structured field. Pattern matching should be only a secondary defence because many valid credentials do not look like `sk-*`.
4. Apply the same output pipeline to Hermes and OpenCode.
5. Bound output size and reject or quarantine malformed result schemas rather than storing arbitrary process output.
6. Where possible, replace raw provider keys with short-lived brokered credentials that cannot be reused elsewhere.

### Regression criteria

- A successful fake child can print an arbitrary sentinel credential, but the value appears nowhere in the response, artifacts, task files, logs, or diagnostics.
- Tests cover summaries, arrays, JSON/event output, stdout, stderr, and split output chunks.
- Success and failure paths use the same stable redaction marker.
- A final test scans every written artifact for the original sentinel.

---

## R-08 — Hermes mirror routes permit cross-origin proxying

**Severity:** Medium–High  
**Release status:** Blocker until upstream authentication assumptions are proven  
**Affected code:** `browser-first/host/bridge-server.mjs:114-121,270-277,339-405,551-631,963-968,1138-1146`

### The issue

### Where it fits in the system

The Hermes proxy connects browser dashboard pages and WebSockets to the upstream Hermes service. It exists for dashboard delivery and live communication, but it must not become an unauthenticated general-purpose local proxy.

On the default loopback setup, every mirrored prefix including `/auth` and `/api` is treated as open. The exemption applies to all HTTP methods and request bodies. WebSocket upgrades use the same open-path concept and do not validate browser `Origin`.

### What this would mean

A malicious website opened in the user's browser can issue a simple cross-origin POST to the local bridge. The bridge will forward it to Hermes even though the website has no bridge token. If Hermes accepts ambient cookies or lacks its own robust CSRF checks, the request can act with the user's authenticated session. WebSocket endpoints may also be reachable from an untrusted origin.

The repository comments that Hermes performs separate session authentication, so full account impact depends on that external implementation. The bridge-level CSRF and WebSocket primitive is nevertheless confirmed.

### Confirmed reproduction

A cross-origin `POST text/plain` to `/api/danger` was forwarded unchanged to a fake Hermes upstream and returned HTTP 200.

### Repair

1. Remove blanket token exemptions for mirrored prefixes.
2. If required for iframe startup, allow unauthenticated `GET`/`HEAD` only for an explicit list of passive static assets.
3. Protect `/api`, `/auth`, every state-changing method, and WebSocket upgrades with a short-lived dashboard ticket or authenticated bridge session.
4. Validate an exact allowed `Origin` for state-changing HTTP requests and every WebSocket upgrade. A loopback source address or CIDR allowlist is not browser-origin authentication.
5. Use one-time or narrowly scoped WebSocket tickets and reject missing, expired, or replayed tickets before opening the upstream connection.
6. Verify Hermes cookie and CSRF behaviour in an end-to-end browser test rather than assuming the upstream will reject the request.

### Regression criteria

- Cross-origin POSTs to `/api/*` and `/auth/*` return 401/403 and never reach upstream.
- Loopback and configured CIDRs do not automatically open privileged paths.
- Required passive iframe assets still load.
- WebSockets with an evil, missing, expired, or replayed origin/ticket are rejected before upstream connection.
- A valid bridge-origin WebSocket with a valid one-time ticket succeeds.

---

## R-09 — Archive zone containment is checked before path normalization

**Severity:** Medium–High  
**Release status:** Repair before enabling automated archive promotion  
**Affected code:** `browser-first/host/archive-review-host-service.mjs:4-18`, `browser-first/host/archive-review-service.mjs:120-143,343,586,685-734`

### The issue

### Where it fits in the system

The archive service is the filesystem boundary for intake, review, and promotion into trusted Memory zones. Its path check decides which directory a model or writer result is allowed to read or modify.

The archive helper checks whether the raw path starts with the expected zone and only then resolves `..` segments against the broader Memory root. Model- or writer-supplied promotion paths are not consistently revalidated immediately before use.

### What this would mean

A path that appears to begin inside the wiki can escape into another Memory zone after normalization. This breaks separation between intake, wiki, configuration, and other trusted areas. A compromised writer or crafted model output could read or overwrite files outside the approved wiki subtree while still staying inside the broad Memory root.

### Confirmed reproduction

```text
AI_MEMORY/wiki/../../CONFIG/poison.md
```

passed the raw-prefix check and resolved to `<Memory root>/CONFIG/poison.md`.

### Repair

1. Resolve against the specific allowed zone, not the broad Memory root.
2. Authorize the resolved result using `path.relative`; reject absolute results, `..` components, sibling-prefix tricks, and cross-drive results.
3. Canonicalize existing paths with `realpath`.
4. For a new file, canonicalize the nearest existing parent and reject symlink or Windows-junction escapes.
5. Validate generated `proposedPage` immediately after generation and again immediately before read, write, or promotion.
6. Apply the same helper to every writer-supplied and persisted path.

### Regression criteria

- Reject traversal using forward slashes, backslashes, mixed separators, absolute/UNC/drive paths, sibling-prefix paths, and NUL input.
- Reject reads or writes through a symlink or junction leaving the allowed zone.
- A writer-supplied traversal path cannot be stored or promoted.
- Valid nested intake reads and wiki promotions continue to pass.

---

## R-10 — Provider endpoints permit private-network and metadata SSRF

**Severity:** Medium  
**Release status:** Repair before allowing arbitrary provider accounts  
**Affected code:** `browser-first/host/provider-host-service.mjs:75-80`, `browser-first/host/provider-bridge-service.mjs:73-80,190-235,707,841-850`

### The issue

### Where it fits in the system

The provider-account service stores endpoint definitions and tests connectivity before the bridge sends provider requests. Its network policy is meant to prevent a user-controlled provider URL from turning the host into an internal-network scanner.

Provider endpoint validation trusts the caller-controlled `authType === "local-runtime"` field. That value bypasses normal rejection of HTTP, private, link-local, and cloud-metadata endpoints. Network requests also follow redirects without revalidating the destination.

### What this would mean

An authenticated client with provider-write capability can turn the bridge into a requester for services that are not normally reachable from a web page, including local administration interfaces and cloud metadata endpoints. Redirects can start at a public URL and finish at a private destination.

### Confirmed reproduction

An `openai-compatible` account declaring `authType: "local-runtime"` successfully retained:

```text
http://169.254.169.254/latest
```

### Repair

1. Do not infer network permission from a caller-controlled field.
2. Derive endpoint class from trusted server-side templates or an explicit host policy.
3. Always reject cloud-metadata and link-local ranges, even for local runtimes.
4. Permit only loopback or explicitly configured LAN targets for trusted local templates such as Ollama.
5. Resolve DNS before connecting and reject forbidden, mixed, mapped, alternate-numeric, and IPv6 address forms.
6. Disable redirects or manually validate and re-resolve every redirect target before the next request.
7. Apply the same validation before persistence and again immediately before connectivity tests or model requests.

### Regression criteria

- The reproduced metadata payload is rejected before persistence or network access.
- Forged `authType` values cannot weaken the endpoint policy.
- IPv4/IPv6 metadata, link-local, mapped IPv6, alternate numeric forms, and metadata hostnames are rejected.
- A public endpoint redirecting to a private target is rejected before the second request.
- Trusted loopback-only local-runtime configurations continue to work.

---

## R-11 — Alpha verification cannot run completely on Windows

**Severity:** Medium  
**Release status:** Release-confidence blocker  
**Affected code:** `scripts/verify-alpha.mjs:40-50`, `scripts/check-repo-hygiene.mjs:557-583`, `.github/workflows/alpha-build.yml:20`

### The issue

### Where it fits in the system

`verify:alpha` is the release gate that is supposed to prove the repository is clean, documented, built, and safe to distribute. It is part of the trust chain from source checkout to Alpha artifact.

`verify-alpha` starts child commands with `spawn("npm", ..., { shell: false })`, which does not resolve the Windows `npm.cmd` shim. Direct repository hygiene also fails because it unconditionally requires filesystem `O_NOFOLLOW`, which Node does not expose on Windows. The primary Alpha workflow runs only on Ubuntu, so neither limitation is caught before release.

### What this would mean

Windows contributors cannot execute the official “prove this Alpha is releasable” command. They may run selected tests manually and believe they have completed the release gate when important checks never ran. Ubuntu CI passing does not prove that the distributed Windows-oriented setup can install, verify, or operate safely.

### Repair

1. Select `npm.cmd` on Windows and `npm` elsewhere, or use a small cross-platform process helper without enabling a general shell.
2. Keep `shell: false` for commands influenced by input.
3. On platforms with `O_NOFOLLOW`, retain the current open-time protection.
4. On Windows, use `lstat`, `realpath`, nearest-existing-parent validation, reparse-point/junction rejection, and root containment before reading content.
5. Fail closed if the Windows scanner cannot establish containment; report the exact unsupported path rather than declaring all Windows verification unavailable.
6. Add `windows-latest` to the Alpha workflow and run `npm ci`, the full verifier, build, and focused browser-first tests there.

### Regression criteria

- `npm run verify:alpha` starts and completes on supported Windows and Ubuntu runners.
- The hygiene scanner rejects symlinks/junctions escaping the repository on both platforms.
- Normal tracked files scan successfully on Windows.
- CI publishes no Alpha artifact unless both supported platform gates pass.

---

## Additional confirmed issues

These should be scheduled after the release blockers above, or sooner if their affected feature is enabled.

### Where the additional issues fit in the system

- **A-01 scheduler:** coordinates queued browser jobs and is meant to ensure one job runs once even when timers and manual commands overlap.
- **A-02 context hydration:** carries cached tab context from the background service worker into the page-action layer so actions have the correct page state.
- **A-03 security certification:** is the static evidence gate that should detect new privileged execution, network, credential, and filesystem sinks.
- **A-04 live CI filtering:** decides which source changes trigger the stable-Chrome certification lane before merge.
- **A-05 optional browser host:** owns Chromium process launch and sensitive browser actions when that supporting package is enabled.
- **A-06 shared React state:** is the application-wide state store used by settings and chat controllers; stale whole-state writes can overwrite newer user changes.
- **A-07 engineer runner:** is the developer guardrail that reports whether required commands stayed within the allowed changed-file scope.
- **A-08 chat transport:** owns provider requests and streaming cancellation; Stop must reach this layer to prevent continued work and cost.
- **A-09 provider settings:** is the user-facing contract that says whether a provider secret was actually saved and will survive reload.

| ID | Severity and scope | Issue and meaning | Repair |
| --- | --- | --- | --- |
| A-01 | Medium, active extension | `browser-job-scheduler.js:69-96` has no single-flight guard and does not mark a job running until after several awaited operations. Concurrent ticks launched the same job twice. | Claim the job atomically before any await, add a tick mutex/idempotency key, and test two concurrent ticks against one queued ID. |
| A-02 | Medium, active extension | `background.js:306-320` returns `contextSnapshot`, while `browser-page-actions.js:334-350` reads `response.snapshot`. Valid cached tab context is discarded, and the unit test mocks the wrong schema. | Define one shared response contract, update the consumer, and add an integration test using the real background handler and consumer. |
| A-03 | Medium, release tooling | The security certification checks only hand-declared descriptor records. A new execution sink can remain unregistered while certification reports all descriptors clean. | Add source/AST discovery for process launch, network proxy, credential, and filesystem sinks; fail certification when a sink lacks a registry record and targeted test. |
| A-04 | Medium, active CI | `.github/workflows/agent-control-live.yml:17-33` omits core bridge, content, and action-control paths from its PR trigger. A regression may reach `dev` before the nightly live-browser run. | Expand the path filter to all transitive implementation and policy files, or run the stable-Chrome lane whenever extension/bridge code changes. Add a test that audits workflow coverage against the capability matrix. |
| A-05 | High if enabled; optional browser host outside current Alpha | `addons/resonant-browser-host/src/browser-host.mjs:21-36,92-103` accepts caller-selected `executablePath`; approval is enforced only when the caller voluntarily marks an action sensitive. A caller can launch an accessible executable or omit the flag when typing into a password field. | Remove arbitrary executable selection or restrict it to canonical allowlisted browser installations. Derive sensitivity from the action, selector, DOM context, and manifest policy inside the host. Authenticate JSON-RPC and test password/payment/destructive bypass attempts. |
| A-06 | High if activated; shared/development React surface | Async chat/settings controllers commit whole state objects built from stale snapshots. A slow diagnostic or streaming response can overwrite newer chat renames, pins, or settings. | Use reducer/functional patch actions, operation revisions, and cancellation. Test a slow request resolving after a concurrent state edit and prove the edit survives. |
| A-07 | High for developer guardrails | `scripts/engineer-runner.mjs:139-195` records changed-file scope before required commands and never recalculates it. A command can create an out-of-scope file while the runner still reports `verified`. | Re-snapshot and validate scope after every command and immediately before success. Avoid `shell: true` where possible and test a command that writes an unexpected file. |
| A-08 | Medium, shared/development chat | The shared transport does not pass an `AbortSignal`, and its “stream” adapter waits for the complete response. **Stop** changes local UI state but does not cancel cost-bearing provider work. | Thread an `AbortController` through runtime and transport, consume real response streams, cancel on Stop/unmount, and test that the network operation observes abort. |
| A-09 | Medium, shared/development settings | The provider-secret UI reports success after storing only a `__configured__` marker; reload then loses the apparent state. | Either save the secret through an authenticated vault route and verify its status, or clearly report that no credential was stored. Add save/reload/delete integration tests. |

## Verification performed

| Check | Result |
| --- | --- |
| `npm ci` | Passed |
| `npm test -- --run` | Passed: 37 files, 312 tests |
| `npx tsc --noEmit` | Passed |
| `npm run build` | Passed; Vite warned about an approximately 716 KB main chunk |
| Security registry certification | Passed: 18 configured descriptors; see A-03 for its coverage limitation |
| Browser-first suite on Windows | 829 total: 816 passed, 11 failed, 2 skipped |
| Optional browser-host suite | 13 total: 10 passed, 3 failed |
| Root and add-on dependency audits | 0 reported advisories at review time |
| Git worktree after review | Clean on `dev...origin/dev` |

The browser-first failures were primarily Windows/POSIX command assumptions and symlink-privilege cases. The optional-host failures included two tests requiring an installed Playwright Chromium binary and one Windows symlink-privilege case. These results are not evidence that the reproduced security findings are false; the findings were confirmed with focused tests or isolated executable reproductions.

## Minimum release acceptance checklist

- [ ] R-01 through R-07 are fixed with adversarial regression tests.
- [ ] R-08 is closed with an end-to-end browser-origin/CSRF/WebSocket test against the real Hermes authentication setup.
- [ ] R-09 and R-10 pass traversal, junction/symlink, redirect, DNS, IPv4, and IPv6 attack cases.
- [ ] Click, submit, frame selection, and scheduled-job execution are proven exactly-once.
- [ ] Sensitive field content is proven absent from provider requests, extension storage, logs, diagnostics, and mission artifacts.
- [ ] OpenCode and other sidecars receive a minimal environment and require per-launch authentication.
- [ ] `npm run verify:alpha` passes on clean Windows and Ubuntu runners.
- [ ] Stable-Chrome CI triggers for every active Agent Control and bridge implementation path.
- [ ] A manual Chrome test confirms human-only handoff for destructive, login, payment, wallet, credential, and public-submit actions.
- [ ] No Alpha artifact is published until all release-blocking checks are green.

## Suggested ownership split

| Area | Findings |
| --- | --- |
| Extension security and Agent Control | R-01 through R-05, A-01, A-02 |
| Bridge and delegated runtimes | R-06 through R-08 |
| Archive and provider security | R-09, R-10 |
| Build, release, and CI | R-11, A-03, A-04 |
| Optional/supporting surfaces | A-05 through A-09 |

## Final assessment

The project is not failing because it lacks tests; it is failing because several security properties are enforced in one layer but bypassed in another. The durable repair pattern is to make each boundary authoritative at the point of side effect:

- credentials must be origin- and instance-bound where requests are sent;
- browser safety must be enforced where DOM events are emitted;
- secret redaction must occur before any output is parsed or persisted;
- path and network containment must be checked after canonical resolution; and
- release certification must discover new privileged sinks rather than only checking registered ones.

Once those controls are centralized and the regression cases above are added, the existing documentation and test infrastructure should provide a much stronger base for an Alpha release.
