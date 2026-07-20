# ResonantOS Agent Operating Contract

## Repository Mission

Build and validate the ResonantOS 2.0.0 Alpha as a browser-first system. Work
from repository evidence: code, tests, canonical documentation, GitHub Issues,
and [ResonantOS Project 2](https://github.com/orgs/ResonantOS/projects/2).
Chat history, agent memory, local run artifacts, and generated evidence are not
repository authority.

## Alpha Runtime Boundary

The Alpha runtime has two components:

1. the Chrome Manifest V3 extension in
   `browser-first/resonantos-side-panel-extension/`; and
2. the authenticated local Node.js bridge launched by
   `npm run browser-first:bridge`.

The bridge binds to loopback by default and writes a generated URL and
credentials to
`browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js`.
That generated file is local state and must not be committed.

Desktop shells, native browser hosts, terminal add-ons, and Audio2TOL are not
Alpha runtime or validation requirements. See the
[Alpha runtime boundary](docs/architecture/ALPHA_RUNTIME_BOUNDARY.md).

## Required Reading Order

Read these files in order before changing the repository:

1. [AGENTS.md](AGENTS.md) - operating contract and safety rules.
2. [README.md](README.md) - product boundary and quick start.
3. [INSTALL.md](INSTALL.md) - complete local installation path.
4. [CONTRIBUTING.md](CONTRIBUTING.md) - branch, review, and validation workflow.
5. [docs/README.md](docs/README.md) - task-oriented documentation router.

Then read the component README and relevant architecture decision records for
the files you will change.

## Git And GitHub Rules

- Start from the current `dev` branch and create a focused feature branch.
- Open every pull request into `dev`.
- Never push directly to `dev` or `main`.
- Treat `main` as release-stable. Start active development from `dev`.
- Keep each pull request bounded to one issue or one coherent change.
- Link the governing issue and report the exact checks run.
- Use [Project 2](https://github.com/orgs/ResonantOS/projects/2) as the
  release-planning authority. Follow
  [Project governance](docs/PROJECT_GOVERNANCE.md) for fields and transitions.

## Ownership And Scope Rules

- Read [Module Ownership](docs/architecture/MODULE-OWNERSHIP.md) before adding a
  module, moving behavior, changing a host route, or crossing module boundaries.
- Update the ownership map in the same pull request when responsibility moves.
- Stay within the file ownership assigned for the task.
- Preserve unrelated dirty work and concurrent changes. Never reset, clean,
  overwrite, or revert files you do not own.
- Keep documentation-only work out of runtime code.

## Secrets And Local State

- Never commit API keys, provider credentials, wallet material, bridge tokens,
  capability tokens, browser profiles, cookies, login databases, or private user
  content.
- Provider credentials entered through **Settings > Providers** remain in host
  memory for the bridge session. Alternatively, export a supported provider
  variable into the bridge process environment. The bridge launcher does not
  load dotenv files.
- Keep any other local secret material under `ResonantOS_User/Secrets/`, outside
  the repository. Do not mistake that local directory for persisted Alpha
  provider configuration.
- Keep `bridge-config.generated.js`, `ResonantOS_User/`, screenshots, test
  evidence, run transcripts, and repository-local agent state out of commits.
- Redact logs and diagnostics before attaching them to an issue or pull request.

## Change-To-Check Matrix

| Change | Required checks |
| --- | --- |
| Documentation | `npm run docs:check` and `npm run test:docs` |
| Extension behavior | `npm run test:browser-first` |
| Local bridge behavior | `npm run test:browser-first` |
| Controlled browser-host package | `npm run test:browser-host` |
| Shared TypeScript or React | `npm test -- --run` and `npm run build` |
| Security-sensitive paths | `node scripts/security-pipeline/run-check.mjs` |
| Alpha release scope | `npm run pre-release:scan` and the release checks in the relevant docs |

Run every row touched by the change. A pull request may require more checks than
the minimum listed here. Run `npm run verify:alpha` for release-impacting,
cross-module, or final-certification work.

## Definition Of Done

- The change matches its issue acceptance criteria and the Alpha boundary.
- Ownership, security, privacy, and human-only action boundaries were reviewed.
- Behavior changes include focused tests; documentation commands and links are
  executable and current.
- All relevant deterministic checks pass, or the pull request names each known
  failure and blocker exactly.
- Live extension behavior includes human-visible browser proof when required by
  the issue or Project 2 labels.
- The pull request targets `dev`, links its issue, and records checks performed.

## Prohibited Actions

- Do not push directly to `dev` or `main`.
- Do not commit secrets, generated bridge credentials, browser state, or local
  evidence.
- Do not weaken tests, safety controls, or validation to make a check pass.
- Do not invent commands, runtime support, status, test counts, or roadmap
  commitments.
- Do not use chat history or local agent memory as project authority.
- Do not modify, delete, or revert work outside the assigned scope.
