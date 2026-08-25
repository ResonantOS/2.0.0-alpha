# Resonant Add-on SDK Specification V0.1

## Status

Draft specification for implementation in the ResonantOS Alpha fork.

## Purpose

The Resonant Add-on SDK is the developer-facing contract of the Resonant Extension Framework.

Its purpose is to let a developer build a ResonantOS add-on without importing private kernel implementation details or bypassing ResonantOS authority boundaries.

The SDK must be usable outside the ResonantOS source tree.

## Terminology

The unit built with this SDK is an **add-on**, matching existing ResonantOS
vocabulary (`AddOnManifest`, `src/sdk/addons/`, ADR-018). Earlier drafts used
the word "plugin"; the concepts are identical. Public API names in this
specification (`defineAddon`, `validateAddOnManifest`,
`assertValidAddOnManifest`) intentionally align with the existing validators
in `src/sdk/addons/validation.ts`.

## Design Goals

1. Stable, explicit contracts.
2. Least-privilege capabilities.
3. Host-mediated privileged operations.
4. Deterministic validation.
5. Versioned compatibility.
6. Testability outside the main repository.
7. Clear separation between declaration, grant, execution, and certification.
8. Compatibility with first-party, curated, and sideloaded add-ons.

## Proposed Packages

```text
@resonantos/addon-sdk
@resonantos/addon-sdk-ui
@resonantos/addon-sdk-agent
@resonantos/addon-sdk-testing
@resonantos/create-addon
```

V0.1 may ship only `@resonantos/addon-sdk` and `@resonantos/addon-sdk-testing` initially.

## Public SDK Boundary

The public package must not require imports like:

```ts
import type { AddOnManifest } from "../../core/contracts";
```

Instead, public contracts must be owned by the SDK or a deliberately public shared contract package.

Preferred:

```ts
import {
  defineAddon,
  validateAddOnManifest,
  capability,
  tool,
  service
} from "@resonantos/addon-sdk";
```

## Proposed SDK Modules

```text
@resonantos/addon-sdk
|
+-- manifest
+-- capabilities
+-- compatibility
+-- lifecycle
+-- services
+-- tools
+-- connectors
+-- skills
+-- hooks
+-- memory
+-- agents
+-- ui
+-- validation
+-- package
+-- provenance
```

## Add-on Definition API

Illustrative API:

```ts
import {
  defineAddon,
  capabilities
} from "@resonantos/addon-sdk";

export default defineAddon({
  id: "addon.example.notes",
  name: "Example Notes",
  version: "1.0.0",
  sdkVersion: "^0.1.0",
  category: "knowledge",
  runtimeType: "local-service",
  description: "Example note integration.",

  requestedCapabilities: [
    capabilities.archiveRead(),
    capabilities.archiveIntakeWrite()
  ],

  surfaces: [],
  tools: []
});
```

The helper API is optional sugar. The normalized manifest remains the source of truth.

## Runtime Types

V0.1 retains the existing runtime categories:

- `ui-module`
- `embedded-module`
- `local-service`
- `agent-addon`
- `channel-addon`

Future runtime types require a versioned SDK decision.

## Service Protocols

V0.1 retains:

- `stdio-json-rpc`
- `http-json`
- `websocket-json`
- `host-command`

A protocol declaration does not allow an add-on to open arbitrary privileged channels. The host determines how the service is launched and mediated.

## Capability Model

Existing V0 capabilities remain valid:

- `filesystem`
- `archive-read`
- `archive-intake-write`
- `chat-interface`
- `memory-provider`
- `providers`
- `shell`
- `network`
- `ui-embedding`
- `browser-control`
- `agent-delegation`
- `notifications`
- `device-integration`

V0.1 should begin a migration toward narrower capabilities where practical.

Candidate future names:

```text
network.http
filesystem.read
filesystem.write
archive.search
archive.read
archive.intake
ai.inference
ai.embedding
ai.rerank
ai.vision
ai.audio
browser.read
browser.control
device.camera
device.microphone
notifications.send
identity.sign
agent.delegate
```

The migration must remain backward-compatible until a major SDK version permits removal.

## Scope Model

Capabilities should support optional scopes.

Illustrative:

```json
{
  "capability": "filesystem.read",
  "scopes": [
    "${workspace}/notes/**"
  ]
}
```

A grant may be narrower than the add-on request.

The host must reject attempts outside the grant.

## Lifecycle

An add-on may participate in these lifecycle states:

```text
discovered
validated
installed
disabled
enabled
degraded
updating
revoked
removed
```

Lifecycle hooks must be declarative and host-mediated.

Candidate lifecycle events:

- `beforeInstall`
- `afterInstall`
- `beforeEnable`
- `afterEnable`
- `beforeDisable`
- `afterDisable`
- `healthCheck`
- `beforeUpdate`
- `afterUpdate`
- `beforeRemove`
- `afterRemove`

A hook does not grant authority.

## Tools

Every add-on tool must declare:

- stable tool name;
- description;
- input schema;
- output schema;
- required capabilities;
- audit requirement;
- whether human approval is required.

Example:

```json
{
  "name": "notes.create",
  "description": "Create a note through the configured note provider.",
  "requiredCapabilities": [
    "archive-intake-write"
  ],
  "inputSchema": {
    "type": "object",
    "required": ["title", "content"]
  },
  "outputSchema": {
    "type": "object"
  },
  "audit": true,
  "requiresHumanApproval": false
}
```

## Connectors

Connectors declare access to another system.

They must never embed raw credentials in the add-on package.

Credentials must be acquired through ResonantOS-mediated provider/account configuration.

Connector manifests should declare:

- connector id;
- provider/service;
- authentication mode;
- required capabilities;
- requested account scopes;
- read/write semantics;
- health check;
- disconnect behavior.

## Agent Add-ons

Agent add-ons must explicitly declare:

- invocation tool;
- model-selection source of truth;
- streaming support;
- cancellation support;
- output filtering;
- memory access;
- delegation ability;
- smoke tests.

Trusted memory writes remain intake-only unless a future policy explicitly expands the boundary.

## REF Vocabulary

The framework introduces two named REF fields that distinguish REF's
distribution trust from the existing alpha runtime's `agents[].trustTier`:

- `releaseTrustTier` — `developer` / `verified` / `approved`
- `capabilityRiskClass` — `low` / `moderate` / `high` / `critical`

These names are the canonical REF names per `OPEN_DESIGN_CONFLICTS_V0.1.md`
C9 and `RESOLUTIONS_V0.1.md` C9. Existing fields (`provenance.tier`,
`agents[].trustTier`) carry the same value set for V0.1 backward
compat. Full field rename lands when the SDK is extracted to
`packages/addon-sdk/`.

See `ADDON_CERTIFICATION_AND_SIGNING_V0.1.md` "REF Vocabulary (C9)"
for the canonical definition and allowed values.

## SDK Validation

The SDK must provide:

```ts
validateAddOnManifest(manifest)
assertValidAddOnManifest(manifest)
```

Validation must be deterministic and callable in:

- local development;
- unit tests;
- CI;
- submission processing;
- host installation.

## Compatibility

Each add-on must declare supported ranges:

```json
{
  "compatibility": {
    "resonantOS": ">=2.0.0-alpha <3.0.0",
    "sdk": "^0.1.0"
  }
}
```

The host must reject or quarantine incompatible releases.

## Developer CLI

Target CLI:

```text
resonant addon create
resonant addon validate
resonant addon test
resonant addon audit
resonant addon package
resonant addon submit
```

An npm initializer may provide:

```bash
npm create resonant-addon
```

## Local Development Workflow

```text
create
  |
  v
implement
  |
  v
validate
  |
  v
test
  |
  v
audit
  |
  v
package
  |
  v
sideload
```

No submission is required for local developer-mode testing.

## Public API Stability

SDK public exports must be intentional.

Internal helpers must not be exported merely because they are convenient.

Every public contract must have:

- owner;
- version behavior;
- validation behavior;
- tests;
- migration policy.

## M0 Success Criterion

The SDK reaches M0 when a developer outside the ResonantOS source tree can:

1. scaffold an add-on;
2. declare a manifest;
3. validate it;
4. run SDK tests;
5. package it;
6. sideload it into ResonantOS;
7. see requested permissions;
8. grant a bounded capability;
9. execute one host-mediated tool;
10. disable and remove the add-on;

without importing private ResonantOS source modules.
