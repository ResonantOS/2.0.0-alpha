# SDK Demo — Test Results & Alpha Integration

**To:** Tom
**From:** ResonantOS development team
**Date:** 2026-09-17
**Subject:** The SDK demo was validated end-to-end by building a Grok-Build add-on; a follow-on test ports it to the current ROS-alpha via a self-contained offline loopback.

---

## 1. Summary

We validated the SDK demo prompt by handing it to an AI-agent harness with the
instruction "build a Grok-Build plugin for Resonant-OS." The harness produced a
correct, capability-safe **Grok-Build** plugin on the first pass — proving the
prompt is both **harness-agnostic** (any agent) and **provider-agnostic** (any
target provider, not just DeepSeek).

A follow-on test ported the plugin to a production `AddOnSdkManifest` and
confirmed it validates and registers against the current `packages/addon-sdk`
alpha. A third slice then proved the **runtime half** against a self-contained
offline loopback — not a live Grok TUI, and not the in-flight production
dispatcher.

> **Backend disclosure:** every provider call in these tests is a **host-mediated
> simulated loopback** on `http://127.0.0.1:3080`. No live Grok (or DeepSeek)
> API key is used. This is intentional: it proves host mediation and the OpenAI-
> compatible wire format without exposing a real credential.

## 2. The SDK demo prompt

[`sdk-demo-prompt.md`](../../prompts/sdk-demo-prompt.md) is a single, self-contained
recipe with three uses:

1. **Verify the demo works** (Tom) — run the prebuilt demo and its tests.
2. **Present the demo** (Manolo) — the community-leader walkthrough.
3. **Build an add-on** (Manolo / any developer) — author a basic harness plugin
   for any target provider.

It is **harness-agnostic** — any AI-agent harness (OpenAI Codex, Manolo's
DeepSeek-harness, oh-my-pi-harness, or equivalent) can run it — and
**provider-agnostic**: the target provider is a `<slug>` placeholder, with
DeepSeek and Grok-Build as the two worked examples.

## 3. Grok-Build test (prototype SDK)

We gave the prompt to an AI harness with the instruction "build a Grok-Build
plugin for Resonant-OS." The result was independently verified against the repo:

| Check              | Result                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Files created      | `examples/sdk-prototype/plugins/grok-build/plugin.json` + `plugin.mjs`                                |
| Plugin id          | `addon.grok-build`                                                                                    |
| Tools              | `grok_build.status` (`network`), `grok_build.run_task` (`network` + `providers` + `agent-delegation`) |
| Capability model   | Correct — `providers` is Privileged and gated; no Core-only capability requested                      |
| Prepare-not-commit | `run_task` calls `context.propose(...)` and returns `status: "proposed"`                              |
| Offline            | Simulated loopback (`http://127.0.0.1:3080`); no live calls or credentials                            |
| Tests              | `node --test examples/sdk-prototype/sdk.test.mjs` → **11 / 11 pass**                                  |
| Grant scenarios    | deny-by-default, Public-only, and reviewed-grants all behave correctly                                |

**What this proves:** the prompt generalizes beyond its original DeepSeek example —
the harness correctly derived the entire naming and capability chain from the
single "Grok-Build" input.

## 4. ROS-alpha integration test (validated)

The prototype SDK is a standalone Node harness; the production SDK lives at
`packages/addon-sdk` and uses the full `AddOnSdkManifest` schema. The test ran in
a clean worktree off `upstream/dev` (commit `7c913e1f`), exercising the canonical
`packages/addon-sdk` validator and registry. The original working branch was not
touched.

### 4.1 Manifest validation (production SDK)

| Check                 | Result                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Manifest authored     | `examples/addons/addon.grok-build.json` — full production shape (mirrors `addon.deepseek-harness.json`) |
| Schema validation     | `validateAddOnManifest` → valid, 0 errors                                                               |
| Capability check      | all requested capabilities valid; no Core-only capability                                               |
| Registry registration | `createAddOnRegistrySnapshot` registers `addon.grok-build`, no id collision                             |
| Regression            | full SDK vitest suite → **41 / 41 pass**, no regressions                                                |

Validation ran through the SDK's canonical functions (`validateAddOnManifest`,
`createAddOnRegistryEntry`, `createAddOnRegistrySnapshot`) via vitest —
`npm run validate:manifest` does not exist in this alpha.

### 4.2 Self-contained loopback demo (runtime half — PASS)

A later slice added a self-contained demo under `examples/grok-build-demo/` in
the same clean worktree. It proves the SDK round-trip **without** copying the
in-flight production dispatcher from `resubmit/deepseek-dispatcher`.

| File                        | Purpose                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `addon.grok-build.json`     | Copy of the validated production-shape manifest                                                 |
| `loopback-service.mjs`      | Tiny `node:http` server on `127.0.0.1:3080` — `GET /health` + `POST /api/v1/chat/completions`   |
| `run-demo.mjs`              | CLI: validates via canonical SDK, walks three grant scenarios, dispatches against live loopback |
| `run-with-loopback.mjs`     | Lifecycle wrapper: starts the loopback, runs `run-demo.mjs`, tears it down (no leaked `:3080`)  |
| `loopback-service.test.mjs` | 4 `node --test` assertions on the loopback wire format                                          |
| `ts-loader.mjs`             | Tiny ESM loader so the demo can import `packages/addon-sdk/src/*.ts` without a build pipeline   |
| `README.md`                 | Per-harness copy checklist for `addon.pi` / `addon.buzz` / `addon.claudecode`                   |

**What the demo proved (RESULT: PASS):**

1. Manifest validates through `packages/addon-sdk/src/validation` (`source: "sideload"`).
2. Three grant scenarios behave correctly (deny-by-default → Public → all requested).
3. `grok_build.status` reaches `GET /health` → `200 {status:"ok", model:"grok-build"}`.
4. `grok_build.run_task` posts an OpenAI-compat body to
   `POST /api/v1/chat/completions` (the production dispatcher path — **not**
   `/v1/chat/completions`) and parses a non-error completion.
5. Registry snapshot with `addon.reference-memory` + `addon.recursive-mas` +
   `addon.grok-build` has three distinct ids.

**Loopback wire tests:** `node --test examples/grok-build-demo/loopback-service.test.mjs`
→ **4 / 4 pass**. SDK suite after authoring: **41 / 41 pass**. No regressions.
End-to-end wall time with the lifecycle wrapper: ~1.5s.

**What this is not:** it does not use the production dispatcher
(`browser-first/host/external-agent-runtime-dispatcher.mjs`), which currently
lives only on the private `resubmit/deepseek-dispatcher` branch. The demo
re-implements the same capability-gate + wire-format pattern inline so the
proof does not couple to unmerged work. It also does not open a live Grok TUI
or the Chrome extension, and the loopback echoes the prompt rather than calling
a real model.

### How to run it

These files live in the clean `grok-alpha-test` worktree off `upstream/dev`
(commit `7c913e1f`). They are **not** part of the Tom docs PR.

Preferred (one command; the wrapper starts `:3080`, runs the demo, then kills
the loopback):

```bash
cd grok-alpha-test
node examples/grok-build-demo/run-with-loopback.mjs
node --test examples/grok-build-demo/loopback-service.test.mjs
```

Two-terminal fallback:

```bash
# Terminal 1
cd grok-alpha-test
PORT=3080 node examples/grok-build-demo/loopback-service.mjs

# Terminal 2
cd grok-alpha-test
node --experimental-strip-types \
     --loader "$(pwd)/examples/grok-build-demo/ts-loader.mjs" \
     examples/grok-build-demo/run-demo.mjs
```

> Worktree-only convenience: that checkout also has local `package.json` scripts
> `demo:grok-build` and `demo:grok-build:test`. Those scripts are **not** in
> upstream `package.json` and are **not** proposed for the docs PR — they mix a
> learning demo into the product package. Use the `node …` commands above.

### Findings from the demo (not blocking)

1. **`addonId` vs `manifestId`.** `createAddOnRegistryEntry` exposes the id as
   `addonId` (ADR-023). Some older paths still say `manifestId`.
2. **Sideload `reviewState` is always `unreviewed`.** `sourceDefaults` does this
   unconditionally for `sideloaded-local` / `developer-local`, even if
   `provenance.tier` is `curated-signed`. Documented, easy to miss.
3. **TS bare imports.** `packages/addon-sdk/src/*.ts` uses extension-less
   specifiers, so a tiny `ts-loader.mjs` is required for Node
   `--experimental-strip-types`. Vitest already resolves this. Follow-up only if
   the SDK ships on npm as source.
4. **Id-pattern tightness.** The dispatcher `validateAddonId` is a stricter
   lowercase-kebab regex than `validateAddOnManifest`'s `addon.` pattern. Not a
   blocker; flag for consistency when the host consumer lands.

None of these change the demo result. They are notes for the production SDK
work, not asks for this review.

## 5. What this is a template for

The same artifacts stand up any later harness add-on (`addon.buzz`,
`addon.claudecode`, `addon.pi`, …). The worktree `README.md` is the copy
checklist:

1. `<slug>.json` manifest (fails fast through `validateAddOnManifest`).
2. A loopback `service.mjs` speaking the same OpenAI-compat wire format
   (change the `MODEL` default).
3. A `run-demo.mjs` that exercises validate + capability gate + dispatch.
4. A `service.test.mjs` asserting the wire contract.
5. Optional: a `run-with-loopback.mjs` lifecycle wrapper so the demo is one command.

Only the loopback's behaviour and `providerRequirements.sharedProfiles` need to
differ per provider. The capability gate, the wire format, and the registry
snapshot are stable SDK surfaces.

## 6. Next steps (out of scope for the Tom send)

These remain **local / later** and are **not** required to review the planning
docs or the prompt:

1. Decide where the production-shape manifest lives permanently (sideload path
   `examples/addons/`, or bundled via `public/addons/` catalog index).
2. Wire a host-mediated runtime in the live ResonantOS alpha extension
   (production dispatcher + reviewed `providers` grant + Chrome load).
3. Hand the verified demo to Manolo to present.

Later, not for this review: whether the `/api/v1/chat/completions` wire format
should become an ADR so third parties can build against it without reading the
dispatcher; and whether the in-flight `#444` host consumer is the right shape
for `runtimeType: "agent-addon"` harnesses. Both wait on Tom's existing open
items — they are not new asks.

Live-extension visualization is blocked on landing those files plus the
production dispatcher — not on the SDK contract, which already holds.

---

**Related documents**

- [SDK demo prompt](../../prompts/sdk-demo-prompt.md)
- [ROS-SDK demo status & buildout report](05-tom-report-ros-sdk-demo-and-buildout.md)
- [Master implementation plan](03-master-implementation-plan.md)
