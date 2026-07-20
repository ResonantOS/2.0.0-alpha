# Contributing To ResonantOS

ResonantOS accepts focused contributions to the browser-first Alpha. Read the
five-file path beginning with [AGENTS.md](AGENTS.md), complete
[installation](INSTALL.md), and use [docs/README.md](docs/README.md) to find the
architecture and component references for your change.

## Run The Alpha First

Establish the supported runtime before editing:

```bash
npm install
npm run browser-first:bridge
```

Keep the bridge running, open `chrome://extensions`, enable Developer mode,
select **Load unpacked**, and choose
`browser-first/resonantos-side-panel-extension`.

## Choose Work From GitHub

GitHub Issues are the public intake queue.
[Project 2](https://github.com/orgs/ResonantOS/projects/2) is the
release-planning authority for `Release Scope`, `Area`, and `Status`. Issues
labeled `scope:community-test`, `help wanted`, or `good first issue` are the
best starting points when available. Read
[Project Governance](docs/PROJECT_GOVERNANCE.md) before changing issue fields or
release scope.

Before implementation:

1. Confirm the issue has bounded acceptance criteria.
2. Identify the owning module in
   [Module Ownership](docs/architecture/MODULE-OWNERSHIP.md).
3. Check security, privacy, secret-handling, and human-only action boundaries.
4. Confirm whether deterministic tests are enough or live Chrome proof is also
   required.

## Create A Feature Branch

Branch from the latest `dev`:

```bash
git fetch origin
git switch dev
git pull --ff-only origin dev
git switch -c docs/short-description
```

Use a prefix appropriate to the area, such as `bridge/`, `extension/`,
`archive/`, `security/`, or `docs/`. Never push directly to `dev` or `main`.
Open the pull request into `dev`.

Agents working in a shared checkout must honor assigned file ownership, preserve
unrelated dirty files, and never reset, clean, overwrite, or revert another
worker's changes.

## Make The Change

- Follow the local README and relevant architecture decision records.
- Keep the change within one module where possible.
- Follow the
  [ownership checklist](docs/architecture/MODULE-OWNERSHIP.md#pull-request-checklist-hook)
  when adding a module, moving behavior, changing host routes, or crossing
  module boundaries.
- Add focused tests for behavior changes.
- Keep credentials and user data out of source, fixtures, logs, screenshots, and
  pull-request text.
- Do not claim runtime support, status, or release scope that is absent from
  code, tests, [current status](docs/STATUS.md), and Project 2.

## Run Change-Specific Checks

Use the rows that match the change:

| Change | Checks |
| --- | --- |
| Documentation | `npm run docs:check` and `npm run test:docs` |
| Extension | `npm run test:browser-first` |
| Local bridge | `npm run test:browser-first` |
| Controlled browser-host package | `npm run test:browser-host` |
| Shared TypeScript or React | `npm test -- --run` and `npm run build` |
| Security-sensitive behavior | `node scripts/security-pipeline/run-check.mjs` |
| Alpha release scope | `npm run pre-release:scan` plus the release checks routed from `docs/README.md` |

Run broader checks when ownership, contracts, or release behavior crosses more
than one row. Run the complete deterministic gate for release-impacting,
cross-module, or final-certification work:

```bash
npm run verify:alpha
```

## Open The Pull Request

Target `dev` and include:

- a title prefixed by area, such as `docs:`, `bridge:`, or `extension:`;
- the linked issue and a concise explanation of what changed and why;
- ownership, security, privacy, and compatibility impact;
- exact commands run and their results;
- known failures or blockers without hiding unrelated baseline failures; and
- screenshots or live-browser evidence when the acceptance criteria require it,
  with private information redacted.

Maintainers move Project 2 status based on evidence. Opening or merging a pull
request does not by itself make an item `Done`.

## Report Issues Safely

For bugs, include reproduction steps, expected and actual behavior, operating
system, Node.js version, Chrome version, and redacted logs. Do not publish API
keys, bridge tokens, wallet material, browser profiles, private content, or
unredacted diagnostics. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

Continue to the [documentation router](docs/README.md) for task-specific
references.
