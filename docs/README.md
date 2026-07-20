# ResonantOS Documentation Router

Use this page after reading the canonical contributor path:
[AGENTS.md](../AGENTS.md), [README.md](../README.md),
[INSTALL.md](../INSTALL.md), and [CONTRIBUTING.md](../CONTRIBUTING.md).

Current implementation facts belong in [Status](STATUS.md). Accepted release
scope, area, and delivery state belong in
[Project 2](https://github.com/orgs/ResonantOS/projects/2) under the rules in
[Project Governance](PROJECT_GOVERNANCE.md).

## Understand The Alpha Runtime

- [Alpha Runtime Boundary](architecture/ALPHA_RUNTIME_BOUNDARY.md) defines the
  extension, bridge, authentication, generated files, and excluded systems.
- [Product Guide](product/PRODUCT_GUIDE.md) explains stable user workflows.
- [Capability Matrix](reference/CAPABILITY_MATRIX.md) maps implemented,
  experimental, and deferred capabilities to tests and issues.
- [Augmentor Future List acceptance matrix](augmentor-future-list-acceptance-matrix.md)
  maps every Augmentor feature family to its canonical issue, status, required
  tests/proof, and safety boundary.
- [Augmentor tester runbook & proof checklist](augmentor-tester-runbook.md) walks a
  community tester from install to a proof checklist, with the human-only boundaries.
- [Side-Panel Command Reference](reference/COMMANDS.md) lists the supported
  Augmentor slash commands and their safety boundaries.
- [Status](STATUS.md) records the latest verified snapshot.

## Change The Extension

Start with [browser-first component instructions](../browser-first/README.md),
then read [Module Map](architecture/MODULE_MAP.md),
[Module Ownership](architecture/MODULE-OWNERSHIP.md), and the relevant entry in
the [Capability Matrix](reference/CAPABILITY_MATRIX.md).

## Change The Bridge

Start with [bridge component instructions](../browser-first/host/README.md),
then read the [Alpha Runtime Boundary](architecture/ALPHA_RUNTIME_BOUNDARY.md)
and [Module Ownership](architecture/MODULE-OWNERSHIP.md). Preserve bridge-token,
capability-token, loopback, secret, and human-only action boundaries.

## Change Provider Routing

Read [ADR-005: Provider Fabric Routing](architecture/ADR-005-provider-fabric-routing.md),
[Module Ownership](architecture/MODULE-OWNERSHIP.md), and the provider entries in
the [Capability Matrix](reference/CAPABILITY_MATRIX.md). Provider secrets remain
host-owned local state and must not cross into extension storage or logs.

## Change Agent Control

Read the browser-control sections of the
[Product Guide](product/PRODUCT_GUIDE.md), the
[Capability Matrix](reference/CAPABILITY_MATRIX.md), the
[Side-Panel Command Reference](reference/COMMANDS.md), and
[Module Ownership](architecture/MODULE-OWNERSHIP.md). Use the issue and Project 2
item to determine required live-browser proof and human-only actions.

## Change Living Archive

Read [ADR-007: Living Archive Boundaries](architecture/ADR-007-living-archive-boundaries.md),
[ADR-011: Living Archive Host Service](architecture/ADR-011-living-archive-host-service.md),
[ADR-012: Approval Policy](architecture/ADR-012-living-archive-approval-policy.md),
and [Module Ownership](architecture/MODULE-OWNERSHIP.md) before changing intake,
review, promotion, or trusted-memory writes.

## Change An Add-On

Read [ADR-006: Add-On Runtime SDK](architecture/ADR-006-addon-runtime-sdk.md),
[ADR-023: Add-On Repository And Registry](architecture/ADR-023-addon-repository-registry-model.md),
and [Module Ownership](architecture/MODULE-OWNERSHIP.md). For the separate
controlled Chromium package, use its
[component README](../addons/resonant-browser-host/README.md).

## Change Documentation

Keep current status in [Status](STATUS.md), future scope in
[Roadmap](ROADMAP.md) and Project 2, architectural decisions in the
[ADR Index](architecture/README.md), and stable workflows in the Product Guide.
Run:

```bash
npm run docs:check
npm run test:docs
```

Related contributor references:

- [Repository discipline catalog](../disciplines/README.md)
- [Browser research skill](addons/browser/skills/browser-research-session.md)
- [Icon system decision](product/ICON-001-resonantos-svg-system.md) and
  [icon asset index](../public/icons/README.md)
- [GitHub Action SHA-pinning policy](security-pipeline/sha-pin-policy.md)
- [Architecture templates, runbooks, and add-on skill contracts](architecture/README.md#contributor-contracts)

## Release The Alpha

Use [Alpha Distribution](release/ALPHA_DISTRIBUTION.md),
[Status](STATUS.md), the [Changelog](../CHANGELOG.md),
[Security Policy](../SECURITY.md), and Project 2. Release evidence must identify
the exact commands and live Chrome checks performed.

## Inspect Decision History

Use the [ADR Index](architecture/README.md). An ADR's decision status and its
applicability to the current Alpha are separate facts; historical and deferred
records do not redefine the runtime boundary.
