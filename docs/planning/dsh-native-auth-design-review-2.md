# DSH native authentication design review 2

This is the final design revision round. Both supplied reviews were read in
full as review data. All five new findings are accepted. No finding is deferred.
The approved decisions remain fixed: plugin-free native mode, a bridge-owned
child, memory-only tokens and cookies, disabled telemetry, and working plugin mode.
This record does not claim implementation or live certification.

Inputs under the parent checkout's `.resonant-rig/jobs/`:

- `specrev2-dsh-native-grok@1791927217.55037.16972.log`, new findings at lines 44, 46, and 48.
- `specrev2-dsh-native-deepseek@1791927217.55060.11037.log`, new findings at lines 52 and 53.

Repository evidence paths below are relative to this worktree. `scratch/`
means the parent checkout's `.resonant-rig/livepass-dsh02/prefix/node_modules/`.
Scratch package metadata and filesystem observations are supporting local data,
not repository authority. The inspected install has hoisted `.bin` links,
including `js-yaml -> ../js-yaml/bin/js-yaml.js`. It does not establish that
every npm layout nests `.bin` under the DSH package. The containment rule must
accept that link form when both link and target are inside the package root.

| finding | ACCEPTED or REJECTED | evidence file:line | spec change |
| --- | --- | --- | --- |
| Grok R2-1, Important: home equality conflicts with the DSH-home descendant ban. | ACCEPTED | `docs/addons/harness-adapter-demo.md:41` identifies ordinary DSH state. `docs/addons/harness-adapter-demo.md:105` identifies desktop state. `INSTALL.md:63` places the bridge default under the OS home. Revised rule: `docs/planning/dsh-native-auth-design.md:182`. No native runtime path validator exists yet. | Use a path table. Reject only equality with the OS home. Reject equality and descendants for both DSH homes. Add tests for each protected home, empty descendants, the valid default, and a sibling with a shared name prefix. |
| Grok R2-2, Important: blanket symlink rejection blocks npm layouts and misses writable ancestors. | ACCEPTED | `scratch/@deepseek-ai/dsh/package.json:14` declares its bin entry. `scratch/@deepseek-ai/dsh/package.json:24` declares js-yaml. `scratch/js-yaml/package.json:38` declares the target of the observed npm link. `browser-first/host/harness-credentials.mjs:17` shows the separate credential-file no-link rule. Revised package check: `docs/planning/dsh-native-auth-design.md:141`. | Allow contained npm links. Check each hop, target, parent directories, and ownership. Skip meaningless symlink mode checks. Reject escapes, dangling links, resolution cycles, and special files. Check ownership and group/other write bits on every ancestor through `/`. Test contained links, unsafe targets, and writable immediate and higher parents. Keep credential-file rules strict. |
| Grok R2-3, Important: browser chat keeps a retired compatibility session after child exit. | ACCEPTED | `browser-first/host/harness-host-service.mjs:351` refreshes only an absent cache or a changed generation/add-on ID. `browser-first/host/harness-boundary.mjs:50` removes retired sessions. `browser-first/host/harness-boundary.mjs:85` rejects removed references. `browser-first/host/harness-host-service.mjs:363` and `:371` also read the shared cache during an active call. | Add synchronous retirement notification and invalidate only the matching cached reference. Keep a local reference for each active call. Check liveness before caching an awaited session. A later user chat reauthorizes and creates a fresh session after cleanup. Add idle-exit, active-exit, stale-notification, cache-assignment-race, revocation, and unconfirmed-cleanup cases. Never replay the failed prompt or change governance to recover. |
| DeepSeek R2-1, Minor: startup and a turn do not test feedback-only telemetry. | ACCEPTED | `docs/addons/harness-adapter-demo.md:49` describes FEEDBACK_ONLY. Lines 51 through 55 describe rating/comment export, direct traffic, and no exporter in DISABLED mode. Line 61 confines product analytics to desktop. | Require exact-package profile inspection plus synthetic feedback-path observations. Observe exporter construction, export attempts, and direct traffic. Validate observation with an isolated enabled control that exports only to a local sink. Keep the managed child disabled. Missing observations leave the gate unproven. |
| DeepSeek R2-2, Minor: broad claims that plugin mode is unchanged obscure shared connector hardening. | ACCEPTED | `browser-first/host/agent-runtime-endpoint.mjs:30` defaults to global connectors. Lines 60 and 73 use them for HTTP and WebSockets. `docs/planning/dsh-native-auth-design.md:453` applies direct connections to both DSH modes. | State the shared proxy-bypass change in configuration and transport sections. Preserve plugin authentication, headers, grants, protocol, and output behavior. Retain the existing plugin tests and the proxy-sink test for both modes. |

Both reviewers upheld the prior startup-race rejection. The code still awaits
session creation at `browser-first/host/harness-host-service.mjs:352`, allocates
the turn at line 356, and starts the reply race at line 358. The
[review-1 record](dsh-native-auth-design-review-1.md) remains unchanged.

The [spec self-review](dsh-native-auth-design.md#self-review) records this round.
The auth, provider, Origin, and telemetry live gates remain pending. The new
runtime tests are acceptance requirements, not tests executed by this docs task.
