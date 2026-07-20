#!/usr/bin/env node
// Intent citation: docs/architecture/ADR-029-living-archive-mcp-bridge.md

import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { searchMemoryWiki } from "../browser-first/host/memory-search.mjs";
import { computeWikiHealth } from "../browser-first/host/memory-wiki-health.mjs";
import {
  decidePortableReview,
  processPortableIngestRequest,
  promotePortableReviewArtifact,
  runPortableMaintenanceCycle,
  runPortableSemanticLint,
} from "./living-archive-portable-workflow.mjs";

const protocolVersion = "2025-06-18";
const serverInfo = {
  name: "resonantos-living-archive-mcp",
  version: "1.0.0",
};

const allowedReadExtensions = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".csv",
]);
const ignoredDirectoryNames = new Set([
  ".git",
  ".DS_Store",
  "node_modules",
  "target",
  "dist",
  "build",
  "INDEX",
]);
const writeFileNamePattern = /^[a-zA-Z0-9._ -]+$/;

const nowIso = () => new Date().toISOString();

const parseArgs = (argv = process.argv.slice(2), env = process.env) => {
  let memoryRoot = env.RESONANTOS_MEMORY_ROOT ?? "";
  let memoryServiceUrl = env.RESONANTOS_MEMORY_SERVICE_URL ?? "";
  let maxSearchBytes = Number.parseInt(env.RESONANTOS_MCP_MAX_SEARCH_BYTES ?? "1048576", 10);
  let readonly = env.RESONANTOS_MCP_READONLY === "1";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--memory-root") {
      memoryRoot = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--memory-service-url") {
      memoryServiceUrl = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--max-search-bytes") {
      maxSearchBytes = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--readonly") {
      readonly = true;
    }
  }

  return {
    memoryRoot: memoryRoot ? resolve(memoryRoot) : "",
    memoryServiceUrl: memoryServiceUrl ? memoryServiceUrl.replace(/\/+$/, "") : "",
    maxSearchBytes: Number.isFinite(maxSearchBytes) && maxSearchBytes > 0 ? maxSearchBytes : 1_048_576,
    readonly,
  };
};

const postMemoryJson = async (endpoint, operation, input = {}, token = "") => {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  // DD-3 (F6): forward the bearer token so write operations authenticate against
  // the hardened memory service. Reads ignore it server-side.
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${endpoint}/memory/${operation}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.error ? `: ${payload.error}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`Memory provider ${operation} failed with HTTP ${response.status}${detail}.`);
  }
  return response.json();
};

const pathInside = (root, candidate) => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const assertMemoryRoot = (memoryRoot) => {
  if (!memoryRoot) {
    throw new Error("Missing memory root. Set RESONANTOS_MEMORY_ROOT or pass --memory-root /path/to/ResonantOS_User/Memory.");
  }
  return resolve(memoryRoot);
};

const resolveMemoryPath = (memoryRoot, requestedPath = "") => {
  const root = assertMemoryRoot(memoryRoot);
  const absolute = resolve(root, requestedPath);
  if (!pathInside(root, absolute)) {
    throw new Error("Path escapes the configured Living Archive memory root.");
  }
  return absolute;
};

const safeRelative = (memoryRoot, absolutePath) => relative(memoryRoot, absolutePath).split(sep).join("/");

const ensureDir = async (path) => {
  await fs.mkdir(path, { recursive: true });
};

const statOrNull = async (path) => {
  try {
    return await fs.stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

async function* walkFiles(root, options = {}) {
  const maxFiles = options.maxFiles ?? 2000;
  const stack = [root];
  let seen = 0;

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (ignoredDirectoryNames.has(entry.name)) {
        continue;
      }
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!allowedReadExtensions.has(extname(entry.name).toLowerCase())) {
        continue;
      }
      seen += 1;
      if (seen > maxFiles) {
        return;
      }
      yield absolute;
    }
  }
}

const parseFrontmatter = (content) => {
  if (!content.startsWith("---\n")) {
    return {};
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return {};
  }
  const raw = content.slice(4, end).trim();
  const frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (match) {
      frontmatter[match[1]] = match[2];
    }
  }
  return frontmatter;
};

const titleFromContent = (filePath, content) => {
  const heading = /^#\s+(.+)$/m.exec(content);
  return heading?.[1]?.trim() || basename(filePath).replace(/\.[^.]+$/, "");
};

const domainForPath = (relativePath) => {
  const [domain] = relativePath.split("/");
  return domain || "Memory";
};

export const livingArchiveTools = [
  {
    name: "living_archive_status",
    description: "Return Living Archive memory-provider status. Uses live host HTTP service when configured, otherwise portable memory root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "living_archive_search",
    description: "Search scoped Living Archive memory. Uses live host HTTP service when configured, otherwise portable text search.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
        domains: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["query"],
    },
  },
  {
    name: "living_archive_read",
    description: "Read one guarded memory document from the live memory provider or portable memory root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "living_archive_write_intake",
    description: "Write an external artifact to intake. Never writes trusted AI Memory pages directly.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        actorId: { type: "string" },
        bucket: { type: "string" },
        fileName: { type: "string" },
        content: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["actorId", "bucket", "fileName", "content"],
    },
  },
  {
    name: "living_archive_request_ingest",
    description: "Queue a reviewable ingest request. Trusted knowledge promotion remains host/Strategist-owned.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        actorId: { type: "string" },
        sourcePath: { type: "string" },
        sourceType: { type: "string" },
        sourceRole: { type: "string" },
        intent: { type: "string" },
        provenance: { type: "object" },
      },
      required: ["actorId", "sourcePath", "sourceType", "intent"],
    },
  },
  {
    name: "living_archive_review_queue",
    description: "List queued ingest requests awaiting processing/review.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "living_archive_review_artifacts",
    description: "List review artifacts produced by the trusted ingest/review flow.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "living_archive_process_ingest_request",
    description: "Ask the live host-mediated memory provider to process one queued ingest request into a review artifact.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        requestFile: { type: "string" },
      },
      required: ["requestFile"],
    },
  },
  {
    name: "living_archive_decide_review",
    description: "Record approve/reject/escalate decision for a review artifact through the live host-mediated memory provider.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        artifactFile: { type: "string" },
        actorId: { type: "string" },
        action: { type: "string", enum: ["approve", "reject", "escalate"] },
        notes: { type: "string" },
      },
      required: ["artifactFile", "actorId", "action"],
    },
  },
  {
    name: "living_archive_promote_review_artifact",
    description: "Promote an approved review artifact through the live host-mediated memory provider. This is the only MCP path to trusted knowledge writes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        artifactFile: { type: "string" },
        actorId: { type: "string" },
      },
      required: ["artifactFile", "actorId"],
    },
  },
  {
    name: "living_archive_maintenance_cycle",
    description: "Run provider-backed review processing, optional promotion, navigation refresh, and lint through the live memory provider.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
  },
  {
    name: "living_archive_background_cycle",
    description: "Run the live memory-provider background cycle for source scanning, queueing, maintenance, navigation refresh, and lint.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
  },
  {
    name: "living_archive_lint",
    description: "Run deterministic Living Archive lint through the live provider, or lightweight portable lint in folder mode.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "living_archive_semantic_lint",
    description: "Run provider-backed semantic lint through the live host-mediated memory provider.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
  },
];

export const createLivingArchiveBridge = (config = parseArgs()) => {
  const memoryRoot = config.memoryRoot;
  const memoryServiceUrl = config.memoryServiceUrl;
  const memoryServiceToken =
    typeof config.memoryServiceToken === "string"
      ? config.memoryServiceToken
      : process.env.RESONANTOS_MEMORY_SERVICE_TOKEN ?? "";
  const memoryServiceTransport = typeof config.memoryServiceTransport === "function" ? config.memoryServiceTransport : null;
  const maxSearchBytes = config.maxSearchBytes;
  const readonly = config.readonly;
  const backend = memoryServiceUrl || memoryServiceTransport ? "host-http" : "portable-folder";

  const proxy = async (operation, input = {}) => {
    if (!memoryServiceUrl && !memoryServiceTransport) {
      throw new Error(`Tool requires RESONANTOS_MEMORY_SERVICE_URL live memory-provider backend: ${operation}.`);
    }
    if (memoryServiceTransport) {
      return memoryServiceTransport(operation, input);
    }
    return postMemoryJson(memoryServiceUrl, operation, input, memoryServiceToken);
  };

  const status = async () => {
    if (memoryServiceUrl || memoryServiceTransport) {
      const providerStatus = await proxy("status");
      return {
        ...providerStatus,
        protocol: "mcp-stdio",
        backend,
        memoryServiceUrl: memoryServiceUrl || "in-process-test-transport",
        boundary: {
          trustedKnowledgeWrites: "host-mediated-review-only",
          directExternalKnowledgeWrites: false,
          allowedExternalWrites: ["intake-write", "ingest-request"],
        },
      };
    }
    const root = assertMemoryRoot(memoryRoot);
    const rootStat = await statOrNull(root);
    const domains = {};
    for (const domain of ["HUMAN_KNOWLEDGE", "EXTERNAL_KNOWLEDGE", "AI_MEMORY", "INTAKE", "MANIFESTS", "LOGS"]) {
      const domainRoot = join(root, domain);
      let files = 0;
      if (await statOrNull(domainRoot)) {
        for await (const _file of walkFiles(domainRoot, { maxFiles: 10_000 })) {
          files += 1;
        }
      }
      domains[domain] = {
        path: domainRoot,
        exists: Boolean(await statOrNull(domainRoot)),
        files,
      };
    }
    return {
      status: rootStat?.isDirectory() ? "ready" : "missing",
      protocol: "mcp-stdio",
      backend,
      memoryRoot: root,
      readonly,
      domains,
      boundary: {
        trustedKnowledgeWrites: false,
        allowedWrites: ["Memory/INTAKE/mcp/{bucket}", "Memory/INTAKE/review-queue"],
      },
    };
  };

  const search = async ({ query, limit = 12, domains = [] }) => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("search", { query, limit, domains });
    }
    const root = assertMemoryRoot(memoryRoot);
    const allowedDomains = new Set((Array.isArray(domains) ? domains : []).map(String));
    if (!allowedDomains.size || allowedDomains.has("AI_MEMORY")) {
      const wikiResult = await searchMemoryWiki({ memoryRoot: root, query, limit }).catch(() => null);
      if (wikiResult?.matches?.length) {
        return {
          query,
          backend: "portable-folder",
          searchMode: "index-first-wiki",
          results: wikiResult.matches.map((match) => ({
            path: match.path,
            title: match.title,
            domain: domainForPath(match.path),
            fileType: extname(match.path).slice(1) || "text",
            score: match.score,
            sizeBytes: null,
            modifiedAt: "",
            snippet: match.excerpt,
            matchSource: match.matchSource,
          })),
        };
      }
    }
    const needle = String(query ?? "").trim().toLowerCase();
    if (!needle) {
      throw new Error("Search query is required.");
    }
    const results = [];

    for await (const file of walkFiles(root)) {
      const rel = safeRelative(root, file);
      if (allowedDomains.size && !allowedDomains.has(domainForPath(rel))) {
        continue;
      }
      const stat = await fs.stat(file);
      if (stat.size > maxSearchBytes) {
        continue;
      }
      const content = await fs.readFile(file, "utf8");
      const haystack = `${rel}\n${content}`.toLowerCase();
      const matchIndex = haystack.indexOf(needle);
      if (matchIndex === -1) {
        continue;
      }
      const contentIndex = content.toLowerCase().indexOf(needle);
      const snippetStart = Math.max(0, contentIndex - 80);
      const snippet = contentIndex === -1 ? rel : content.slice(snippetStart, snippetStart + 240).replace(/\s+/g, " ").trim();
      results.push({
        path: rel,
        title: titleFromContent(file, content),
        domain: domainForPath(rel),
        fileType: extname(file).slice(1) || "text",
        score: Math.max(1, 1000 - matchIndex),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        snippet,
      });
      if (results.length >= limit) {
        break;
      }
    }

    return {
      query,
      backend: "portable-folder",
      searchMode: "text-fallback",
      results,
    };
  };

  const read = async ({ path }) => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("read", { path });
    }
    const root = assertMemoryRoot(memoryRoot);
    const absolute = resolveMemoryPath(root, String(path ?? ""));
    const stat = await statOrNull(absolute);
    if (!stat?.isFile()) {
      throw new Error("Memory document not found.");
    }
    if (!allowedReadExtensions.has(extname(absolute).toLowerCase())) {
      throw new Error("Unsupported document type for MCP read.");
    }
    const content = await fs.readFile(absolute, "utf8");
    return {
      path: safeRelative(root, absolute),
      title: titleFromContent(absolute, content),
      docType: extname(absolute).slice(1) || "text",
      frontmatter: parseFrontmatter(content),
      content,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  };

  const writeIntake = async ({ actorId, bucket = "default", fileName, content, metadata = {} }) => {
    if (readonly) {
      throw new Error("This Living Archive MCP bridge is running in readonly mode.");
    }
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("intake-write", { actorId, bucket, fileName, content, metadata });
    }
    if (!writeFileNamePattern.test(String(fileName ?? ""))) {
      throw new Error("Intake fileName must be a plain filename.");
    }
    const root = assertMemoryRoot(memoryRoot);
    const safeBucket = String(bucket || "default").replace(/[^a-zA-Z0-9._-]/g, "-");
    const intakeRoot = resolveMemoryPath(root, join("INTAKE", "mcp", safeBucket));
    await ensureDir(intakeRoot);
    const artifactPath = resolveMemoryPath(root, join("INTAKE", "mcp", safeBucket, fileName));
    await fs.writeFile(artifactPath, String(content), "utf8");
    const metadataPath = `${artifactPath}.metadata.json`;
    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          actorId,
          bucket: safeBucket,
          fileName,
          writtenAt: nowIso(),
          source: "living-archive-mcp",
          contentSha256: createHash("sha256").update(String(content)).digest("hex"),
          metadata,
        },
        null,
        2,
      ),
      "utf8",
    );
    return {
      actorId,
      bucket: safeBucket,
      artifactPath: safeRelative(root, artifactPath),
      metadataPath: safeRelative(root, metadataPath),
    };
  };

  const requestIngest = async ({ actorId, sourcePath, sourceType, sourceRole, intent, provenance = {} }) => {
    if (readonly) {
      throw new Error("This Living Archive MCP bridge is running in readonly mode.");
    }
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("ingest-request", { actorId, sourcePath, sourceType, sourceRole, intent, provenance });
    }
    const root = assertMemoryRoot(memoryRoot);
    const absoluteSource = resolveMemoryPath(root, String(sourcePath ?? ""));
    const sourceExists = Boolean(await statOrNull(absoluteSource));
    const reviewRoot = resolveMemoryPath(root, join("INTAKE", "review-queue"));
    await ensureDir(reviewRoot);
    const id = `${Date.now()}-${createHash("sha1").update(`${actorId}:${sourcePath}:${intent}`).digest("hex").slice(0, 10)}`;
    const requestPath = join(reviewRoot, `${id}.json`);
    const queuedAt = nowIso();
    await fs.writeFile(
      requestPath,
      JSON.stringify(
        {
          requestFile: safeRelative(root, requestPath),
          queuedAt,
          actorId,
          sourcePath: safeRelative(root, absoluteSource),
          sourceType,
          sourceRole: sourceRole || null,
          intent,
          sourceExists,
          provenance: {
            ...provenance,
            bridge: "living-archive-mcp",
          },
          boundary: {
            trustedKnowledgeWrite: false,
            requiresStrategistOwnedIngest: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    return {
      requestFile: safeRelative(root, requestPath),
      queuedAt,
    };
  };

  const readJsonFiles = async (relativeRoot) => {
    const root = assertMemoryRoot(memoryRoot);
    const queueRoot = resolveMemoryPath(root, relativeRoot);
    if (!(await statOrNull(queueRoot))) {
      return [];
    }
    const records = [];
    for await (const file of walkFiles(queueRoot, { maxFiles: 2000 })) {
      if (extname(file).toLowerCase() !== ".json") {
        continue;
      }
      try {
        records.push(JSON.parse(await fs.readFile(file, "utf8")));
      } catch {
        records.push({
          file: safeRelative(root, file),
          error: "Invalid JSON artifact.",
        });
      }
    }
    return records;
  };

  const reviewQueue = async () => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("review-queue");
    }
    return readJsonFiles(join("INTAKE", "review-queue"));
  };

  const reviewArtifacts = async () => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("review-artifacts");
    }
    return readJsonFiles(join("AI_MEMORY", "provenance", "review-artifacts"));
  };

  const portableUnsupported = (toolName) => {
    throw new Error(
      `${toolName} requires the live host-mediated memory provider backend. Set RESONANTOS_MEMORY_SERVICE_URL to a ResonantOS memory service endpoint.`,
    );
  };

  const lint = async () => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("lint");
    }
    const root = assertMemoryRoot(memoryRoot);
    const findings = [];
    for (const domain of ["HUMAN_KNOWLEDGE", "EXTERNAL_KNOWLEDGE", "AI_MEMORY", "INTAKE"]) {
      const domainRoot = join(root, domain);
      if (!(await statOrNull(domainRoot))) {
        findings.push({
          severity: "warning",
          category: "missing-domain",
          target: domain,
          detail: `${domain} does not exist under the configured memory root.`,
          recommendedAction: "Initialize or migrate the Portable User State Root.",
        });
      }
    }
    const wikiHealth = await computeWikiHealth({ wikiRoot: join(root, "AI_MEMORY", "wiki") });
    for (const issue of wikiHealth.issues ?? []) {
      findings.push({
        severity: issue.severity,
        category: issue.type,
        target: "AI_MEMORY/wiki",
        detail: issue.message,
        recommendedAction: issue.type === "missing-provenance"
          ? "Run the trusted ingest/review path to add visible source provenance before relying on affected pages."
          : issue.type === "open-questions-or-contradictions"
            ? "Review contradiction/open-question markers and queue repair intake if needed."
            : "Run Living Archive maintenance or inspect the affected wiki pages.",
      });
    }
    return {
      checkedAt: nowIso(),
      reportPath: null,
      pagesChecked: wikiHealth.pages ?? 0,
      sourcesChecked: 0,
      wikiHealth,
      findings,
    };
  };

  const processIngestRequest = async ({ requestFile }) => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("process-ingest-request", { requestFile });
    }
    if (readonly) {
      throw new Error("This Living Archive MCP bridge is running in readonly mode.");
    }
    return processPortableIngestRequest({ memoryRoot: assertMemoryRoot(memoryRoot), requestFile });
  };

  const decideReview = async ({ artifactFile, actorId, action, notes }) => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("decide-review", { artifactFile, actorId, action, notes });
    }
    if (readonly) {
      throw new Error("This Living Archive MCP bridge is running in readonly mode.");
    }
    return decidePortableReview({ memoryRoot: assertMemoryRoot(memoryRoot), artifactFile, actorId, action, notes });
  };

  const promoteReviewArtifact = async ({ artifactFile, actorId }) => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("promote-review-artifact", { artifactFile, actorId });
    }
    if (readonly) {
      throw new Error("This Living Archive MCP bridge is running in readonly mode.");
    }
    return promotePortableReviewArtifact({ memoryRoot: assertMemoryRoot(memoryRoot), artifactFile, actorId });
  };

  const maintenanceCycle = async (input = {}) => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("maintenance-cycle", input);
    }
    if (readonly) {
      throw new Error("This Living Archive MCP bridge is running in readonly mode.");
    }
    return runPortableMaintenanceCycle({
      memoryRoot: assertMemoryRoot(memoryRoot),
      maxRequests: input.maxRequests,
      autoApprove: Boolean(input.autoApprove),
      actorId: input.actorId,
    });
  };

  const backgroundCycle = async (input = {}) => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("background-cycle", input);
    }
    if (readonly) {
      throw new Error("This Living Archive MCP bridge is running in readonly mode.");
    }
    return runPortableMaintenanceCycle({
      memoryRoot: assertMemoryRoot(memoryRoot),
      maxRequests: input.maxRequests,
      autoApprove: Boolean(input.autoApprove),
      actorId: input.actorId,
    });
  };

  const semanticLint = async () => {
    if (memoryServiceUrl || memoryServiceTransport) {
      return proxy("semantic-lint");
    }
    return runPortableSemanticLint({ memoryRoot: assertMemoryRoot(memoryRoot) });
  };

  const handlers = {
    living_archive_status: status,
    living_archive_search: search,
    living_archive_read: read,
    living_archive_write_intake: writeIntake,
    living_archive_request_ingest: requestIngest,
    living_archive_review_queue: reviewQueue,
    living_archive_review_artifacts: reviewArtifacts,
    living_archive_process_ingest_request: processIngestRequest,
    living_archive_decide_review: decideReview,
    living_archive_promote_review_artifact: promoteReviewArtifact,
    living_archive_maintenance_cycle: maintenanceCycle,
    living_archive_background_cycle: backgroundCycle,
    living_archive_lint: lint,
    living_archive_semantic_lint: semanticLint,
  };

  return {
    config: { memoryRoot, memoryServiceUrl, backend, maxSearchBytes, readonly },
    tools: livingArchiveTools,
    callTool: async (name, args = {}) => {
      const handler = handlers[name];
      if (!handler) {
        throw new Error(`Unknown Living Archive MCP tool: ${name}`);
      }
      return handler(args);
    },
  };
};

const success = (id, result) => ({ jsonrpc: "2.0", id, result });
const failure = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

const toolContent = (payload) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(payload, null, 2),
    },
  ],
  structuredContent: payload,
});

export const handleJsonRpc = async (bridge, message) => {
  if (!message || message.jsonrpc !== "2.0") {
    return failure(message?.id ?? null, -32600, "Invalid JSON-RPC 2.0 message.");
  }

  if (message.method === "initialize") {
    return success(message.id, {
      protocolVersion,
      capabilities: {
        tools: {},
      },
      serverInfo,
    });
  }

  if (message.method === "notifications/initialized") {
    return null;
  }

  if (message.method === "tools/list") {
    return success(message.id, {
      tools: bridge.tools,
    });
  }

  if (message.method === "tools/call") {
    try {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      return success(message.id, toolContent(await bridge.callTool(name, args)));
    } catch (error) {
      return failure(message.id, -32000, error instanceof Error ? error.message : "Living Archive MCP tool failed.");
    }
  }

  return failure(message.id, -32601, `Method not found: ${message.method}`);
};

export const runStdioServer = (bridge = createLivingArchiveBridge()) => {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  rl.on("line", async (line) => {
    if (!line.trim()) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(failure(null, -32700, "Parse error."))}\n`);
      return;
    }
    const response = await handleJsonRpc(bridge, message);
    if (response) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStdioServer();
}
