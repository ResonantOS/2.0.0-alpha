import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Unit tests that boot the real launcher must never see the operator's home: the bridge
// reads its user root from it and raises the host-local registry watermark beside it.
// The live lanes (test:browser-first:live, :live-sdk) boot the real install on purpose.
export async function withSandboxedLauncherHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "launcher-home-"));
  try {
    return await run({ ...process.env, HOME: home, USERPROFILE: home, RESONANTOS_BROWSER_FIRST_USER_ROOT: path.join(home, "ResonantOS_User") });
  } finally { await rm(home, { recursive: true, force: true }); }
}
