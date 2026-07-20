import os from "node:os";
import path from "node:path";

// Browser-launch containment helpers for browser-first profile isolation.
//
// Goal: each sensitive launch binds an OWNED EPHEMERAL profile, a contained
// remote-debugging surface (loopback + port 0 / ephemeral), and a pinned
// extension set. A PERSISTENT profile is permitted only by an explicit opt-in.
//
// These are pure helpers so the launch argv can be asserted statically (no
// browser launch, no live CDP) — matching the cdp-proof predicate:
//   safe <=> ephemeral_profile AND (port == 0 OR loopback_bound) AND pinned_extension_set

export const LOOPBACK_ADDRESS = "127.0.0.1";

// Owned root for ephemeral per-session profiles. Kept under the owned
// ResonantOS user root so cleanup and ownership are unambiguous, falling back
// to the OS temp dir when no user root is provided.
export function ephemeralProfileRoot({ userRoot, home = os.homedir(), tmpdir = os.tmpdir() } = {}) {
  const base = userRoot
    ? path.join(userRoot, "BrowserFirst", "Profiles", "ephemeral")
    : path.join(tmpdir, "ResonantOS_BrowserFirst_Profiles");
  void home;
  return base;
}

// True when the caller explicitly opted into a PERSISTENT profile.
export function persistentProfileOptIn({ args, env = process.env } = {}) {
  const flag = args?.get?.("persistent-profile");
  if (flag === "true" || flag === "1") return true;
  const envValue = String(env.RESONANTOS_BROWSER_PERSISTENT_PROFILE ?? "").trim().toLowerCase();
  return envValue === "1" || envValue === "true" || envValue === "yes";
}

// Resolve the profile directory used for the launch.
//
// Precedence:
//   1. Explicit caller-supplied path (`--profile=` / RESONANTOS_BROWSER_FIRST_PROFILE)
//      — an explicit, intentional choice; honored as-is.
//   2. Persistent opt-in (`--persistent-profile` / RESONANTOS_BROWSER_PERSISTENT_PROFILE=1)
//      — uses the durable default persistent profile.
//   3. Default — a FRESH owned ephemeral profile dir for this session.
export function resolveBrowserProfile({
  args,
  env = process.env,
  persistentDefaultProfile,
  userRoot,
  home = os.homedir(),
  tmpdir = os.tmpdir(),
  sessionId,
} = {}) {
  const explicit = args?.get?.("profile") ?? env.RESONANTOS_BROWSER_FIRST_PROFILE;
  if (explicit) {
    return { profileDir: path.resolve(explicit), mode: "explicit", ephemeral: false };
  }

  if (persistentProfileOptIn({ args, env })) {
    return {
      profileDir: path.resolve(persistentDefaultProfile),
      mode: "persistent",
      ephemeral: false,
    };
  }

  const root = ephemeralProfileRoot({ userRoot, home, tmpdir });
  const session = sessionId
    ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return { profileDir: path.join(root, session), mode: "ephemeral", ephemeral: true };
}

// Resolve the contained remote-debugging surface.
//
// If no debugging is requested, none is exposed. If debugging IS requested
// (caller/env), it is contained to loopback + an ephemeral port (0): we never
// forward a fixed, externally-reachable port. Returns the host-arg fragments to
// append plus a structured description for diagnostics/tests.
export function resolveRemoteDebugging({ args, env = process.env } = {}) {
  const requested = args?.get?.("remote-debugging-port")
    ?? env.RESONANTOS_BROWSER_FIRST_REMOTE_DEBUGGING_PORT;

  if (requested === undefined || requested === null || requested === "") {
    return { enabled: false, port: null, loopbackBound: false, hostArgs: [] };
  }

  // Contain: force ephemeral port 0 + loopback address regardless of the
  // requested value. A caller-supplied fixed/exposed port is intentionally
  // dropped (constraint: port == 0 OR loopback_bound).
  return {
    enabled: true,
    port: 0,
    loopbackBound: true,
    requestedPort: String(requested),
    hostArgs: [
      "--resonantos-remote-debugging-port=0",
      `--resonantos-remote-debugging-address=${LOOPBACK_ADDRESS}`,
    ],
  };
}
