// Bridge TLS — generates a self-signed CA + leaf cert for the bridge, so the
// extension's chrome-extension:// (secure) context can embed the Hermes
// dashboard iframe over HTTPS. HTTP embedding is blocked by Chrome's mixed-
// content policy; same-origin HTTPS embed is fine.
//
// Files persisted to ~/ResonantOS_User/BridgeTLS/:
//   ca.crt     — public CA cert (distribute to clients, they install it
//                once per machine into their per-user trust store).
//   ca.key     — CA private key (0600, stays on the Pi).
//   bridge.crt — leaf cert signed by the CA, multi-SAN for all interfaces.
//   bridge.key — leaf private key (0600, stays on the Pi).
//
// The leaf SAN list is auto-discovered at gen time: every non-loopback,
// non-Docker IPv4 + "localhost" / "127.0.0.1". Users add more IPs by
// re-running cert generation (e.g. `node bridge-tls.mjs --regen`) and
// re-installing the CA on their clients.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Default location for bridge TLS material. Honors $RESONANTOS_BRIDGE_TLS_DIR
// for deployments that want a stable, hidden location (e.g. ~/.resonantos-tls).
export const DEFAULT_BRIDGE_TLS_DIR =
  process.env.RESONANTOS_BRIDGE_TLS_DIR ||
  path.join(os.homedir(), "ResonantOS_User", "BridgeTLS");
export const DEFAULT_CA_VALIDITY_DAYS = 3650; // 10y
export const DEFAULT_LEAF_VALIDITY_DAYS = 825; // browsers cap leaf cert validity at 825 days

// Auto-detect candidate hostnames/IPs to put in the leaf SAN. Skip loopback
// (added separately), skip Docker bridges (172.16-31.x.x), skip IPv6 for
// the LAN target (browsers prefer IPv4 when both are returned; we add IPv6
// separately if needed).
function discoverBridgeSans() {
  const sans = ["localhost", "127.0.0.1"];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.internal) continue;
      if (iface.family !== "IPv4") continue;
      const ip = iface.address;
      // Skip Docker default bridges (172.16.0.0/12) and any RFC1918 10.x
      // that's almost always a private NIC we don't want exposed.
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) continue;
      sans.push(ip);
    }
  }
  return Array.from(new Set(sans));
}

async function run(cmd, args, opts = {}, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

export function resolveOpenSslPath({ platform = process.platform, exists = existsSync } = {}) {
  const candidates = platform === "win32"
    ? [
      "C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe",
      "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    ]
    : platform === "darwin"
      ? ["/opt/homebrew/bin/openssl", "/usr/local/bin/openssl", "/usr/bin/openssl"]
      : ["/usr/bin/openssl", "/bin/openssl", "/usr/local/bin/openssl"];
  const command = candidates.find((candidate) => exists(candidate));
  if (!command) {
    throw new Error("OpenSSL was not found in a trusted system installation path.");
  }
  return command;
}

function openSslEnvironment(environment) {
  return Object.fromEntries(
    ["HOME", "LANG", "LC_ALL", "TMPDIR"]
      .map((key) => [key, environment[key]])
      .filter(([, value]) => value !== undefined),
  );
}

export function runOpenSsl(
  args,
  {
    environment = process.env,
    exists = existsSync,
    platform = process.platform,
    spawnImpl = spawn,
  } = {},
) {
  return run(
    resolveOpenSslPath({ platform, exists }),
    args,
    { env: openSslEnvironment(environment) },
    spawnImpl,
  );
}

async function fileExistsAndNonEmpty(p) {
  try {
    const s = await stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

// Generate a self-signed CA (root). Returns nothing; writes ca.crt and ca.key.
export async function generateCa({
  dir,
  validityDays = DEFAULT_CA_VALIDITY_DAYS,
  runOpenSslImpl = runOpenSsl,
} = {}) {
  const outDir = dir ?? DEFAULT_BRIDGE_TLS_DIR;
  await mkdir(outDir, { recursive: true });
  const caKey = path.join(outDir, "ca.key");
  const caCrt = path.join(outDir, "ca.crt");
  await runOpenSslImpl([
    "req", "-x509", "-new", "-nodes",
    "-newkey", "ed25519",
    "-keyout", caKey,
    "-out", caCrt,
    "-days", String(validityDays),
    "-subj", "/CN=ResonantOS Bridge CA (self-signed, per-user trust)/O=ResonantOS",
  ]);
  await chmod(caKey, 0o600);
  return { caKey, caCrt };
}

// Generate a leaf cert signed by the CA, with the given SANs. Writes
// bridge.crt and bridge.key.
export async function generateLeaf({
  dir,
  caKeyPath,
  caCrtPath,
  sans,
  validityDays = DEFAULT_LEAF_VALIDITY_DAYS,
  runOpenSslImpl = runOpenSsl,
} = {}) {
  const outDir = dir ?? DEFAULT_BRIDGE_TLS_DIR;
  await mkdir(outDir, { recursive: true });
  const bridgeKey = path.join(outDir, "bridge.key");
  const bridgeCrt = path.join(outDir, "bridge.crt");
  const bridgeCsr = path.join(outDir, "bridge.csr");
  const extFile = path.join(outDir, "bridge.ext");

  // 1) Generate leaf key + CSR
  await runOpenSslImpl([
    "req", "-new", "-nodes",
    "-newkey", "ed25519",
    "-keyout", bridgeKey,
    "-out", bridgeCsr,
    "-subj", "/CN=ResonantOS Bridge/emailAddress=bridge@resonantos.local",
  ]);
  await chmod(bridgeKey, 0o600);

  // 2) Write SAN extension file
  const sanLines = [
    "authorityKeyIdentifier=keyid,issuer",
    "basicConstraints=CA:FALSE",
    "keyUsage = digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    `subjectAltName = ${sans.map((s, i) =>
      /^[0-9.]+$/.test(s) ? `IP.${i + 1}:${s}` : `DNS.${i + 1}:${s}`
    ).join(", ")}`,
  ];
  await writeFile(extFile, sanLines.join("\n") + "\n", { mode: 0o600 });

  // 3) Sign the CSR with the CA. Use an explicit serial number so we don't
  // leave a ca.srl file lying around.
  const serial = Math.floor(Math.random() * 0xffffffff).toString();
  await runOpenSslImpl([
    "x509", "-req",
    "-in", bridgeCsr,
    "-CA", caCrtPath,
    "-CAkey", caKeyPath,
    "-set_serial", serial,
    "-out", bridgeCrt,
    "-days", String(validityDays),
    "-extfile", extFile,
  ]);

  // 4) Clean up the CSR + ext files. (No .srl file with -set_serial.)
  await unlink(bridgeCsr).catch(() => {});
  await unlink(extFile).catch(() => {});

  return { bridgeKey, bridgeCrt };
}

// Load the bridge key + cert. Returns null if either file is missing —
// caller should fall back to HTTP-only mode.
export async function loadBridgeTls({ dir } = {}) {
  const outDir = dir ?? DEFAULT_BRIDGE_TLS_DIR;
  const bridgeKey = path.join(outDir, "bridge.key");
  const bridgeCrt = path.join(outDir, "bridge.crt");
  const caCrt = path.join(outDir, "ca.crt");
  if (
    !(await fileExistsAndNonEmpty(bridgeKey)) ||
    !(await fileExistsAndNonEmpty(bridgeCrt)) ||
    !(await fileExistsAndNonEmpty(caCrt))
  ) {
    return null;
  }
  return {
    key: await readFile(bridgeKey),
    cert: await readFile(bridgeCrt),
    ca: await readFile(caCrt),
    paths: { bridgeKey, bridgeCrt, caCrt, dir: outDir },
  };
}

// Return just the file paths (no key/cert material). Used by the launchers
// to wire a /tls/ca.crt endpoint into the bridge that serves the CA cert
// for client download.
export function getBridgeTlsPaths({ dir } = {}) {
  const outDir = dir ?? DEFAULT_BRIDGE_TLS_DIR;
  return {
    bridgeKey: path.join(outDir, "bridge.key"),
    bridgeCrt: path.join(outDir, "bridge.crt"),
    caCrt: path.join(outDir, "ca.crt"),
    dir: outDir,
  };
}

// Ensure the bridge TLS material exists; generate if not. Returns the loaded
// material. Idempotent: if files exist, returns them without regenerating.
//
// `regen` semantics:
//   - "leaf" (default): preserve the existing CA; rotate only the leaf. This
//     keeps the CA's subject stable so existing trust stores keep working
//     after a leaf rotation.
//   - "all": rotate both CA and leaf. Caller MUST re-distribute the new CA
//     to every client and re-install it in their trust store, or all
//     browser fetches will start failing with "unknown CA".
export async function ensureBridgeTls({ dir, regen = false, regenScope = "leaf" } = {}) {
  const outDir = dir ?? DEFAULT_BRIDGE_TLS_DIR;
  const existing = await loadBridgeTls({ dir: outDir });
  const wantFullRegen = regen === true || regen === "all" || regenScope === "all";

  if (existing && !regen) return { ...existing, generated: false };
  if (existing && !wantFullRegen) {
    // Leaf-only rotation: keep CA, regenerate leaf, preserve CA subject.
    const sans = discoverBridgeSans();
    const { bridgeKey, bridgeCrt } = await generateLeaf({
      dir: outDir,
      caKeyPath: existing.paths.caCrt.replace(/\.crt$/, ".key"),
      caCrtPath: existing.paths.caCrt,
      sans,
    });
    return {
      key: await readFile(bridgeKey),
      cert: await readFile(bridgeCrt),
      ca: existing.ca,
      paths: { ...existing.paths, bridgeKey, bridgeCrt },
      generated: true,
      sans,
    };
  }

  await mkdir(outDir, { recursive: true });
  const sans = discoverBridgeSans();
  const { caKey, caCrt } = await generateCa({ dir: outDir });
  const { bridgeKey, bridgeCrt } = await generateLeaf({
    dir: outDir,
    caKeyPath: caKey,
    caCrtPath: caCrt,
    sans,
  });
  return {
    key: await readFile(bridgeKey),
    cert: await readFile(bridgeCrt),
    ca: await readFile(caCrt),
    paths: { bridgeKey, bridgeCrt, caCrt, dir: outDir },
    generated: true,
    sans,
  };
}

// Extract the subjectAltName list from a PEM-encoded cert. Returns
// ["localhost", "127.0.0.1", "192.168.1.100", ...]. Parses both the
// modern "DNS:foo, IP:1.2.3.4" form and OpenSSL's verbose
// "DNS:foo, IP Address:1.2.3.4" form.
export async function getCertSans(certPem, { runOpenSslImpl = runOpenSsl } = {}) {
  const tmp = path.join(os.tmpdir(), `resonantos-cert-${process.pid}-${Date.now()}.pem`);
  await writeFile(tmp, certPem, { mode: 0o600 });
  try {
    const { stdout } = await runOpenSslImpl(["x509", "-in", tmp, "-noout", "-ext", "subjectAltName"]);
    // OpenSSL prints:
    //   "X509v3 Subject Alternative Name: \n    DNS:localhost, IP Address:127.0.0.1, ..."
    // or for empty SANs:
    //   "X509v3 Subject Alternative Name: \n    <empty>\n"
    // Strip the header line, then take everything after the first colon.
    // The remainder is a comma-separated list of "TYPE:value" entries.
    const lines = stdout.split("\n");
    const headerIdx = lines.findIndex((l) => l.includes("Subject Alternative Name"));
    if (headerIdx < 0) return [];
    // Concatenate header remainder + continuation lines, then split on commas.
    const afterHeader = lines
      .slice(headerIdx)
      .join("\n")
      .split(":")
      .slice(1)
      .join(":");
    const entries = afterHeader.split(/,\s*/).map((p) => p.trim()).filter(Boolean);
    return entries.map((entry) => {
      // Strip the "DNS:", "IP:", "IP Address:" prefix; keep just the value.
      const colon = entry.indexOf(":");
      return colon >= 0 ? entry.slice(colon + 1).trim() : entry;
    });
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// CLI entry point — generate certs and print a summary. Useful for manual
// regeneration and for the cert-install scripts that need to invoke us.
export async function main() {
  const args = process.argv.slice(2);
  const regen = args.includes("--regen");
  const result = await ensureBridgeTls({ regen });
  const sans = await getCertSans(result.cert);
  console.log(JSON.stringify({
    paths: result.paths,
    generated: result.generated,
    sans,
    note: regen
      ? "Regenerated. Re-distribute the CA cert to all clients and re-install it in their trust store."
      : result.generated
        ? "Generated. Distribute ca.crt to clients and install it in their per-user trust store."
        : "Already present. Use --regen to rotate.",
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
