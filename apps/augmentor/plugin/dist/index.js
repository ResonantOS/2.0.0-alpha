// src/index.ts
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, readFileSync, openSync, writeSync, closeSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { WebSocketServer } from "ws";

// ../wire.mjs
function encode(obj) {
  return JSON.stringify(obj);
}
function decode(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
var Pending = class {
  #map = /* @__PURE__ */ new Map();
  // id -> { resolve, reject, timer, bind }
  get size() {
    return this.#map.size;
  }
  has(id) {
    return this.#map.has(id);
  }
  /** The stored entry (for bind checks) or undefined. */
  get(id) {
    return this.#map.get(id);
  }
  /**
   * Register an in-flight request. Returns [resolve, reject] for the
   * caller's promise plumbing. `timeoutMs` settles the entry as a
   * rejection after the deadline (cleared on settle).
   */
  add(id, { bind = null, timeoutMs = 0 } = {}) {
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const e = this.#map.get(id);
        if (!e) return;
        this.#map.delete(id);
        e.reject(new Error(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }
    let resolve, reject;
    const handle = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#map.set(id, { resolve, reject, timer, bind, promise: handle });
    return handle;
  }
  /** Settle one entry. Returns false when the id was unknown (late reply). */
  settle(id, result, error) {
    const e = this.#map.get(id);
    if (!e) return false;
    this.#map.delete(id);
    if (e.timer) clearTimeout(e.timer);
    if (error) e.reject(error instanceof Error ? error : new Error(String(error)));
    else e.resolve(result);
    return true;
  }
  /** Reject every entry where pred(entry) is true (e.g. socket closed). */
  dropWhere(pred, error = new Error("disconnected")) {
    for (const [id, e] of [...this.#map]) {
      if (!pred(e)) continue;
      this.#map.delete(id);
      if (e.timer) clearTimeout(e.timer);
      e.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  /** Reject everything (port/socket closed with no per-entry routing). */
  dropAll(error = new Error("disconnected")) {
    this.dropWhere(() => true, error);
  }
};

// src/index.ts
var name = "dsh-augmentor";
var inject = ["tools", "workspaceRegistry", "sessionPersistence"];
var Config = z.object({
  apiPath: z.string().default("/api/augmentor"),
  wsPath: z.string().default("/api/augmentor/ws"),
  commandTimeoutMs: z.number().default(3e4),
  wsToken: z.string().default(""),
  chatDir: z.string().default("~/Augmentor"),
  agentPreset: z.string().default("augmentor"),
  workspaceTitle: z.string().default("Augmentor Chat"),
  retentionDays: z.number().default(14),
  deleteAfterDays: z.number().default(0),
  sweepEveryMs: z.number().default(60 * 60 * 1e3),
  sweepFirstDelayMs: z.number().default(60 * 1e3)
});
var TOKEN_FILE_NAME = "augmentor-ws-token";
var sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
  }
};
function resolveToken(configured) {
  if (configured) return { token: configured, source: "config" };
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  const file = path.join(home, TOKEN_FILE_NAME);
  const readExisting = () => {
    try {
      const existing2 = readFileSync(file, "utf8").trim();
      if (existing2) return existing2;
    } catch {
    }
    return null;
  };
  const existing = readExisting();
  if (existing) return { token: existing, source: "file" };
  const token = randomBytes(16).toString("hex");
  try {
    const fd = openSync(file, "wx", 384);
    try {
      writeSync(fd, token + "\n");
    } finally {
      closeSync(fd);
    }
    return { token, source: "generated" };
  } catch (e) {
    if (e?.code !== "EEXIST") {
      return { token, source: "generated" };
    }
    for (let i = 0; i < 20; i++) {
      const winner = readExisting();
      if (winner) return { token: winner, source: "file" };
      sleepSync(5);
    }
    console.error(`[dsh-augmentor] token race: concurrent create, re-read came up empty \u2014 falling back to the local token (channel may reject it)`);
    return { token, source: "generated" };
  }
}
var PROTOCOL = "augmentor-pipe/v1";
function packageVersion() {
  try {
    const here = new URL(import.meta.url);
    here.search = "";
    const p = JSON.parse(readFileSync(new URL("../package.json", here), "utf8"));
    return typeof p.version === "string" && p.version ? p.version : "unknown";
  } catch {
    return "unknown";
  }
}
var VERSION = packageVersion();
function isSourceMounted() {
  try {
    const here = new URL(import.meta.url);
    here.search = "";
    const p = here.pathname;
    return p.endsWith(`${path.sep}src${path.sep}index.ts`) || !p.includes(`${path.sep}node_modules${path.sep}dsh-augmentor${path.sep}`);
  } catch {
    return false;
  }
}
var SOURCE_MOUNTED = isSourceMounted();
function tokenEquals(presented, expected) {
  if (presented == null || presented === "") return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
function apply(ctx, config) {
  const pipes = /* @__PURE__ */ new Set();
  const pending = new Pending();
  const wss = new WebSocketServer({ noServer: true });
  function activePipe() {
    let last;
    for (const p of pipes) last = p;
    return last;
  }
  function browserRequest(params, timeoutMs) {
    const target = activePipe();
    if (!target) return Promise.resolve({ ok: false, error: "no browser client connected" });
    const id = randomUUID();
    const roundTrip = pending.add(id, { bind: target, timeoutMs });
    if (target.readyState === target.OPEN) {
      target.send(encode({ type: "request", id, method: "browser/execute", params }));
    } else {
      pending.settle(id, { ok: false, error: "browser client disconnected" }, null);
    }
    return roundTrip.catch((e) => ({ ok: false, error: e.message }));
  }
  const chatDirRaw = config.chatDir.startsWith("~/") ? path.join(os.homedir(), config.chatDir.slice(2)) : config.chatDir;
  let chatDir;
  try {
    mkdirSync(chatDirRaw, { recursive: true });
    chatDir = realpathSync(chatDirRaw);
  } catch (e) {
    throw new Error(`dsh-augmentor: cannot prepare chat dir ${config.chatDir} (${e.message})`);
  }
  console.log("[dsh-augmentor] chat dir ready: %s (workspace: %s)", chatDir, config.workspaceTitle);
  const registry = ctx.get("workspaceRegistry");
  const persistence = ctx.get("sessionPersistence");
  const ensureWorkspace = () => registry.create(chatDir, config.workspaceTitle);
  const chatWorkspace = () => registry.resolveByPath(chatDir);
  let updateJob = null;
  const UPDATE_TIMEOUT_MS = 5 * 60 * 1e3;
  const UPDATE_OUT_TAIL = 4e3;
  function dshHome() {
    return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  }
  function readDeclaredDep(dir) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      const dep = pkg?.dependencies?.["dsh-augmentor"] ?? pkg?.devDependencies?.["dsh-augmentor"];
      return typeof dep === "string" ? dep : null;
    } catch {
      return null;
    }
  }
  function readInstalledVersion(dir) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "node_modules", "dsh-augmentor", "package.json"), "utf8"));
      return typeof pkg?.version === "string" ? pkg.version : null;
    } catch {
      return null;
    }
  }
  function discoverProfile(home) {
    let names = [];
    try {
      names = readdirSync(path.join(home, "profiles"));
    } catch {
      return { error: `no profiles directory at ${path.join(home, "profiles")}` };
    }
    const candidates = [];
    for (const name2 of names) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name2)) continue;
      const dir = path.join(home, "profiles", name2);
      const declared = readDeclaredDep(dir);
      const installed = readInstalledVersion(dir);
      if (!declared && !installed) continue;
      candidates.push({ name: name2, declared, installed });
    }
    if (!candidates.length) {
      return { error: `no DSH profile with dsh-augmentor found under ${path.join(home, "profiles")}` };
    }
    const exact = candidates.filter((c) => c.installed === VERSION);
    const pool = exact.length ? exact : candidates;
    if (pool.length > 1) {
      return {
        error: `multiple DSH profiles have dsh-augmentor: ${pool.map((c) => c.name).join(", ")} \u2014 update the profile that drives this session manually`
      };
    }
    return { name: pool[0].name, installed: pool[0].installed };
  }
  function startPluginUpdate(version) {
    if (SOURCE_MOUNTED) {
      throw new Error(
        "this DSH loads dsh-augmentor from source (a dev mount, not an npm-installed profile package) \u2014 the in-panel update only manages installed plugins; pull the new version into your source checkout and bump the ?src= query in the home patch"
      );
    }
    const found = discoverProfile(dshHome());
    if ("error" in found) throw new Error(found.error);
    const job = {
      status: "running",
      version,
      profile: found.name,
      startedAt: Date.now(),
      output: `$ dsh plugin --profile ${found.name} add dsh-augmentor@${version}
`
    };
    updateJob = job;
    const child = spawn("dsh", ["plugin", "--profile", found.name, "add", `dsh-augmentor@${version}`], {
      env: process.env
    });
    const push = (chunk) => {
      job.output = (job.output + chunk.toString("utf8")).slice(-UPDATE_OUT_TAIL);
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }, UPDATE_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(killer);
      if (updateJob !== job) return;
      job.status = "error";
      job.finishedAt = Date.now();
      job.exitCode = null;
      push(`
dsh CLI could not start: ${e.message}
manual: dsh plugin --profile ${found.name} add dsh-augmentor@${version}
`);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (updateJob !== job) return;
      job.status = code === 0 ? "done" : "error";
      job.finishedAt = Date.now();
      job.exitCode = code;
    });
    return job;
  }
  async function handlePipeRequest(source, frame) {
    const id = frame.id;
    const reply = (out) => {
      if (source.readyState === source.OPEN) source.send(encode({ type: "reply", id, result: out }));
    };
    try {
      const sessionId = String(frame.params?.sessionId ?? "");
      if (frame.method === "augmentor/save") {
        if (!sessionId) throw new Error("save: missing sessionId");
        const ws = await ensureWorkspace();
        await ws.attachSession(sessionId);
        reply({ ok: true, saved: true, sessionId, workspace: { id: ws.id, title: ws.title, path: ws.path } });
      } else if (frame.method === "augmentor/unsave") {
        if (!sessionId) throw new Error("unsave: missing sessionId");
        const ws = await chatWorkspace();
        if (ws) await ws.detachSession(sessionId);
        reply({ ok: true, saved: false, sessionId, workspace: ws ? { id: ws.id, title: ws.title, path: ws.path } : null });
      } else if (frame.method === "augmentor/state") {
        const ws = await chatWorkspace();
        reply({ ok: true, saved: [...ws?.sessionIds ?? []], archived: [...registry.archivedSessionIds] });
      } else if (frame.method === "augmentor/update-plugin") {
        const version = String(frame.params?.version ?? "");
        if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid version: ${JSON.stringify(frame.params?.version)}`);
        if (updateJob?.status === "running") {
          reply({ ok: true, started: false, job: { ...updateJob } });
        } else {
          const job = startPluginUpdate(version);
          reply({ ok: true, started: true, job: { ...job } });
        }
      } else if (frame.method === "augmentor/update-status") {
        reply({ ok: true, job: updateJob ? { ...updateJob } : { status: "idle" } });
      } else {
        reply({ ok: false, error: `unknown augmentor method: ${frame.method}` });
      }
    } catch (e) {
      const message = e.message ?? String(e);
      const friendly = /cwd/i.test(message) ? `${message} \u2014 this chat was created outside ${chatDir}; start a new chat to save it` : message;
      reply({ ok: false, error: friendly });
    }
  }
  const DAY_MS = 24 * 60 * 60 * 1e3;
  async function sweep() {
    try {
      const headers = await persistence.list();
      const archived = new Set(registry.archivedSessionIds);
      const claimed = /* @__PURE__ */ new Set();
      for (const ws of registry.list()) for (const sid of ws.sessionIds) claimed.add(sid);
      const now = Date.now();
      const retentionMs = config.retentionDays * DAY_MS;
      const deleteMs = config.deleteAfterDays > 0 ? config.deleteAfterDays * DAY_MS : Infinity;
      let archivedNow = 0;
      let deleted = 0;
      for (const h of headers) {
        if (typeof h.cwd !== "string") continue;
        let canon;
        try {
          canon = realpathSync(h.cwd);
        } catch {
          continue;
        }
        if (canon !== chatDir) continue;
        if (archived.has(h.id) || claimed.has(h.id)) continue;
        if (now - h.createdAt < retentionMs) continue;
        await registry.archiveSession(h.id);
        archivedNow++;
        if (now - h.createdAt > deleteMs) {
          const loc = persistence.locate(h);
          if (loc) {
            try {
              rmSync(loc.path, { recursive: true, force: true });
              deleted++;
            } catch (e) {
              console.warn("[dsh-augmentor] housekeeping: could not delete artifact for %s (%s)", h.id, e.message);
            }
          }
        }
      }
      if (archivedNow || deleted) console.log("[dsh-augmentor] housekeeping sweep: archived %d, deleted %d", archivedNow, deleted);
    } catch (e) {
      console.warn("[dsh-augmentor] housekeeping sweep failed: %s", e.message);
    }
  }
  {
    let interval;
    const first = setTimeout(() => {
      void sweep();
      interval = setInterval(() => void sweep(), config.sweepEveryMs);
    }, config.sweepFirstDelayMs);
    ctx.effect(() => () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    }, "dsh-augmentor: housekeeping sweep");
  }
  wss.on("connection", (pipe) => {
    pipes.add(pipe);
    pipe.send(encode({ type: "welcome", name: "dsh-augmentor", protocol: PROTOCOL, version: VERSION }));
    pipe.on("message", (data) => {
      const frame = decode(String(data));
      if (!frame || typeof frame !== "object") return;
      if (frame.type === "request" && frame.id !== void 0 && frame.method) {
        void handlePipeRequest(pipe, frame);
        return;
      }
      if (frame.type !== "reply" || frame.id === void 0) return;
      const entry = pending.get(frame.id);
      if (!entry) return;
      if (entry.bind !== pipe) return;
      if (frame.error) pending.settle(frame.id, void 0, new Error(frame.error.message ?? "browser error"));
      else pending.settle(frame.id, { ok: true, result: frame.result }, null);
    });
    const drop = () => {
      pipes.delete(pipe);
      pending.dropWhere((e) => e.bind === pipe, new Error("browser client disconnected"));
    };
    pipe.on("close", drop);
    pipe.on("error", drop);
  });
  const resolved = resolveToken(config.wsToken);
  if (resolved.source === "none" || !resolved.token) {
    console.warn("[dsh-augmentor] action channel has no token resolvable; running open (dev only)");
  }
  let currentServer;
  let routesEffect;
  const registerActionChannel = (webServer2) => {
    if (webServer2 === currentServer) return;
    if (routesEffect) routesEffect.dispose();
    currentServer = webServer2;
    routesEffect = ctx.effect(() => {
      const disposeAuth = webServer2.register({
        kind: "exact",
        path: `${config.apiPath}/auth`,
        handler: (req, res) => {
          res.setHeader("cache-control", "no-store");
          const remote = req.socket.remoteAddress;
          let localHost = false;
          try {
            localHost = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(`http://${req.headers.host}`).hostname);
          } catch {
          }
          if (req.method !== "POST" || !localHost || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? "") || req.headers.origin !== void 0 || req.headers["sec-fetch-site"] !== void 0 || !resolved.token || !tokenEquals(typeof req.headers["x-augmentor-token"] === "string" ? req.headers["x-augmentor-token"] : null, resolved.token)) {
            res.writeHead(403);
            res.end("forbidden");
            return;
          }
          const connection = ctx.get("connection");
          if (!connection?.authenticatedUrl) {
            res.writeHead(503);
            res.end("DSH authentication service unavailable");
            return;
          }
          const token = new URL(connection.authenticatedUrl("http://127.0.0.1")).searchParams.get("token");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ token }));
        }
      });
      const disposeRoute = webServer2.register({
        kind: "exact",
        path: config.apiPath,
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
            res.end("method not allowed");
            return;
          }
          let saved = [];
          try {
            saved = [...(await registry.resolveByPath(chatDir))?.sessionIds ?? []];
          } catch {
          }
          const body = JSON.stringify({
            name: "dsh-augmentor",
            protocol: PROTOCOL,
            version: VERSION,
            wsPath: config.wsPath,
            wsTokenRequired: Boolean(resolved.token),
            wsTokenSource: resolved.source,
            dshHome: dshHome(),
            chatCwd: chatDir,
            agentPreset: config.agentPreset,
            saved,
            pipes: pipes.size,
            time: Date.now()
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(body);
        }
      });
      const disposeUpgrade = webServer2.registerUpgrade({
        path: config.wsPath,
        handler(req, socket, head) {
          if (resolved.token) {
            let presented = req.headers["x-augmentor-token"] ?? null;
            if (presented == null) {
              try {
                presented = new URL(req.url ?? "", "http://localhost").searchParams.get("token");
              } catch {
                presented = null;
              }
            }
            if (!tokenEquals(presented, resolved.token)) {
              console.warn("[dsh-augmentor] action channel upgrade rejected (bad or missing token)");
              socket.destroy();
              return;
            }
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
          });
        }
      });
      return [disposeAuth, disposeRoute, disposeUpgrade];
    }, "dsh-augmentor: action channel routes");
    console.log("[dsh-augmentor] action channel ready (api=%s, ws token: %s)", config.apiPath, resolved.source);
  };
  const webServer = ctx.get("webServer");
  if (webServer) {
    registerActionChannel(webServer);
  } else {
    console.log("[dsh-augmentor] webServer service not up yet; watching for it (headless profiles never provide it)");
    ctx.on("internal/service", (name2, value) => {
      if (name2 === "webServer") registerActionChannel(value);
    });
  }
  ctx.tools.register(defineTool({
    name: "browser_tabs_list",
    description: "List the browser tabs the Augmentor extension can see, through its native pipe. Tabs hosting the user's DSH web session carry a `dsh: true` marker: the agent never navigates those \u2014 browser_navigate opens a dedicated tab instead. Returns {ok: true, tabs} when a browser client is connected and {ok: false, error} when none is.",
    parameters: {},
    output: {
      schema: {
        // dsh-tools value-schema DSL: object nodes carry no `required`
        // array — a property is required by marking `required: true` inside
        // its own schema, and `additionalProperties` must be explicit.
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          tabs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                // chrome.tabs reports url/title as null for pending/devtools
                // tabs and id as undefined while a tab is being torn down.
                id: { oneOf: [{ type: "number" }, { type: "null" }] },
                url: { oneOf: [{ type: "string" }, { type: "null" }] },
                title: { oneOf: [{ type: "string" }, { type: "null" }] },
                active: { type: "boolean", required: true },
                focusedWindow: { type: "boolean", required: true },
                // Set only on the tab hosting the user's DSH web session.
                dsh: { type: "boolean" }
              }
            }
          },
          error: { type: "string" }
        }
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: "text", text: value.error ?? "no tabs" }];
        if (!value.tabs.length) return [{ type: "text", text: "0 tabs open in the user's browser" }];
        return [{ type: "text", text: value.tabs.map((t) => `tab ${t.id ?? "?"}${t.active ? " [active]" : ""}${t.focusedWindow ? " [focused window]" : ""}${t.dsh ? " [DSH session]" : ""}: ${t.title ?? "(untitled)"} \u2014 ${t.url ?? "(no url yet)"}`).join("\n") }];
      }
    },
    async execute(_args, exec) {
      if (exec.signal.aborted) throw new Error("cancelled");
      const round = await browserRequest({ action: "tabs_list" }, config.commandTimeoutMs);
      if (!round.ok) return { ok: false, error: round.error };
      const value = round.result;
      return { ok: true, tabs: value?.tabs ?? [] };
    }
  }));
  const act = (params) => browserRequest(params, config.commandTimeoutMs);
  ctx.tools.register(defineTool({
    name: "browser_navigate",
    description: "Open an http(s) URL in the user's real browser. It navigates the agent's current work tab (creating a dedicated tab if there is no workable one, or if the current tab is the user's DSH session \u2014 that tab is never navigated away) and a frost veil with progress is shown on that tab while it runs. Returns the settled URL and page title. Prefer this over any other way of reaching a page, then use browser_snapshot to read what loaded.",
    parameters: {
      url: { type: "string", required: true, description: "The http or https URL to open." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          url: { type: "string" },
          title: { oneOf: [{ type: "string" }, { type: "null" }] },
          newTab: { type: "boolean" },
          error: { type: "string" }
        }
      },
      render: (_args, value) => [
        { type: "text", text: value.ok ? `Opened ${value.url ?? "a page"}${value.title ? ` \u2014 \u201C${value.title}\u201D` : ""}${value.newTab ? " (new tab)" : ""}` : `navigate failed: ${value.error ?? "unknown error"}` }
      ]
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error("cancelled");
      const round = await act({ action: "navigate", url: args.url });
      if (!round.ok) return { ok: false, error: round.error };
      const value = round.result;
      return { ok: true, url: value?.url ?? String(args.url), title: value?.title ?? null, newTab: Boolean(value?.newTab) };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_snapshot",
    description: "Read the agent's current work tab in the user's browser: page title, URL, visible text (up to 6000 characters) and the first 40 links. This is how you see a page after browser_navigate and before browser_click / browser_type. Fails when the work tab is not a readable http(s) page (e.g. the new-tab page) or when the user's tab is their DSH session \u2014 in that case call browser_navigate, which opens a dedicated tab.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          title: { type: "string" },
          url: { type: "string" },
          text: { type: "string" },
          links: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string", required: true },
                href: { type: "string", required: true }
              }
            }
          },
          error: { type: "string" }
        }
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: "text", text: `snapshot failed: ${value.error ?? "unknown error"}` }];
        const parts = [`Page: ${value.title}`, `URL: ${value.url}`, "", value.text || "(no visible text)"];
        if (value.links?.length) {
          parts.push("", `Links (${value.links.length}):`);
          for (const l of value.links) parts.push(`- [${l.text}](${l.href})`);
        }
        return [{ type: "text", text: parts.join("\n") }];
      }
    },
    async execute(_args, exec) {
      if (exec.signal.aborted) throw new Error("cancelled");
      const round = await act({ action: "snapshot" });
      if (!round.ok) return { ok: false, error: round.error };
      const value = round.result;
      return { ok: true, title: value?.title ?? "", url: value?.url ?? "", text: value?.text ?? "", links: value?.links ?? [] };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_click",
    description: "Click an element in the agent's current work tab in the user's browser, identified by a CSS selector. The element pulses visibly in the user's accent color, so the user sees exactly where the click lands. Use browser_snapshot first to choose a selector from the visible page. Returns the clicked element's tag and a human-readable name, or an error when no element matches the selector.",
    parameters: {
      selector: { type: "string", required: true, description: 'CSS selector of the element to click, e.g. "#save" or "button.login".' }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          tag: { type: "string" },
          text: { type: "string" },
          name: { type: "string" },
          error: { type: "string" }
        }
      },
      render: (_args, value) => [
        { type: "text", text: value.ok ? `Clicked ${value.name ?? value.tag ?? "an element"}${value.text ? ` \u201C${value.text}\u201D` : ""}` : `click failed: ${value.error ?? "unknown error"}` }
      ]
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error("cancelled");
      const round = await act({ action: "click", selector: args.selector });
      if (!round.ok) return { ok: false, error: round.error };
      const value = round.result;
      if (value?.ok === false) return { ok: false, error: value.error ?? "no element matched the selector" };
      return { ok: true, tag: value?.tag ?? "", text: value?.text ?? "", name: value?.name ?? "" };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_type",
    description: "Type text into an element (input, textarea, or contenteditable) in the agent's current work tab in the user's browser, identified by a CSS selector. Replaces any existing value and dispatches input + change events so page scripts react. The element pulses visibly, so the user sees where the text lands. Returns the element's tag and a human-readable name, or an error when no element matches the selector.",
    parameters: {
      selector: { type: "string", required: true, description: 'CSS selector of the element to type into, e.g. "#search" or "input[name=email]".' },
      text: { type: "string", required: true, description: "The text to type (replaces the element's current value)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          tag: { type: "string" },
          name: { type: "string" },
          error: { type: "string" }
        }
      },
      render: (_args, value) => [
        { type: "text", text: value.ok ? `Typed into ${value.name ?? value.tag ?? "an element"}` : `type failed: ${value.error ?? "unknown error"}` }
      ]
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error("cancelled");
      const round = await act({ action: "type", selector: args.selector, text: args.text });
      if (!round.ok) return { ok: false, error: round.error };
      const value = round.result;
      if (value?.ok === false) return { ok: false, error: value.error ?? "no element matched the selector" };
      return { ok: true, tag: value?.tag ?? "", name: value?.name ?? "" };
    }
  }));
}
export {
  Config,
  apply,
  inject,
  name
};
