import assert from "node:assert/strict";
import test from "node:test";

import * as hermesRuntime from "../host/hermes-runtime.mjs";

const {
  hermesCommand,
  hermesRuntimeDiagnostics,
} = hermesRuntime;

const executableStat = { isFile: () => true, mode: 0o755 };

test("Hermes runtime ignores ambient PATH, custom profile roots, and untrusted overrides", () => {
  const attackerCommand = "/tmp/attacker/hermes";
  const diagnostics = hermesRuntimeDiagnostics({
    env: {
      HERMES_COMMAND: attackerCommand,
      PATH: "/tmp/attacker",
    },
    homeDir: "/home/reviewer",
    platform: "linux",
    profileHome: "/tmp/attacker-profile",
    exists: (candidate) => candidate === attackerCommand,
    realpath: (candidate) => candidate,
    stat: () => executableStat,
  });

  assert.equal(diagnostics.command, null);
  assert.equal(diagnostics.overrideConfigured, true);
  assert.equal(diagnostics.overrideAccepted, false);
  assert.ok(diagnostics.candidates.every(({ path: candidate }) => !candidate.startsWith("/tmp/")));
  assert.equal(hermesCommand({
    env: {},
    homeDir: "/home/reviewer",
    platform: "linux",
    exists: () => false,
  }), null);
});

test("Hermes runtime returns canonical provenance for a fixed trusted candidate", () => {
  const command = "/usr/local/bin/hermes";
  const diagnostics = hermesRuntimeDiagnostics({
    env: { HERMES_COMMAND: command, PATH: "/tmp/attacker" },
    homeDir: "/home/reviewer",
    platform: "linux",
    exists: (candidate) => candidate === command,
    realpath: (candidate) => candidate,
    stat: () => executableStat,
  });

  assert.equal(diagnostics.command, command);
  assert.equal(diagnostics.overrideAccepted, true);
  assert.deepEqual(diagnostics.resolution, {
    base: "system-bin",
    path: command,
    canonical_path: command,
    validated_by: "hermesRuntimeDiagnostics",
    source: "fixed-system-root",
  });
  assert.equal(hermesCommand({
    env: { HERMES_COMMAND: command },
    homeDir: "/home/reviewer",
    platform: "linux",
    exists: (candidate) => candidate === command,
    realpath: (candidate) => candidate,
    stat: () => executableStat,
  }), command);
});

test("Hermes runtime rejects a trusted-path symlink that canonicalizes outside allowlisted roots", () => {
  const command = "/usr/local/bin/hermes";
  const diagnostics = hermesRuntimeDiagnostics({
    env: {},
    homeDir: "/home/reviewer",
    platform: "linux",
    exists: (candidate) => candidate === command,
    realpath: (candidate) => candidate === command ? "/tmp/attacker/hermes" : candidate,
    stat: () => executableStat,
  });

  assert.equal(diagnostics.command, null);
  assert.ok(diagnostics.rejections.some(({ reason }) => /canonical path escapes/i.test(reason)));
});

test("Hermes Python adapter returns canonical provenance from the selected fixed installation root", () => {
  assert.equal(typeof hermesRuntime.hermesPythonRuntimeDiagnostics, "function");

  const homeDir = "/home/reviewer";
  const agentRoot = `${homeDir}/.hermes/hermes-agent`;
  const command = `${agentRoot}/venv/bin/hermes`;
  const pythonPath = `${agentRoot}/venv/bin/python`;
  const runAgentPath = `${agentRoot}/run_agent.py`;
  const files = new Set([command, pythonPath, runAgentPath]);
  const options = {
    env: { HERMES_COMMAND: command, PATH: "/tmp/attacker" },
    homeDir,
    platform: "linux",
    exists: (candidate) => files.has(candidate),
    realpath: (candidate) => candidate,
    stat: () => executableStat,
  };

  const diagnostics = hermesRuntime.hermesPythonRuntimeDiagnostics(command, options);

  assert.equal(diagnostics.installed, true);
  assert.equal(diagnostics.pythonPath, pythonPath);
  assert.equal(diagnostics.agentRoot, agentRoot);
  assert.equal(diagnostics.runAgentPath, runAgentPath);
  assert.deepEqual(diagnostics.resolution, {
    base: "install-prefix",
    path: pythonPath,
    canonical_path: pythonPath,
    validated_by: "hermesPythonRuntimeDiagnostics",
    source: "fixed-user-install-root",
    derived_from: command,
    installation_root: agentRoot,
  });
});

test("Hermes Python adapter rejects canonical escapes and non-executable candidates", () => {
  assert.equal(typeof hermesRuntime.hermesPythonRuntimeDiagnostics, "function");

  const homeDir = "/home/reviewer";
  const agentRoot = `${homeDir}/.hermes/hermes-agent`;
  const command = `${agentRoot}/venv/bin/hermes`;
  const pythonPath = `${agentRoot}/venv/bin/python`;
  const runAgentPath = `${agentRoot}/run_agent.py`;
  const files = new Set([command, pythonPath, runAgentPath]);
  const common = {
    env: { HERMES_COMMAND: command },
    homeDir,
    platform: "linux",
    exists: (candidate) => files.has(candidate),
  };

  const escaped = hermesRuntime.hermesPythonRuntimeDiagnostics(command, {
    ...common,
    realpath: (candidate) => candidate === pythonPath ? "/tmp/attacker/python" : candidate,
    stat: () => executableStat,
  });
  assert.equal(escaped.installed, false);
  assert.ok(escaped.rejections.some(({ reason }) => /canonical path escapes/i.test(reason)));

  const nonExecutable = hermesRuntime.hermesPythonRuntimeDiagnostics(command, {
    ...common,
    realpath: (candidate) => candidate,
    stat: (candidate) => candidate === pythonPath
      ? { isFile: () => true, mode: 0o644 }
      : executableStat,
  });
  assert.equal(nonExecutable.installed, false);
  assert.ok(nonExecutable.rejections.some(({ reason }) => /not executable/i.test(reason)));

  const nonRegular = hermesRuntime.hermesPythonRuntimeDiagnostics(command, {
    ...common,
    realpath: (candidate) => candidate,
    stat: (candidate) => candidate === pythonPath
      ? { isFile: () => false, mode: 0o755 }
      : executableStat,
  });
  assert.equal(nonRegular.installed, false);
  assert.ok(nonRegular.rejections.some(({ reason }) => /not a regular file/i.test(reason)));
});

test("Hermes Python adapter accepts a genuine venv whose interpreter symlinks to a Python store", () => {
  const homeDir = "/home/reviewer";
  const agentRoot = `${homeDir}/.hermes/hermes-agent`;
  const command = `${agentRoot}/venv/bin/hermes`;
  const pythonPath = `${agentRoot}/venv/bin/python`;
  const runAgentPath = `${agentRoot}/run_agent.py`;
  const pyvenvCfg = `${agentRoot}/venv/pyvenv.cfg`;
  const uvBasePython = "/home/reviewer/.local/share/uv/python/cpython-3.11/bin/python3.11";
  const files = new Set([command, pythonPath, runAgentPath, pyvenvCfg]);

  const diagnostics = hermesRuntime.hermesPythonRuntimeDiagnostics(command, {
    env: { HERMES_COMMAND: command },
    homeDir,
    platform: "linux",
    exists: (candidate) => files.has(candidate),
    // The venv launcher symlinks OUT to the uv store; the pyvenv.cfg stays in root.
    realpath: (candidate) => (candidate === pythonPath ? uvBasePython : candidate),
    stat: () => executableStat,
  });

  assert.equal(diagnostics.installed, true);
  // Must spawn the launcher (activates the venv), not the resolved base interpreter.
  assert.equal(diagnostics.pythonPath, pythonPath);
  assert.equal(diagnostics.resolution.path, pythonPath);
  assert.equal(diagnostics.resolution.canonical_path, uvBasePython);
});

test("Hermes Python adapter still rejects an escaping interpreter when the venv marker is outside the trusted root", () => {
  const homeDir = "/home/reviewer";
  const agentRoot = `${homeDir}/.hermes/hermes-agent`;
  const command = `${agentRoot}/venv/bin/hermes`;
  const pythonPath = `${agentRoot}/venv/bin/python`;
  const runAgentPath = `${agentRoot}/run_agent.py`;
  const pyvenvCfg = `${agentRoot}/venv/pyvenv.cfg`;
  const files = new Set([command, pythonPath, runAgentPath, pyvenvCfg]);

  const diagnostics = hermesRuntime.hermesPythonRuntimeDiagnostics(command, {
    env: { HERMES_COMMAND: command },
    homeDir,
    platform: "linux",
    exists: (candidate) => files.has(candidate),
    // Both the interpreter AND the venv marker canonicalize outside the root:
    // a bare symlink dressed up as a venv must not be trusted.
    realpath: (candidate) => {
      if (candidate === pythonPath) return "/tmp/attacker/python";
      if (candidate === pyvenvCfg) return "/tmp/attacker/pyvenv.cfg";
      return candidate;
    },
    stat: () => executableStat,
  });

  assert.equal(diagnostics.installed, false);
  assert.ok(diagnostics.rejections.some(({ reason }) => /canonical path escapes/i.test(reason)));
});
