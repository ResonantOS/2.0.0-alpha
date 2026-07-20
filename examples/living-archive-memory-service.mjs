#!/usr/bin/env node
// Intent citation: docs/architecture/ADR-029-living-archive-mcp-bridge.md

import { createServer } from "node:http";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createLivingArchiveBridge } from "./living-archive-mcp.mjs";

const defaultPort = 4888;
const maxBodyBytes = 5 * 1024 * 1024;

// DD-3 (F6): operations that mutate Living Archive state. These are gated behind
// readonly-default + a required bearer token. Read operations stay unauth on a
// loopback bind. This mirrors the readonly throw-points in living-archive-mcp.mjs.
const writeMemoryOperations = new Set([
  "intake-write",
  "ingest-request",
  "process-ingest-request",
  "decide-review",
  "promote-review-artifact",
  "maintenance-cycle",
  "background-cycle",
]);

export const isWriteMemoryOperation = (operation) =>
  writeMemoryOperations.has(operation);

// Loopback classification kept intentionally narrow: a non-loopback bind is only
// allowed behind the explicit --unsafe-host / RESONANTOS_MEMORY_SERVICE_UNSAFE_HOST
// opt-in (DD-3 loopback-default axis).
const isLoopbackHost = (host) => {
  const h = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "" || h === "localhost" || h.endsWith(".localhost")) return h !== "";
  if (h === "::1") return true;
  return /^127\./.test(h);
};

// Constant-time bearer-token comparison. Returns false on any length/format
// mismatch without leaking timing about the expected token.
const tokenMatches = (expected, provided) => {
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const extractBearerToken = (request) => {
  const header = request?.headers?.authorization;
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
};

const parseArgs = (argv = process.argv.slice(2), env = process.env) => {
  let memoryRoot = env.RESONANTOS_MEMORY_ROOT ?? "";
  let port = Number.parseInt(env.RESONANTOS_MEMORY_SERVICE_PORT ?? String(defaultPort), 10);
  let host = env.RESONANTOS_MEMORY_SERVICE_HOST ?? "127.0.0.1";
  // DD-3 readonly-default: writes are off unless an explicit opt-out is given.
  let writable =
    env.RESONANTOS_MEMORY_SERVICE_WRITABLE === "1" || env.RESONANTOS_MCP_WRITABLE === "1";
  // Legacy env that forced readonly on still wins (keeps the old hardening path).
  const forcedReadonly =
    env.RESONANTOS_MCP_READONLY === "1" || env.RESONANTOS_MEMORY_SERVICE_READONLY === "1";
  let unsafeHost = env.RESONANTOS_MEMORY_SERVICE_UNSAFE_HOST === "1";
  let token = env.RESONANTOS_MEMORY_SERVICE_TOKEN ?? "";
  let maxSearchBytes = Number.parseInt(env.RESONANTOS_MCP_MAX_SEARCH_BYTES ?? "1048576", 10);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--memory-root") {
      memoryRoot = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--port") {
      port = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--host") {
      host = argv[index + 1] ?? host;
      index += 1;
      continue;
    }
    if (arg === "--token") {
      token = argv[index + 1] ?? token;
      index += 1;
      continue;
    }
    if (arg === "--max-search-bytes") {
      maxSearchBytes = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--writable" || arg === "--no-readonly") {
      writable = true;
      continue;
    }
    if (arg === "--unsafe-host") {
      unsafeHost = true;
      continue;
    }
    if (arg === "--readonly") {
      writable = false;
    }
  }

  // readonly-default: readonly unless explicitly made writable, and never writable
  // if a forced-readonly env is set.
  const readonly = forcedReadonly || !writable;

  return {
    memoryRoot: memoryRoot ? resolve(memoryRoot) : "",
    port: Number.isFinite(port) && port >= 0 ? port : defaultPort,
    host: host || "127.0.0.1",
    readonly,
    unsafeHost,
    token,
    maxSearchBytes: Number.isFinite(maxSearchBytes) && maxSearchBytes > 0 ? maxSearchBytes : 1_048_576,
  };
};

export const memoryOperationToTool = {
  status: "living_archive_status",
  search: "living_archive_search",
  read: "living_archive_read",
  "intake-write": "living_archive_write_intake",
  "ingest-request": "living_archive_request_ingest",
  "review-queue": "living_archive_review_queue",
  "review-artifacts": "living_archive_review_artifacts",
  "process-ingest-request": "living_archive_process_ingest_request",
  "decide-review": "living_archive_decide_review",
  "promote-review-artifact": "living_archive_promote_review_artifact",
  "maintenance-cycle": "living_archive_maintenance_cycle",
  "background-cycle": "living_archive_background_cycle",
  lint: "living_archive_lint",
  "semantic-lint": "living_archive_semantic_lint",
};

export const createLivingArchiveMemoryOperationEvaluator = (options = {}) => {
  const config = {
    memoryRoot: options.memoryRoot ? resolve(options.memoryRoot) : "",
    readonly: Boolean(options.readonly),
    maxSearchBytes: options.maxSearchBytes ?? 1_048_576,
  };
  const bridge = createLivingArchiveBridge(config);

  return async (operation, input = {}) => {
    const toolName = memoryOperationToTool[operation];
    if (!toolName) {
      return {
        status: 404,
        payload: { error: `Unsupported Living Archive memory operation: ${operation}.` },
      };
    }
    try {
      const result = await bridge.callTool(toolName, input);
      return { status: 200, payload: result };
    } catch (error) {
      return {
        status: 400,
        payload: {
          error: error instanceof Error ? error.message : "Living Archive memory operation failed.",
          operation,
        },
      };
    }
  };
};

const jsonResponse = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "http://localhost",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
};

const readJsonBody = (request) =>
  new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBodyBytes) {
        rejectBody(new Error("Request body exceeds the Living Archive memory service limit."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(body));
      } catch {
        rejectBody(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", rejectBody);
  });

export const createLivingArchiveMemoryService = (options = {}) => {
  // DD-3 readonly-default: writes are off unless the caller explicitly passes
  // readonly: false (an opt-out). Omitting readonly => readonly ON.
  const readonly = options.readonly === false ? false : true;
  const evaluateOperation = createLivingArchiveMemoryOperationEvaluator({ ...options, readonly });
  const token = typeof options.token === "string" ? options.token : "";

  return createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      jsonResponse(response, 204, {});
      return;
    }
    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "Living Archive memory service accepts POST requests only." });
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = /^\/memory\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      jsonResponse(response, 404, { error: "Unknown Living Archive memory service route." });
      return;
    }

    const operation = decodeURIComponent(match[1]);
    if (!memoryOperationToTool[operation]) {
      jsonResponse(response, 404, { error: `Unsupported Living Archive memory operation: ${operation}.` });
      return;
    }

    // DD-3 (F6): mutating operations require both writes-enabled and a valid
    // bearer token. Reads stay unauth on the loopback bind.
    if (isWriteMemoryOperation(operation)) {
      if (readonly) {
        jsonResponse(response, 403, {
          error: "Living Archive memory service is readonly; writes are disabled.",
          operation,
        });
        return;
      }
      if (!tokenMatches(token, extractBearerToken(request))) {
        jsonResponse(response, 401, {
          error: "Living Archive memory service write operations require a valid bearer token.",
          operation,
        });
        return;
      }
    }

    try {
      const input = await readJsonBody(request);
      const result = await evaluateOperation(operation, input);
      jsonResponse(response, result.status, result.payload);
    } catch (error) {
      jsonResponse(response, 400, {
        error: error instanceof Error ? error.message : "Living Archive memory operation failed.",
        operation,
      });
    }
  });
};

const main = async () => {
  const config = parseArgs();

  // DD-3 loopback-default: refuse a non-loopback bind unless --unsafe-host opt-in.
  if (!isLoopbackHost(config.host) && !config.unsafeHost) {
    process.stderr.write(
      `Refusing to bind Living Archive memory service to non-loopback host "${config.host}" without --unsafe-host (RESONANTOS_MEMORY_SERVICE_UNSAFE_HOST=1).\n`,
    );
    process.exitCode = 1;
    return;
  }
  // Writes require a configured token; without one the service can only be readonly.
  if (!config.readonly && config.token.length === 0) {
    process.stderr.write(
      "Refusing to enable writes without RESONANTOS_MEMORY_SERVICE_TOKEN (or --token); falling back to readonly.\n",
    );
    config.readonly = true;
  }

  const server = createLivingArchiveMemoryService(config);
  await new Promise((resolveListen) => server.listen(config.port, config.host, resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  process.stderr.write(
    JSON.stringify(
      {
        service: "resonantos-living-archive-memory-service",
        status: "listening",
        endpoint: `http://${config.host}:${port}`,
        memoryRoot: config.memoryRoot,
        readonly: config.readonly,
        tokenRequiredForWrites: config.token.length > 0,
      },
      null,
      2,
    ) + "\n",
  );
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}
