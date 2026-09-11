import { timingSafeEqual, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open as defaultOpen, readFile } from "node:fs/promises";
import path from "node:path";
import { parse, serialize, defaultTreeAdapter } from "parse5";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const POLICY_ERROR = "Unsafe development server policy.";
const PAGE_KEY_ERROR = "Development page key is invalid.";
const LOOPBACK_DIAGNOSTIC = "Development bridge config unavailable: loopback URL required.";
const BODY_NOT_FOUND = "Not found.\n";
const BODY_AUTH = "Authentication required.\n";
const BODY_FORBIDDEN = "Forbidden.\n";
const BODY_UNAVAILABLE = "Development page unavailable.\n";
const WWW_AUTHENTICATE = 'Basic realm="ResonantOS development", charset="UTF-8"';
const PAGE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_PATTERN = /^[\x21-\x7E]{1,512}$/;
const CONFIG_PREFIX = "globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze(";
const CONFIG_SUFFIX = ");";
const RESERVED_PREFIX = "/__resonantos_dev_bridge__";
const MODULE_PATH = "/__resonantos_dev_bridge__/config.mjs";
const GENERATED_REL = path.join(
  "browser-first",
  "resonantos-side-panel-extension",
  "src",
  "bridge-config.generated.js",
);
const MAX_CONFIG_BYTES = 16384;
const NONCE_TTL_MS = 60000;
const NONCE_CAPACITY = 1024;
const AUTH_HEADER_MAX = 256;
const SENSITIVE_IGNORE_GENERATED = "**/bridge-config.generated.js";
const SENSITIVE_IGNORE_USER = "**/ResonantOS_User/**";
const SECURITY_HEADERS = {
  "Cache-Control": "private, no-store",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Host, Authorization, Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest",
};

/**
 * @typedef {Readonly<{bridgeUrl: string, bridgeToken: string, capabilityBootstrapToken: string}>} BridgeConfig
 * @typedef {{issue: () => string | null, consume: (nonce: string) => boolean, clear: () => void}} NonceStore
 * @typedef {{openFile?: typeof import('node:fs/promises').open, uid?: () => number, onNonLoopback?: () => void}} ReaderDeps
 * @typedef {{server: {host?: unknown, port?: unknown, strictPort?: unknown, allowedHosts?: unknown, fs?: {strict?: unknown, deny?: unknown}, cors?: unknown, watch?: {ignored?: unknown} | null, origin?: unknown, hmr?: boolean | {host?: unknown}}, additionalAllowedHosts?: unknown}} DevServerPolicyInput
 * @typedef {{readConfig?: (root: string, onNonLoopback: () => void) => Promise<BridgeConfig | null>, env?: () => NodeJS.ProcessEnv, now?: () => number, random?: () => string, createCspNonce?: () => string, expectedPort?: number}} DevBridgeDeps
 */

export const EXPECTED_DEV_SERVER_FS_DENY = Object.freeze([
  "**/bridge-config.generated.js",
  "**/ResonantOS_User/**",
  ".env",
  ".env.*",
  "*.{crt,pem}",
  "**/.git/**",
]);

function policyFail() {
  throw new Error(POLICY_ERROR);
}

function ignoredPatterns(watch) {
  if (watch == null || typeof watch !== "object") {
    return [];
  }
  const ignored = watch.ignored;
  if (Array.isArray(ignored)) {
    return ignored;
  }
  if (typeof ignored === "string") {
    return [ignored];
  }
  return [];
}

export function assertDevServerPolicy(config, expectedPort) {
  if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535) {
    policyFail();
  }
  if (config == null || config.server == null || typeof config.server !== "object") {
    policyFail();
  }
  if (config.server.host !== "127.0.0.1") {
    policyFail();
  }
  if (config.server.port !== expectedPort) {
    policyFail();
  }
  if (config.server.strictPort !== true) {
    policyFail();
  }
  if (
    !Array.isArray(config.server.allowedHosts) ||
    config.server.allowedHosts.length !== 1 ||
    config.server.allowedHosts[0] !== "127.0.0.1"
  ) {
    policyFail();
  }
  if (config.server.fs == null || config.server.fs.strict !== true) {
    policyFail();
  }
  const deny = config.server.fs.deny;
  if (!Array.isArray(deny)) {
    policyFail();
  }
  if (!deny.includes("**/bridge-config.generated.js")) {
    policyFail();
  }
  if (!deny.includes("**/ResonantOS_User/**")) {
    policyFail();
  }
  if (!deny.includes(".env")) {
    policyFail();
  }
  if (!deny.includes(".env.*")) {
    policyFail();
  }
  if (!deny.includes("*.{crt,pem}")) {
    policyFail();
  }
  if (!deny.includes("**/.git/**")) {
    policyFail();
  }
  if (config.server.cors !== false) {
    policyFail();
  }
  if (!Array.isArray(config.additionalAllowedHosts)) {
    policyFail();
  }
  for (const host of config.additionalAllowedHosts) {
    if (host !== "127.0.0.1") {
      policyFail();
    }
  }
  if (config.server.origin !== undefined && config.server.origin !== null) {
    policyFail();
  }
  const hmr = config.server.hmr;
  if (hmr !== null && typeof hmr === "object" && hmr.host !== undefined && hmr.host !== null) {
    policyFail();
  }
  const ignored = ignoredPatterns(config.server.watch);
  if (!ignored.includes(SENSITIVE_IGNORE_GENERATED)) {
    policyFail();
  }
  if (!ignored.includes(SENSITIVE_IGNORE_USER)) {
    policyFail();
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isTokenString(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function serializeBridgeConfig(config) {
  return JSON.stringify({
    bridgeUrl: config.bridgeUrl,
    bridgeToken: config.bridgeToken,
    capabilityBootstrapToken: config.capabilityBootstrapToken,
  }).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function parseBridgeUrl(raw, onNonLoopback) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.hostname !== "127.0.0.1") {
    onNonLoopback?.();
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return null;
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return null;
  }
  if (parsed.search !== "") {
    return null;
  }
  if (parsed.hash !== "") {
    return null;
  }
  return parsed.origin;
}

export function parseGeneratedBridgeConfig(source, onNonLoopback) {
  if (typeof source !== "string") {
    return null;
  }
  const trimmed = source.trim();
  if (!trimmed.startsWith(CONFIG_PREFIX)) {
    return null;
  }
  if (!trimmed.endsWith(CONFIG_SUFFIX)) {
    return null;
  }
  const jsonText = trimmed.slice(CONFIG_PREFIX.length, trimmed.length - CONFIG_SUFFIX.length);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  if (!isTokenString(parsed.bridgeUrl)) {
    return null;
  }
  if (!isTokenString(parsed.bridgeToken)) {
    return null;
  }
  if (!isTokenString(parsed.capabilityBootstrapToken)) {
    return null;
  }
  const bridgeUrl = parseBridgeUrl(parsed.bridgeUrl, onNonLoopback);
  if (bridgeUrl === null) {
    return null;
  }
  return Object.freeze({
    bridgeUrl,
    bridgeToken: parsed.bridgeToken,
    capabilityBootstrapToken: parsed.capabilityBootstrapToken,
  });
}

function defaultUid() {
  if (typeof process.getuid !== "function") {
    throw new Error("unavailable");
  }
  return process.getuid();
}

export async function readGeneratedBridgeConfig(root, deps = {}) {
  const openFile = deps.openFile ?? defaultOpen;
  const uid = deps.uid ?? defaultUid;
  const target = path.join(root, GENERATED_REL);
  let handle;
  try {
    handle = await openFile(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return null;
    }
    let owner;
    try {
      owner = uid();
    } catch {
      return null;
    }
    if (typeof owner !== "number" || stats.uid !== owner) {
      return null;
    }
    if ((stats.mode & 0o077) !== 0) {
      return null;
    }
    if (stats.size > MAX_CONFIG_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    if (offset > MAX_CONFIG_BYTES) {
      return null;
    }
    return parseGeneratedBridgeConfig(buffer.subarray(0, offset).toString("utf8"), deps.onNonLoopback);
  } catch {
    return null;
  } finally {
    try {
      await handle.close();
    } catch {
    }
  }
}

function defaultRandomNonce() {
  return randomBytes(32).toString("base64url");
}

export function createPageNonces(now = Date.now, random = defaultRandomNonce) {
  const entries = new Map();
  const pruneExpired = (time, keep) => {
    for (const [nonce, expiry] of entries) {
      if (nonce !== keep && expiry <= time) {
        entries.delete(nonce);
      }
    }
  };
  return {
    issue() {
      const time = now();
      pruneExpired(time);
      if (entries.size >= NONCE_CAPACITY) {
        return null;
      }
      const nonce = random();
      entries.set(nonce, time + NONCE_TTL_MS);
      return nonce;
    },
    consume(nonce) {
      const time = now();
      pruneExpired(time, nonce);
      if (!entries.has(nonce)) {
        return false;
      }
      const expiry = entries.get(nonce);
      if (expiry <= time) {
        entries.delete(nonce);
        return false;
      }
      entries.delete(nonce);
      return true;
    },
    clear() {
      entries.clear();
    },
  };
}

export function createCspNonce() {
  return randomBytes(32).toString("base64url");
}

export function renderBridgeModule(config) {
  if (config === null) {
    return "delete globalThis.__RESONANTOS_BRIDGE_CONFIG__;\nawait import('/src/main.tsx');\n";
  }
  return `globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze(${serializeBridgeConfig(config)});\nawait import('/src/main.tsx');\n`;
}

function walkElements(node, visit) {
  if (node == null) {
    return;
  }
  if (typeof node.tagName === "string") {
    visit(node);
  }
  const children = node.childNodes;
  if (!Array.isArray(children)) {
    return;
  }
  for (const child of children) {
    walkElements(child, visit);
  }
}

function attrValue(element, name) {
  const attr = element.attrs.find((entry) => entry.name === name);
  return attr == null ? undefined : attr.value;
}

function setAttr(element, name, value) {
  const existing = element.attrs.find((entry) => entry.name === name);
  if (existing) {
    existing.value = value;
    return;
  }
  element.attrs.push({ name, value });
}

function isMainEntrySrc(src) {
  if (typeof src !== "string" || !src.startsWith("/src/main.tsx")) {
    return false;
  }
  if (src.includes("\\")) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(src, "http://127.0.0.1");
  } catch {
    return false;
  }
  if (parsed.pathname !== "/src/main.tsx") {
    return false;
  }
  const keys = [...parsed.searchParams.keys()];
  if (keys.length === 0) {
    return true;
  }
  if (keys.length === 1 && keys[0] === "t") {
    const stamp = parsed.searchParams.get("t");
    return stamp !== null && /^\d+$/.test(stamp);
  }
  return false;
}

function parseCspDirectives(content) {
  if (typeof content !== "string") {
    return null;
  }
  const pieces = content.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
  const directives = [];
  for (const piece of pieces) {
    const space = piece.search(/\s/);
    const name = space === -1 ? piece : piece.slice(0, space);
    const value = space === -1 ? "" : piece.slice(space + 1).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      return null;
    }
    directives.push({ name, value, lower: name.toLowerCase() });
  }
  return directives;
}

function failPageStructure() {
  throw new Error(BODY_UNAVAILABLE.trim());
}

export function renderAuthenticatedPage(html, moduleNonce, cspNonce) {
  const document = parse(html);
  const metas = [];
  const moduleScripts = [];
  walkElements(document, (element) => {
    if (element.tagName === "meta" && String(attrValue(element, "http-equiv") ?? "").toLowerCase() === "content-security-policy") {
      metas.push(element);
    }
    if (element.tagName === "script" && attrValue(element, "type") === "module" && isMainEntrySrc(attrValue(element, "src"))) {
      moduleScripts.push(element);
    }
  });
  if (metas.length !== 1) {
    failPageStructure();
  }
  if (moduleScripts.length !== 1) {
    failPageStructure();
  }
  const cspMeta = metas[0];
  const directives = parseCspDirectives(attrValue(cspMeta, "content"));
  if (directives === null) {
    failPageStructure();
  }
  const scriptSrc = directives.filter((directive) => directive.lower === "script-src");
  if (scriptSrc.length !== 1) {
    failPageStructure();
  }
  const scriptTokens = scriptSrc[0].value.split(/\s+/).filter((token) => token.length > 0);
  if (!scriptTokens.includes("'self'")) {
    failPageStructure();
  }
  scriptSrc[0].value = `${scriptSrc[0].value} 'nonce-${cspNonce}'`.trim();
  setAttr(cspMeta, "content", directives.map((directive) => (
    directive.value.length > 0 ? `${directive.name} ${directive.value}` : directive.name
  )).join("; "));
  const mainScript = moduleScripts[0];
  const parent = mainScript.parentNode;
  if (parent == null) {
    failPageStructure();
  }
  const gated = defaultTreeAdapter.createElement("script", HTML_NS, [
    { name: "type", value: "module" },
    { name: "src", value: `${MODULE_PATH}?nonce=${moduleNonce}` },
  ]);
  defaultTreeAdapter.insertBefore(parent, gated, mainScript);
  defaultTreeAdapter.detachNode(mainScript);
  walkElements(document, (element) => {
    if (element.tagName === "script") {
      setAttr(element, "nonce", cspNonce);
    }
  });
  let head;
  walkElements(document, (element) => {
    if (head == null && element.tagName === "head") {
      head = element;
    }
  });
  if (head == null) {
    failPageStructure();
  }
  defaultTreeAdapter.detachNode(cspMeta);
  if (head.childNodes.length > 0) {
    defaultTreeAdapter.insertBefore(head, cspMeta, head.childNodes[0]);
  } else {
    defaultTreeAdapter.appendChild(head, cspMeta);
  }
  return serialize(document);
}

function hasMalformedPercent(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") {
      continue;
    }
    if (index + 2 >= value.length) {
      return true;
    }
    if (!/[0-9A-Fa-f]/.test(value[index + 1]) || !/[0-9A-Fa-f]/.test(value[index + 2])) {
      return true;
    }
  }
  return false;
}

function normalizePosixPath(pathname) {
  const parts = [];
  for (const segment of pathname.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

function classifyUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    return { scope: "none" };
  }
  const flags = {
    backslash: rawUrl.includes("\\") || /%5c/i.test(rawUrl),
    absolute: false,
    malformed: false,
    alias: false,
  };
  let work = rawUrl;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawUrl)) {
    flags.absolute = true;
    try {
      const absolute = new URL(rawUrl);
      work = `${absolute.pathname}${absolute.search}`;
    } catch {
      flags.malformed = true;
      return { scope: "none", flags };
    }
  }
  const queryIndex = work.indexOf("?");
  const pathname = queryIndex === -1 ? work : work.slice(0, queryIndex);
  const queryString = queryIndex === -1 ? null : work.slice(queryIndex + 1);
  if (hasMalformedPercent(pathname) || (queryString !== null && hasMalformedPercent(queryString))) {
    flags.malformed = true;
  }
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    flags.malformed = true;
  }
  const normalized = normalizePosixPath(decoded);
  if (/%2f/i.test(pathname) || pathname !== decoded || decoded !== normalized) {
    flags.alias = true;
  }
  const reserved = pathname.startsWith(RESERVED_PREFIX) || decoded.startsWith(RESERVED_PREFIX) || normalized.startsWith(RESERVED_PREFIX);
  if (reserved) {
    const exactModule = pathname === MODULE_PATH && decoded === MODULE_PATH && normalized === MODULE_PATH && !flags.alias && !flags.absolute && !flags.backslash && !flags.malformed;
    return { scope: "module", flags, pathname, queryString, exactModule };
  }
  if ((pathname === "/" || pathname === "/index.html") && queryString === null) {
    return { scope: "page", flags, pathname };
  }
  return { scope: "none", flags };
}

function parseModuleQuery(queryString) {
  if (queryString === null || queryString === "") {
    return { ok: true, nonce: undefined };
  }
  const pairs = queryString.split("&");
  const keys = [];
  const values = new Map();
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    let key;
    let value;
    try {
      key = decodeURIComponent(rawKey.replaceAll("+", "%20"));
      value = decodeURIComponent(rawValue.replaceAll("+", "%20"));
    } catch {
      return { ok: false };
    }
    if (values.has(key)) {
      return { ok: false };
    }
    keys.push(key);
    values.set(key, value);
  }
  if (keys.length > 1) {
    return { ok: false };
  }
  if (keys.length === 1 && keys[0] !== "nonce") {
    return { ok: false };
  }
  return { ok: true, nonce: values.get("nonce") };
}

function headerName(name) {
  return name.toLowerCase();
}

function rawHeaderValues(req, name) {
  const wanted = headerName(name);
  const raw = req.rawHeaders;
  if (Array.isArray(raw) && raw.length > 0) {
    const matches = [];
    for (let index = 0; index < raw.length; index += 2) {
      if (headerName(String(raw[index])) === wanted) {
        matches.push(raw[index + 1]);
      }
    }
    if (matches.length > 0) {
      return matches;
    }
  }
  const headers = req.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (headerName(key) !== wanted) {
      continue;
    }
    if (Array.isArray(value)) {
      return value;
    }
    if (value === undefined) {
      return [];
    }
    return [value];
  }
  return [];
}

function readHeader(req, name) {
  const values = rawHeaderValues(req, name);
  if (values.length > 1) {
    return { duplicate: true };
  }
  if (values.length === 0) {
    return { value: undefined };
  }
  const value = values[0];
  if (typeof value !== "string") {
    return { duplicate: true };
  }
  return { value };
}

function isCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  const pad = value.indexOf("=");
  if (pad !== -1 && value.slice(pad).replaceAll("=", "") !== "") {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function verifyBasicCredential(req, pageKey) {
  const header = readHeader(req, "authorization");
  if (header.duplicate) {
    return "duplicate";
  }
  if (header.value === undefined) {
    return "absent";
  }
  if (typeof header.value !== "string") {
    return "bad";
  }
  if (header.value.length > AUTH_HEADER_MAX) {
    return "bad";
  }
  if (!header.value.startsWith("Basic ")) {
    return "bad";
  }
  const encoded = header.value.slice(6);
  if (!isCanonicalBase64(encoded)) {
    return "bad";
  }
  const decoded = Buffer.from(encoded, "base64");
  const separator = decoded.indexOf(0x3a);
  if (separator < 0) {
    return "bad";
  }
  const user = decoded.subarray(0, separator);
  const pass = decoded.subarray(separator + 1);
  const expectedUser = Buffer.from("dev");
  const expectedPass = Buffer.from(pageKey);
  if (user.length !== expectedUser.length) {
    return "bad";
  }
  if (!timingSafeEqual(user, expectedUser)) {
    return "bad";
  }
  if (pass.length !== expectedPass.length) {
    return "bad";
  }
  if (!timingSafeEqual(pass, expectedPass)) {
    return "bad";
  }
  return "ok";
}

function pageFetchBlocked(req) {
  const site = readHeader(req, "sec-fetch-site");
  const dest = readHeader(req, "sec-fetch-dest");
  if (site.duplicate || dest.duplicate) {
    return true;
  }
  if (site.value === "cross-site") {
    return true;
  }
  if (dest.value === "iframe" || dest.value === "frame" || dest.value === "embed" || dest.value === "object") {
    return true;
  }
  return false;
}

function moduleFetchAllowed(req) {
  const site = readHeader(req, "sec-fetch-site");
  const mode = readHeader(req, "sec-fetch-mode");
  const dest = readHeader(req, "sec-fetch-dest");
  if (site.duplicate || mode.duplicate || dest.duplicate) {
    return false;
  }
  if (site.value !== "same-origin") {
    return false;
  }
  if (mode.value !== "cors") {
    return false;
  }
  if (dest.value !== "script") {
    return false;
  }
  return true;
}

function originForbidden(req, expectedOrigin) {
  const origin = readHeader(req, "origin");
  if (origin.duplicate) {
    return true;
  }
  if (origin.value === undefined) {
    return false;
  }
  if (origin.value === "null") {
    return true;
  }
  if (origin.value !== expectedOrigin) {
    return true;
  }
  return false;
}

function hostForbidden(req, expectedHost) {
  const host = readHeader(req, "host");
  if (host.duplicate) {
    return true;
  }
  if (host.value !== expectedHost) {
    return true;
  }
  return false;
}

function applyHeaders(res, headers) {
  if (typeof res.setHeader === "function") {
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    return;
  }
  if (typeof res.writeHead === "function") {
    res.writeHead(res.statusCode || 200, headers);
  }
}

function sendHandled(res, status, body, options) {
  const headers = { ...SECURITY_HEADERS };
  if (options.isPage) {
    headers["Content-Security-Policy"] = "frame-ancestors 'none'";
    headers["X-Frame-Options"] = "DENY";
    headers["Content-Type"] = "text/html; charset=utf-8";
  } else if (options.isJs) {
    headers["Content-Type"] = "text/javascript; charset=utf-8";
  } else {
    headers["Content-Type"] = "text/plain; charset=utf-8";
  }
  if (options.challenge) {
    headers["WWW-Authenticate"] = WWW_AUTHENTICATE;
  }
  res.statusCode = status;
  applyHeaders(res, headers);
  if (typeof res.end === "function") {
    res.end(body);
    return;
  }
  if (typeof res.writeHead === "function") {
    res.writeHead(status, headers);
  }
}

export function devBridgeConfigPlugin(deps) {
  const expectedPort = deps?.expectedPort ?? 1430;
  return {
    name: "resonantos-dev-bridge-config",
    enforce: "pre",
    apply: (_config, env) => env.command === 'serve' && !env.isPreview && env.mode !== 'test' /* vitest boots an internal Vite server; the delivery plugin and its fail-closed policy belong to the real dev server only */,
    configureServer(server) {
      assertDevServerPolicy(server.config, expectedPort);
      const env = (deps?.env ?? (() => process.env))();
      const enabled = env.RESONANTOS_DEV_BRIDGE_CONFIG === "1";
      const now = deps?.now ?? Date.now;
      const random = deps?.random ?? defaultRandomNonce;
      const makeCspNonce = deps?.createCspNonce ?? createCspNonce;
      const store = createPageNonces(now, random);
      const expectedHost = `127.0.0.1:${expectedPort}`;
      const expectedOrigin = `http://127.0.0.1:${expectedPort}`;
      let pageKey;
      if (enabled) {
        const candidate = env.RESONANTOS_DEV_BRIDGE_PAGE_KEY;
        if (typeof candidate !== "string" || !PAGE_KEY_PATTERN.test(candidate)) {
          throw new Error(PAGE_KEY_ERROR);
        }
        pageKey = candidate;
      }
      const readConfig = deps?.readConfig ?? ((root, onNonLoopback) => readGeneratedBridgeConfig(root, { onNonLoopback }));
      let loopbackWarned = false;
      const onNonLoopback = () => {
        if (loopbackWarned) {
          return;
        }
        loopbackWarned = true;
        console.error(LOOPBACK_DIAGNOSTIC);
      };
      const clearStore = () => {
        store.clear();
      };
      if (server.httpServer && typeof server.httpServer.on === "function") {
        server.httpServer.on("close", clearStore);
      }
      if (typeof server.close === "function") {
        const originalClose = server.close.bind(server);
        server.close = (...args) => {
          clearStore();
          return originalClose(...args);
        };
      }
      const middleware = (req, res, next) => {
        const finish = (status, body, options) => {
          sendHandled(res, status, body, options);
        };
        const run = async () => {
          const classified = classifyUrl(req.url);
          if (!enabled) {
            if (classified.scope === "module") {
              finish(404, BODY_NOT_FOUND, { isPage: false, isJs: false });
              return;
            }
            next();
            return;
          }
          if (classified.scope === "none") {
            next();
            return;
          }
          if (hostForbidden(req, expectedHost)) {
            finish(403, BODY_FORBIDDEN, { isPage: classified.scope === "page", isJs: false });
            return;
          }
          if (originForbidden(req, expectedOrigin)) {
            finish(403, BODY_FORBIDDEN, { isPage: classified.scope === "page", isJs: false });
            return;
          }
          if (classified.scope === "page") {
            if (classified.flags.absolute || classified.flags.backslash || classified.flags.malformed) {
              finish(403, BODY_FORBIDDEN, { isPage: true, isJs: false });
              return;
            }
            if (pageFetchBlocked(req)) {
              finish(403, BODY_FORBIDDEN, { isPage: true, isJs: false });
              return;
            }
            if (req.method !== "GET") {
              finish(405, BODY_FORBIDDEN, { isPage: true, isJs: false });
              return;
            }
            const pageAuth = verifyBasicCredential(req, pageKey);
            if (pageAuth !== "ok") {
              finish(401, BODY_AUTH, { isPage: true, isJs: false, challenge: true });
              return;
            }
            const moduleNonce = store.issue();
            if (moduleNonce === null) {
              finish(503, BODY_UNAVAILABLE, { isPage: true, isJs: false });
              return;
            }
            try {
              const source = await readFile(path.join(server.config.root, "index.html"), "utf8");
              const transformed = await server.transformIndexHtml("/index.html", source, classified.pathname);
              const cspNonce = makeCspNonce();
              const rendered = renderAuthenticatedPage(transformed, moduleNonce, cspNonce);
              finish(200, rendered, { isPage: true, isJs: false });
            } catch {
              store.consume(moduleNonce);
              finish(500, BODY_UNAVAILABLE, { isPage: true, isJs: false });
            }
            return;
          }
          if (classified.flags.absolute || classified.flags.backslash || classified.flags.malformed || classified.flags.alias || !classified.exactModule) {
            finish(403, BODY_FORBIDDEN, { isPage: false, isJs: false });
            return;
          }
          if (req.method !== "GET") {
            finish(403, BODY_FORBIDDEN, { isPage: false, isJs: false });
            return;
          }
          const query = parseModuleQuery(classified.queryString);
          if (!query.ok) {
            finish(403, BODY_FORBIDDEN, { isPage: false, isJs: false });
            return;
          }
          if (!moduleFetchAllowed(req)) {
            finish(403, BODY_FORBIDDEN, { isPage: false, isJs: false });
            return;
          }
          const moduleAuth = verifyBasicCredential(req, pageKey);
          if (moduleAuth === "absent") {
            finish(401, BODY_AUTH, { isPage: false, isJs: false, challenge: true });
            return;
          }
          if (moduleAuth !== "ok") {
            finish(403, BODY_FORBIDDEN, { isPage: false, isJs: false });
            return;
          }
          if (!store.consume(query.nonce)) {
            finish(403, BODY_FORBIDDEN, { isPage: false, isJs: false });
            return;
          }
          let config = null;
          try {
            config = await readConfig(server.config.root, onNonLoopback);
          } catch {
            config = null;
          }
          finish(200, renderBridgeModule(config), { isPage: false, isJs: true });
        };
        return Promise.resolve(run()).catch(() => {
          if (res.writableEnded || res.headersSent) {
            return;
          }
          finish(500, BODY_UNAVAILABLE, { isPage: true, isJs: false });
        });
      };
      server.middlewares.use(middleware);
      return () => {
        assertDevServerPolicy(server.config, expectedPort);
      };
    },
  };
}
