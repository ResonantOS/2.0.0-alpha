# ADR-007: Living Archive Boundaries

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: Living Archive
- Decision date: 2026-04-23
- Alpha note: Intake, review, and trusted-write boundaries apply through Node
  bridge services. Desktop/Tauri ownership statements do not apply to Alpha.

## Decision

Living Archive remains a core ResonantOS service, not an add-on. Add-ons may read scoped archive views and may write only to intake roots when granted. Trusted knowledge writes remain reserved to the Strategist-owned ingest service.

Archive access is mediated by ResonantOS, not direct by default.

Trusted promotion from review artifacts into wiki pages is governed by the tiered approval policy in ADR-012.

## Why

- The archive is long-term trusted memory, not just storage.
- Many add-ons will be useful readers or raw artifact producers without being trustworthy interpreters.
- The system must preserve meaning integrity while still allowing modular intake flows.

## Rules

- Living Archive is core infrastructure.
- Add-ons may only:
  - read approved archive scopes
  - write to approved intake scopes
  - request ingest when granted
- Add-ons must not write trusted knowledge pages directly.
- Knowledge write authority belongs to the Strategist-owned ingest service.
- Archive mediation must preserve provenance of incoming artifacts.
- The routing and provider logic used by ingest must follow ADR-005.
- Review-to-promotion decisions must follow ADR-012.

## Archive Access Model

### Read

Reads are scoped views, not blanket filesystem access.

Examples:

- constitution
- protocols
- living archive knowledge
- session memory
- configuration

### Intake Writes

Allowed intake outputs include:

- transcripts
- raw artifacts
- analysis bundles
- logs
- tool outputs
- external-agent deposits

### Knowledge Writes

Only the Strategist-owned ingest service may:

- create knowledge pages
- update knowledge pages
- merge interpretations
- promote reviewed artifacts into trusted archive knowledge

## Interfaces Constrained By This ADR

### Archive Read Scope

Must identify:

- readable surface
- actor eligibility
- mediation path

### Intake Write Scope

Must identify:

- allowed destination roots
- allowed artifact classes
- write actor eligibility

### Ingest Request Contract

Must carry:

- source artifact references
- requesting actor
- declared intent
- provenance metadata
- review requirement if applicable

### Review Queue Contract

Must represent:

- pending artifact or bundle
- source actor
- status
- review notes
- promotion outcome

## Consequences

- Archive APIs should be modeled as a core service boundary, not raw path access.
- Add-on manifests and capability grants must express archive read and intake requirements clearly.
- Future UI should distinguish archive intake, archive review, and trusted knowledge as separate surfaces.
