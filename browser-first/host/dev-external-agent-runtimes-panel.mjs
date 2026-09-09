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
// result as `window.__ADDONS_DATA__`, so the page renders entirely from
// server-injected data — no client-side fetch and therefore no second
// authenticated request from the browser. The JSON endpoint remains for
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
    return {
      addons: [],
      error: `unable to read ${examplesDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const addons = [];
  for (const fileName of fileNames) {
    const absPath = join(examplesDir, fileName);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(absPath, "utf8"));
    } catch (error) {
      addons.push({
        fileName,
        error: `parse failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const capabilities = new Set(
      (manifest.requestedCapabilities ?? []).map((entry) => entry?.capability).filter(Boolean),
    );
    addons.push({
      fileName,
      id: manifest.id ?? null,
      name: manifest.name ?? null,
      version: manifest.version ?? null,
      runtimeType: manifest.runtimeType ?? null,
      serviceEntrypoint: manifest.service?.entrypoint ?? null,
      tools: (manifest.tools ?? []).map((tool) => tool?.name).filter(Boolean),
      // ADR-040 §3 external-agent-runtime trigger: the manifest requests both
      // `providers` and `agent-delegation`.
      hasTrigger: capabilities.has("providers") && capabilities.has("agent-delegation"),
    });
  }
  return { addons };
}

function buildPanelPayload(enumerate) {
  return {
    addons: enumerate.addons,
    error: enumerate.error ?? null,
    panelPath: "/dev/external-agent-runtimes/",
    generatedAt: new Date().toISOString(),
  };
}

// Embed `data` into the static template as an inert JSON literal, injected
// into an executable <script> block. Three classes of character are
// neutralised so a crafted manifest field can never escape the data context:
//   - `<` is escaped so a literal `</script>` can never close the block into
//     markup;
//   - U+2028 and U+2029 are escaped because, although JSON treats them as
//     ordinary string characters, a JavaScript parser reads them as line
//     terminators — a raw one inside the literal would corrupt the source.
// The escapes use the explicit \uXXXX regex form so the source never carries a
// raw U+2028/U+2029 (which would itself act as a line terminator).
function renderPanelHtml(data) {
  const template = loadPanelTemplate();
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
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
