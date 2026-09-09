// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#9-deepseek-harness-exemplar
//
// Dev-only panel for the add-on SDK work: a bridge-hosted status view that
// enumerates `examples/addons/*.json` and renders one card per manifest.
//
// This is a development convenience for the engineer reviewing the add-on
// SDK work locally — it answers "what does the add-on look like to the
// bridge that is running?" It is NOT a user-facing surface and is registered
// only by the minimal/development launcher (`run-bridge-minimal.mjs`), never
// by the production launcher.
//
// Security posture (dev's #346 rule): both routes declare an explicit
// `requiredCapability` (`addon-runtime-read`) and keep the bridge's normal
// bridge-token + capability-token + default-deny enforcement. There is no
// loopback / RFC1918 bypass, no wildcard CORS, no prefix matching, and no
// boot-time grant snapshot fallback. Route keys are exact pathnames
// (`routeKey` normalises via `new URL(...).pathname`), so
// `/dev/external-agent-runtimes` (JSON) and `/dev/external-agent-runtimes/`
// (HTML) are distinct routes and accept no path suffixes.
//
// The HTML route handler enumerates the manifests itself and injects the
// result as an inert `<script type="application/json">` data block, so the
// page renders entirely from server-injected data — no client-side fetch and
// therefore no second authenticated request from the browser. The JSON endpoint remains for
// curl/scripting. `repoRoot` is computed by the launcher and passed in
// directly — the panel never rereads it from an environment variable.

import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const moduleDir = dirname(fileURLToPath(import.meta.url));
// browser-first/host/dev-external-agent-runtimes-panel.mjs ->
//   browser-first/dev/external-agent-runtimes-panel.html
const PANEL_HTML_PATH = resolve(moduleDir, "..", "dev", "external-agent-runtimes-panel.html");

// The HTML file carries this exact token where the server injects the
// enumerated manifest payload. Keeping it as a stable sentinel lets the
// handler fail closed if the asset ever drifts from the injection contract.
const INJECT_TOKEN = "__EXTERNAL_AGENT_RUNTIMES_DATA__";

let cachedTemplate = null;

function loadPanelTemplate() {
  if (cachedTemplate === null) {
    const html = readFileSync(PANEL_HTML_PATH, "utf8");
    if (!html.includes(INJECT_TOKEN)) {
      throw new Error(`panel template is missing the ${INJECT_TOKEN} injection point`);
    }
    cachedTemplate = html;
  }
  return cachedTemplate;
}

// Enumerate `examples/addons/*.json` into the per-manifest card fields the
// panel renders. This is a *manifest listing* only: running the .ts boundary
// validators in the bridge would require a tsx loader, so validation + F-cases
// stay on `npm run deepseek-harness:smoke`.
//
// Returns `{ addons }` on success, or `{ addons: [], error }` when the
// directory cannot be read. Individual parse failures are reported inline as
// `{ fileName, error }` entries rather than aborting the whole listing — the
// panel must reflect an honest partial state, not fail closed to a blank page.
async function enumerateAddons(repoRoot) {
  const examplesDir = join(repoRoot, "examples", "addons");
  let fileNames;
  try {
    fileNames = (await readdir(examplesDir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    // Report a stable reason code only. The failing path is the developer's
    // absolute workstation path (and Node's fs error message embeds it too),
    // so neither may leak into the panel response.
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "unknown";
    return {
      addons: [],
      error: `unable to read examples/addons (${code})`,
    };
  }
  const addons = [];
  for (const fileName of fileNames) {
    const absPath = join(examplesDir, fileName);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(absPath, "utf8"));
    } catch (error) {
      // Node >= 21 JSON.parse messages carry position info only — no source
      // excerpt — so the message cannot echo manifest content.
      addons.push({
        fileName,
        error: `parse failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    try {
      addons.push(describeManifest(fileName, manifest));
    } catch (error) {
      // Shape errors are our own constant messages, never manifest content.
      addons.push({
        fileName,
        error: `invalid manifest: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { addons };
}

// Project one manifest into the per-manifest card fields the panel renders.
// Only the explicitly selected fields below are copied — unknown or extension
// fields (credentials, prompts, paths, `__proto__`, arbitrary nested objects)
// never pass through to the JSON response or the HTML. Structurally invalid
// manifests throw so the caller can report the file inline (fail honestly)
// instead of aborting the whole listing with a 500.
function describeManifest(fileName, manifest) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("manifest root must be a JSON object");
  }
  const requestedCapabilities = manifest.requestedCapabilities ?? [];
  if (!Array.isArray(requestedCapabilities)) {
    throw new Error("requestedCapabilities must be an array");
  }
  const manifestTools = manifest.tools ?? [];
  if (!Array.isArray(manifestTools)) {
    throw new Error("tools must be an array");
  }
  const capabilities = new Set(
    requestedCapabilities.map((entry) => entry?.capability).filter(Boolean),
  );
  return {
    fileName,
    id: manifest.id ?? null,
    name: manifest.name ?? null,
    version: manifest.version ?? null,
    runtimeType: manifest.runtimeType ?? null,
    serviceEntrypoint: manifest.service?.entrypoint ?? null,
    tools: manifestTools.map((tool) => tool?.name).filter(Boolean),
    // ADR-040 §3 external-agent-runtime trigger: the manifest requests both
    // `providers` and `agent-delegation`.
    hasTrigger: capabilities.has("providers") && capabilities.has("agent-delegation"),
  };
}

function buildPanelPayload(enumerate) {
  return {
    addons: enumerate.addons,
    error: enumerate.error ?? null,
    panelPath: "/dev/external-agent-runtimes/",
    generatedAt: new Date().toISOString(),
  };
}

// Embed `data` into the static template as an inert JSON literal inside a
// <script type="application/json"> block. That block is never executed — the
// render script reads it via textContent + JSON.parse — so no JavaScript
// parsing of the payload occurs and no executable-context escaping (U+2028 /
// U+2029) is required. The only escaping needed is `<` -> <, so a literal
// `</script>` in a manifest field can never close the data block into markup.
function renderPanelHtml(data) {
  const template = loadPanelTemplate();
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return template.replace(INJECT_TOKEN, json);
}

export function createDevExternalAgentRuntimesPanelService({ repoRoot }) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new Error("createDevExternalAgentRuntimesPanelService requires a non-empty { repoRoot }");
  }

  return {
    devPanelRoutes: [
      {
        method: "GET",
        path: "/dev/external-agent-runtimes",
        requiredCapability: "addon-runtime-read",
        handler: async () => buildPanelPayload(await enumerateAddons(repoRoot)),
      },
      {
        method: "GET",
        path: "/dev/external-agent-runtimes/",
        requiredCapability: "addon-runtime-read",
        handler: async () => {
          const html = renderPanelHtml(buildPanelPayload(await enumerateAddons(repoRoot)));
          // The bridge's request handler switches to writeHtml() when the
          // result payload carries an `__html` marker. The spread into
          // `{ ok: true, ...result }` keeps the marker at the top level.
          return { __html: html, contentType: "text/html; charset=utf-8" };
        },
      },
    ],
  };
}
