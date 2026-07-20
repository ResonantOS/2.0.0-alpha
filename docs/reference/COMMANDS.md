# Side-Panel Command Reference

These commands are implemented by the Alpha side-panel router. Enter them in
Augmentor chat. Page content remains untrusted, site permissions still apply,
and commands never override approval or human-only action boundaries.

## Context And Status

| Command | Purpose |
| --- | --- |
| `/read` / `/context` / `/summarize` | Read the current bounded page snapshot and prepare a summary. `/summarise` is also accepted. |
| `/status` | Show current bridge and workspace status. |
| `/capabilities` / `/permissions` | Show available capabilities and grants. |
| `/site <mode>` | Inspect or change the current site's permission through the governed site-permission flow. |
| `/history <query>` | Search bounded local browser history and readable tabs; use the Product Guide syntax for filters and intake. |

## Browser Control And Durable Jobs

| Command | Purpose |
| --- | --- |
| `/browser <instruction>` | Run the browser-command path for a bounded navigation or browser instruction. |
| `/control <goal>` | Start governed Agent Control planning for a browser goal. |
| `/jobs [filter]` | List durable browser jobs. |
| `/pause <job>` | Pause a browser job at a supported boundary. |
| `/resume <job>` / `/continue <job>` | Resume a paused or blocked browser job after review. |
| `/report <job>` | Show the durable job report and evidence. |
| `/cancel <job>` | Cancel a browser job and run its cleanup path. |
| `/approve-control <job>` | Approve the displayed Agent Control preflight. |
| `/allow-control-once <job>` | Grant the displayed one-time task-class approval. |
| `/deny-control <job>` | Deny the displayed Agent Control preflight. |

Approval commands act only on the currently displayed bounded preflight. They
do not authorize wallet connection, signing, credential entry, payment,
purchase, transfer, public submission, or another human-only action.

## Resonator Visual Guidance

| Command | Purpose |
| --- | --- |
| `/highlight <target>` | Highlight a target on the active page with a transient visual guide. |
| `/arrow <target>` | Draw an arrow guide to a target on the active page. |
| `/spotlight <target>` | Dim the page and spotlight one target for guided focus. |
| `/step <target-1>; <target-2>; ...` | Place numbered step badges for semicolon-separated targets. |
| `/clear` | Remove active Resonator visual guides from the page. |

`<target>` resolves as either quoted visible text or a CSS selector token.
When a selector is used, trailing text is treated as an optional overlay label
for commands that render labels.

These commands are visual-guidance overlays only. They inject transient DOM
overlay elements on the active page and do not bypass site permissions,
approval boundaries, or human-only action limits.

## Memory And Evidence

| Command | Purpose |
| --- | --- |
| `/memory <query>` | Search the bounded Living Archive memory surface. |
| `/save <instruction>` / `/archive <instruction>` / `/intake <instruction>` | Send supported evidence to raw intake for review. |
| `/trail <instruction>` / `/researchtrail <instruction>` | Save a supported research trail to raw intake. |
| `/wallet [status]` | Inspect page-visible wallet status without requesting access. |
| `/wallet audit [goal]` | Save read-only wallet evidence and a review request. |
| `/dao <goal>` | Prepare read-only DAO workflow guidance. |
| `/dao audit <goal>` | Save DAO evidence and a review request. |

## Delegation And Draft Handoffs

| Command | Purpose |
| --- | --- |
| `/goal <goal>` | Run the bounded goal workflow. |
| `/hermes [status or mission]` | Inspect Hermes status or prepare a Hermes delegation. |
| `/delegate <target> <mission>` | Prepare a bounded delegation task. |
| `/delegations [filter]` / `/handoffs [filter]` | Inspect delegation and handoff records. |
| `/email <draft request>` | Prepare a Gmail draft handoff; it does not send mail. |
| `/calendar <draft request>` | Prepare a Calendar draft handoff; it does not create an event. |

The human reviews and completes external draft handoffs. A returned URL or
artifact is not proof that an external action occurred.
