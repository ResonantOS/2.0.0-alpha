# ADR-029: Living Archive MCP Bridge

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Living Archive MCP
- Decision date: 2026-05-03
- Alpha note: Optional external MCP services are not required Alpha runtime.

## Decision

ResonantOS will expose the Living Archive to external tools through a **scoped MCP bridge**.

The V1 implementation has two executable pieces:

```text
examples/living-archive-mcp.mjs
examples/living-archive-memory-service.mjs
```

`living-archive-mcp.mjs` is the external MCP stdio server.

`living-archive-memory-service.mjs` is a loopback HTTP memory service that exposes the same `POST /memory/{operation}` contract against a portable `ResonantOS_User/Memory` folder. It exists so external clients can use the live-mode MCP path without requiring a hand-written mock service while the desktop host provider is still being productized.

The desktop host owns the product launcher for this service through narrow Tauri IPC commands in `src-tauri/src/memory_service.rs`. The React Settings surface can start, stop, and inspect the service without giving browser code raw process control.

The MCP bridge supports two backends:

1. A live host-mediated memory-provider HTTP service, including the local V1 memory service:

```bash
RESONANTOS_MEMORY_ROOT=/path/to/ResonantOS_User/Memory npm run memory-service
```

Then:

```bash
RESONANTOS_MEMORY_SERVICE_URL=http://127.0.0.1:4888
```

or:

```bash
node examples/living-archive-mcp.mjs --memory-service-url http://127.0.0.1:4888
```

2. A direct portable `ResonantOS_User/Memory` folder fallback:

```bash
RESONANTOS_MEMORY_ROOT=/path/to/ResonantOS_User/Memory
```

or:

```bash
node examples/living-archive-mcp.mjs --memory-root /path/to/ResonantOS_User/Memory
```

The live backend is preferred because it routes requests through the active memory-provider service and can support host-mediated behavior through the same operation contract used by ResonantOS.

The current local memory service supports portable read/search/intake/review-listing/deterministic-lint and a deterministic review/promote workflow. Trusted wiki writes are still not raw filesystem writes: they require a queued ingest request, a generated review artifact, an explicit review decision, and a promotion call that updates the wiki, `index.md`, and `log.md` with audit metadata.

The portable backend remains useful when the desktop shell is offline or the user wants a standalone read/intake bridge against the copied memory folder.

The MCP bridge is an external access surface. It is not itself the trusted ingest service and it is not allowed to write trusted AI Memory wiki pages directly.

## Why

Community members and external AI tools need a standard way to connect to ResonantOS memory without embedding inside the desktop app.

MCP is the right bridge shape because:

- external AI clients already understand MCP tool discovery and tool calls
- ResonantOS can expose a small set of memory tools without leaking raw filesystem authority
- external agents can search/read scoped memory and deposit artifacts into intake
- trusted meaning writes remain governed by the existing Living Archive ingest/review boundary

This preserves the central Living Archive rule: external agents can contribute material, but they do not become trusted memory authors by default.

## Rules

- In live mode, MCP calls proxy to the configured memory-provider HTTP service through `POST /memory/{operation}`.
- In portable mode, the MCP bridge reads only inside the configured `Memory` root.
- In portable mode, path traversal outside the memory root is rejected.
- In portable mode, search/read support is limited to safe text-like formats.
- In portable mode, `INDEX` and technical/build directories are ignored for search.
- In portable mode, raw MCP write tools may write only:
  - `Memory/INTAKE/mcp/{bucket}`
  - `Memory/INTAKE/review-queue`
- MCP write tools must not write `Memory/AI_MEMORY/wiki`, `Memory/HUMAN_KNOWLEDGE`, or `Memory/EXTERNAL_KNOWLEDGE` directly.
- Ingest requests created by MCP must mark that Strategist-owned ingest/review is required.
- Readonly mode must disable all write tools.
- Trusted promotion may be requested only through the review-artifact workflow using `living_archive_promote_review_artifact`; the bridge never exposes a generic arbitrary wiki write.
- Portable promotion must require an approved review artifact and must update `index.md` as the content catalog and `log.md` as the chronological record.
- The bridge must remain usable without PostgreSQL.
- The local memory service must bind to loopback by default.
- The local memory service may perform deterministic trusted promotion only as the ResonantOS-owned memory service for a configured portable memory root; readonly MCP mode remains the recommended default for untrusted external agents.

## Tool Surface

### `living_archive_status`

Returns:

- live memory-provider status when `RESONANTOS_MEMORY_SERVICE_URL` is configured
- portable memory root, domain existence, and file counts in folder mode
- readonly state
- explicit boundary metadata

### `living_archive_search`

Searches text-like files under the memory root and returns:

- relative path
- title
- domain
- file type
- score
- size
- modified time
- snippet

In live mode this proxies to `POST /memory/search`.

In portable mode, AI Memory search uses `Memory/AI_MEMORY/wiki/index.md` as the first navigation layer before falling back to page text. This matches the LLM Wiki query pattern and gives Hermes/read-only external agents the same catalog-first view that Augmentor uses.

### `living_archive_read`

Reads one guarded document by relative path and returns:

- path
- title
- doc type
- parsed simple frontmatter
- content
- size
- modified time

In live mode this proxies to `POST /memory/read`.

### `living_archive_write_intake`

Writes external artifacts to:

```text
Memory/INTAKE/mcp/{bucket}/{fileName}
```

Also writes a metadata sidecar with actor id, write time, content hash, and caller metadata.

In live mode this proxies to `POST /memory/intake-write`.

### `living_archive_request_ingest`

Writes a reviewable ingest request to:

```text
Memory/INTAKE/review-queue/{id}.json
```

The request explicitly states:

- it is not a trusted knowledge write
- Strategist-owned ingest is required

In live mode this proxies to `POST /memory/ingest-request`.

### `living_archive_review_queue`

Lists queued ingest requests.

In live mode this proxies to `POST /memory/review-queue`.

In portable mode this reads JSON request files from:

```text
Memory/INTAKE/review-queue
```

### `living_archive_review_artifacts`

Lists review artifacts.

In live mode this proxies to `POST /memory/review-artifacts`.

In portable mode this reads JSON artifacts from:

```text
Memory/AI_MEMORY/provenance/review-artifacts
```

### `living_archive_process_ingest_request`

Proxies to the live memory provider:

```text
POST /memory/process-ingest-request
```

In portable mode this reads one queued JSON request from `Memory/INTAKE/review-queue`, reads the referenced source artifact, and creates a deterministic review artifact under:

```text
Memory/AI_MEMORY/provenance/review-artifacts
```

The artifact contains proposed wiki content, source provenance, deterministic verification state, and a boundary block stating that no trusted knowledge write has happened yet.

### `living_archive_decide_review`

Proxies to the live memory provider:

```text
POST /memory/decide-review
```

In portable mode this records an explicit `approve`, `reject`, or `escalate` decision on the JSON review artifact. Promotion is blocked unless the artifact decision is `approved`.

### `living_archive_promote_review_artifact`

Proxies to the live memory provider:

```text
POST /memory/promote-review-artifact
```

This is the only MCP path to trusted wiki writes, and it still requires an approved review artifact enforced by the host provider.

In portable mode this promotes only an approved JSON review artifact. The service writes or section-merges the proposed page under `Memory/AI_MEMORY/wiki`, backs up overwritten pages, upserts a single deduplicated `index.md` catalog entry, appends a `log.md` promotion event, and records promotion metadata back on the review artifact.

### `living_archive_maintenance_cycle`

Proxies to the live memory provider:

```text
POST /memory/maintenance-cycle
```

In portable mode this processes queued requests into review artifacts. If `autoApprove` is explicitly passed, it can also approve and promote them through the same review-artifact gate; otherwise it stops before trusted wiki writes.

### `living_archive_background_cycle`

Proxies to the live memory provider:

```text
POST /memory/background-cycle
```

In portable mode this currently aliases the deterministic maintenance cycle. Future host-owned source scanning can add queue discovery before invoking the same review/promote path.

### `living_archive_lint`

In live mode this proxies to:

```text
POST /memory/lint
```

Portable lint now also runs deterministic wiki health over `Memory/AI_MEMORY/wiki`, including missing `index.md`/`log.md`, broken links, orphan pages, missing index entries, duplicate index entries, duplicate titles, missing visible provenance, and contradiction/open-question markers. This remains read-only and does not repair or promote trusted memory.

### `living_archive_semantic_lint`

Proxies to the live memory provider:

```text
POST /memory/semantic-lint
```

In portable mode this returns the deterministic wiki-health findings in the semantic-lint response shape. Provider-backed semantic lint can still be supplied by a live host service when model routing is available.

## Local Memory Service

The local service is a product integration layer for portable memory:

```bash
RESONANTOS_MEMORY_ROOT=/path/to/ResonantOS_User/Memory npm run memory-service
```

From the desktop app, users can open:

```text
Settings -> Memory Bridge
```

and start or stop the host-managed service. The host resolves the canonical Portable User State memory root and launches the service on loopback.

Defaults:

- host: `127.0.0.1`
- port: `4888`
- root: `RESONANTOS_MEMORY_ROOT`

Host-managed defaults:

- root: resolved by `ensure_portable_user_state`
- process owner: Rust/Tauri host service
- IPC commands:
  - `living_archive_memory_service_status`
  - `living_archive_memory_service_start`
  - `living_archive_memory_service_stop`

Supported HTTP operations:

- `POST /memory/status`
- `POST /memory/search`
- `POST /memory/read`
- `POST /memory/intake-write`
- `POST /memory/ingest-request`
- `POST /memory/review-queue`
- `POST /memory/review-artifacts`
- `POST /memory/process-ingest-request`
- `POST /memory/decide-review`
- `POST /memory/promote-review-artifact`
- `POST /memory/maintenance-cycle`
- `POST /memory/background-cycle`
- `POST /memory/lint`
- `POST /memory/semantic-lint`

The trusted-write operations are intentionally narrow. They do not accept arbitrary wiki page content from external clients; they operate only on service-created review artifacts whose source path, proposed page, decision, promotion event, and backup are auditable.

## Relationship To Existing Memory Provider Broker

ResonantOS already supports a neutral `memory-provider` broker and an `http-json` provider adapter. That broker is for ResonantOS-internal product surfaces and replaceable memory-system add-ons.

The MCP bridge is different:

- it serves external clients
- it speaks MCP JSON-RPC over stdio
- it can proxy the active memory-provider HTTP service when available
- it can operate on a portable memory folder when the desktop shell is unavailable

The live backend uses the same `POST /memory/{operation}` operation names as the V1 `http-json` memory-provider adapter from `ADR-026`.

## Consequences

- The community can connect external AI tools to ResonantOS memory through MCP.
- The portable memory folder becomes more useful as a standalone oracle.
- The bridge can expose full memory-provider behavior when a live host-mediated HTTP service is available.
- The bridge still works in portable folder mode for offline read/search/intake and deterministic review/promote workflows.
- External tools still cannot bypass the Living Archive trust model.
- Trusted knowledge promotion remains inside the Strategist-owned ingest/review path.

## Validation

The bridge must be tested at two levels:

- direct bridge function tests for portable status/search/read/intake/ingest/process/decide/promote behavior
- direct local memory-service tests for HTTP status/search/read/intake/review/lint behavior
- end-to-end MCP-through-local-service tests
- desktop settings test for host-managed service launch controls
- Rust unit tests for loopback endpoint/session helpers
- live HTTP proxy tests for all V1 memory-provider operations
- stdio JSON-RPC tests for `initialize`, `tools/list`, and `tools/call`

Current validation:

```bash
npm run test:living-archive-mcp
npm run test:living-archive-memory-service
npm test -- src/App.test.tsx -t "Living Archive memory bridge"
cargo test memory_service --manifest-path src-tauri/Cargo.toml
```
