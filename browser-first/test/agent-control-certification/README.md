# Agent Control Certification Fixtures (issue #223)

Deterministic certification gate for Agent Control safe click/type/scroll
fixtures and blocked high-risk paths.

Run:

```bash
node browser-first/test/agent-control-certification/run-certification.mjs
```

Artifacts are written to:

```text
output/runtime-evidence/agent-control-certification/AC-CERT-<timestamp>-<hash>/
```

## What it verifies

- a fresh run ID for every execution; every artifact is bound to that ID and
  fails the gate if stale or foreign-run;
- source hashes binding the certification to the exact fixture page and
  enforcement sources used;
- `node --check` for the harness and fixture sources;
- the focused certification tests from the issue handoff
  (`node --test browser-first/test/control-step-executor.test.mjs
  browser-first/test/agent-control-runner.test.mjs`) including assertion-content
  checks, so the gate fails if the declared certification claims stop executing;
- full `npm run test:browser-first` regression;
- optional live browser proof attach from `RESONANTOS_CERT_PROOF_DIR` (the
  live harness, issue #267, writes screenshots there); absence is recorded as
  `excluded`, never as a pass;
- sentinel scan of generated artifacts;
- nonzero process exit for any certification failure.

## Certification claims

Safe clicks/type/scroll complete with page-side effects; wallet connect,
public submit, and credential/payment typing stay blocked with the correct
boundary named and nothing actuated.
