# Prompt: ResonantOS SDK Demo — Verify, Present, and Build an Add-on

**Audience:** any AI-agent harness (OpenAI Codex, Manolo's DeepSeek-harness, oh-my-pi-harness, or equivalent)
**Status of this prompt:** ready to run

## Purpose

This prompt supports three uses, in order:

1. **Verify the demo works** (Tom) — run the prebuilt demo and its tests, and
   confirm the capability model is enforced.
2. **Present the demo** (Manolo, community leader) — run the preinstalled
   **Augmentor** (Manolo's DeepSeek Harness) and the **Grok-Build** add-on as a
   live walkthrough.
3. **Build an add-on** (any developer) — author a basic harness plugin for any
   target AI provider (the worked example is Grok-Build) using the same harness.

## 1. Verify the demo works

```bash
cd 2.0.0-alpha
node --test examples/sdk-prototype/sdk.test.mjs
node examples/sdk-prototype/run-demo.mjs examples/sdk-prototype/plugins/augmentor    # preinstalled Augmentor (Manolo's DeepSeek Harness)
node examples/sdk-prototype/run-demo.mjs examples/sdk-prototype/plugins/grok-build  # third-party add-on (agent-built)
```

Confirm:

- **9 / 9 tests pass.**
- In each `run-demo` run, deny-by-default holds: ungated tools are blocked,
  Public-only grants let Public tools run while Privileged tools stay blocked,
  and consequential work stops at `propose` (prepare, not commit).

## 2. Present the demo

Run the two `run-demo` commands above as a walkthrough: show the preinstalled
**Augmentor** (Manolo's DeepSeek Harness), then the **Grok-Build** add-on built
through the SDK, and point out the three grant scenarios.

## 3. Build an add-on

Using the ResonantOS preinstalled add-on harness (the prototype SDK), author a
**basic harness plugin for a target AI provider**. The requester names the
provider (for example "Grok-Build" or "DeepSeek"); use that name to fill the
`<slug>` placeholder below. The plugin must load, validate, and run through the
harness with deny-by-default capability enforcement, and it must mirror the
production harness contract for that provider.

Context: the harness already ships with the one first-party **Augmentor**
(`addon.augmentor`) — Manolo's DeepSeek Harness — preinstalled and pre-granted.
You are adding a new, third-party add-on beside it — not replacing it.

### Provider naming

| Thing       | Pattern                 | Grok-Build example    | Claude Code example   |
| ----------- | ----------------------- | --------------------- | --------------------- |
| slug        | lowercase kebab         | `grok-build`          | `claudecode`          |
| plugin `id` | `addon.<slug>`          | `addon.grok-build`    | `addon.claudecode`    |
| folder      | `plugins/<slug>/`       | `plugins/grok-build/` | `plugins/claudecode/` |
| tool prefix | `<slug>` with `-` → `_` | `grok_build`          | `claudecode`          |

### Inputs to read first

All paths are relative to the `2.0.0-alpha` repository root.

1. `examples/sdk-prototype/README.md` — the harness authoring guide and capability
   rules.
2. `examples/sdk-prototype/sdk.mjs` — the harness runtime API you build against.
3. `examples/sdk-prototype/plugins/augmentor/plugin.json` and `plugin.mjs` — the
   preinstalled first-party Augmentor (Manolo's DeepSeek Harness); read it for context.
4. `examples/sdk-prototype/plugins/hello-resonant/plugin.json` and `plugin.mjs` —
   the **format** to model your manifest and entry module on.

A reference implementation already exists at
`examples/sdk-prototype/plugins/grok-build/`; reproduce its **structure** for
your target provider rather than copying it verbatim.

### Constraints (non-negotiable)

1. Plugin `id` must be `addon.<slug>`.
2. Requested capabilities: `network`, `providers`, `agent-delegation`. Never
   request a Core-only capability (`policy-override`, `trust-root-modify`,
   `credential-export`, `ground0-replace`).
3. Every tool's `requiredCapabilities` must be a subset of
   `requestedCapabilities`.
4. The entry module must export `default.activate(context)` returning
   `{ tools, onEnable?, onDisable? }`.
5. Do not modify `sdk.mjs`, `run-demo.mjs`, `sdk.test.mjs`, or any existing
   plugin. Write to a fresh folder `examples/sdk-prototype/plugins/<slug>/`.

### Scope (what "done" means)

Create the plugin with these two tools (using the tool prefix above):

- `<prefix>.status` — reports the local provider runtime health/availability.
  Requires `network` (Public).
- `<prefix>.run_task` — runs a delegated prompt and returns the completion.
  Requires `network` (Public) + `providers` (Privileged) +
  `agent-delegation` (Public). It must stop at the **prepare/propose** boundary
  (`context.propose(...)`), never "commit" directly.

### Steps

```bash
cd 2.0.0-alpha
# 1. Read the inputs above.
# 2. Write plugin.json + plugin.mjs in the <slug> folder.
# 3. Validate:
node examples/sdk-prototype/run-demo.mjs examples/sdk-prototype/plugins/<slug>
# 4. Confirm the three scenarios:
#    - no grants: both tools blocked
#    - network + agent-delegation: status runs, run_task blocked (needs providers)
#    - network + providers + agent-delegation: both run; run_task returns "proposed"
```

### Acceptance

- [ ] Plugin loads without validation errors.
- [ ] `status` returns `{ ok: true }` when `network` is granted.
- [ ] `run_task` returns `{ ok: false }` when `providers` is not granted.
- [ ] `run_task` returns `{ ok: true, result.status: "proposed" }` with full
      reviewed grants (prepare, not commit).
- [ ] `node --test examples/sdk-prototype/sdk.test.mjs` still passes.
- [ ] No Core-only capability was requested.

### Do NOT

- Edit `sdk.mjs`, `run-demo.mjs`, `sdk.test.mjs`, or the `hello-resonant`
  reference plugin.
- Request a Core-only capability.
- Add a live network call, credential, secret, or external dependency; the demo
  is offline and the `run_task` path stops at `propose`.
- Invent harness APIs that do not exist in `sdk.mjs`.

### Out of scope

- Changing the preinstalled harness itself.
- Integrating the plugin into the full ResonantOS Alpha runtime (a follow-up
  against the production SDK in `src/sdk/addons`).
