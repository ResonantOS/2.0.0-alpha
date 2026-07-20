import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  ALPHA_COMMANDS,
  isDirectExecution,
  main,
  reportEvent,
  runCommand,
  runVerifier,
} from "./verify-alpha.mjs";

test("defines the alpha commands in their required order", () => {
  assert.deepEqual(ALPHA_COMMANDS, [
    { command: "npm", args: ["run", "repo:hygiene"] },
    { command: "npm", args: ["run", "docs:check"] },
    { command: "npm", args: ["run", "test:docs"] },
    { command: "npm", args: ["run", "build"] },
    { command: "npm", args: ["test", "--", "--run"] },
    { command: "npm", args: ["run", "test:browser-first"] },
    { command: "npm", args: ["run", "test:browser-host"] },
    { command: "npm", args: ["run", "test:living-archive-mcp"] },
    { command: "npm", args: ["run", "test:living-archive-memory-service"] },
    { command: "npm", args: ["run", "test:health"] },
    { command: "npm", args: ["run", "test:engineer-runner"] },
    { command: "npm", args: ["run", "test:security-pipeline"] },
    { command: "npm", args: ["run", "test:module-ownership"] },
    {
      command: "node",
      args: ["scripts/security-pipeline/run-check.mjs", "--certify"],
    },
    { command: "npm", args: ["run", "pre-release:scan"] },
    {
      command: "node",
      args: [
        "scripts/browser-first-release-scope-audit.mjs",
        "--committed",
        "--strict",
      ],
    },
  ]);
});

test("runs successful commands sequentially and reports start and result", async () => {
  const commands = [
    { command: "first", args: ["one"] },
    { command: "second", args: ["two"] },
  ];
  const calls = [];
  const events = [];

  const result = await runVerifier({
    commands,
    runner: async (command) => {
      calls.push(command);
      return { exitCode: 0, signal: null };
    },
    report: (event) => events.push(event),
  });

  assert.deepEqual(calls, commands);
  assert.deepEqual(events, [
    { type: "start", command: "first one" },
    { type: "result", command: "first one", outcome: "passed", exitCode: 0 },
    { type: "start", command: "second two" },
    { type: "result", command: "second two", outcome: "passed", exitCode: 0 },
  ]);
  assert.deepEqual(result, { exitCode: 0, signal: null });
});

test("stops at the first nonzero result", async () => {
  const commands = [
    { command: "first", args: [] },
    { command: "failing", args: [] },
    { command: "never", args: [] },
  ];
  const calls = [];
  const events = [];

  const result = await runVerifier({
    commands,
    runner: async (command) => {
      calls.push(command.command);
      return { exitCode: command.command === "failing" ? 23 : 0, signal: null };
    },
    report: (event) => events.push(event),
  });

  assert.deepEqual(calls, ["first", "failing"]);
  assert.deepEqual(events.at(-1), {
    type: "result",
    command: "failing",
    outcome: "failed",
    exitCode: 23,
  });
  assert.deepEqual(result, { exitCode: 23, signal: null });
});

test("stops and preserves a terminating signal", async () => {
  const events = [];
  const result = await runVerifier({
    commands: [
      { command: "signaled", args: [] },
      { command: "never", args: [] },
    ],
    runner: async () => ({ exitCode: null, signal: "SIGTERM" }),
    report: (event) => events.push(event),
  });

  assert.deepEqual(events, [
    { type: "start", command: "signaled" },
    { type: "result", command: "signaled", outcome: "signaled", signal: "SIGTERM" },
  ]);
  assert.deepEqual(result, { exitCode: null, signal: "SIGTERM" });
});

test("converts spawn errors into a sanitized failure", async () => {
  const events = [];
  const result = await runVerifier({
    commands: [{ command: "missing", args: [] }],
    runner: async () => {
      throw new Error("spawn failed with private details");
    },
    report: (event) => events.push(event),
  });

  assert.deepEqual(events, [
    { type: "start", command: "missing" },
    { type: "result", command: "missing", outcome: "spawn-error", exitCode: 1 },
  ]);
  assert.deepEqual(result, { exitCode: 1, signal: null });
});

test("spawns without a shell and inherits stdio and environment", async () => {
  const env = { VERIFY_ALPHA_SECRET: "do-not-print" };
  const calls = [];
  const child = new EventEmitter();
  const pending = runCommand(
    { command: "npm", args: ["run", "name; echo not-interpolated"] },
    {
      cwd: "/repo",
      env,
      spawnImpl: (...args) => {
        calls.push(args);
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
    },
  );

  assert.deepEqual(await pending, { exitCode: 0, signal: null });
  assert.deepEqual(calls, [[
    "npm",
    ["run", "name; echo not-interpolated"],
    { cwd: "/repo", env, shell: false, stdio: "inherit" },
  ]]);
});

test("propagates a nonzero result to the process exit code", async () => {
  const processRef = { exitCode: undefined, pid: 1234 };

  const result = await main({
    commands: [{ command: "failing", args: [] }],
    processRef,
    report: () => {},
    runner: async () => ({ exitCode: 47, signal: null }),
  });

  assert.deepEqual(result, { exitCode: 47, signal: null });
  assert.equal(processRef.exitCode, 47);
});

test("propagates a strict committed-range audit failure", async () => {
  const processRef = { exitCode: undefined, pid: 1234 };
  const auditCommand = ALPHA_COMMANDS.at(-1);

  const result = await main({
    commands: [auditCommand],
    processRef,
    report: () => {},
    runner: async (command) => {
      assert.deepEqual(command, {
        command: "node",
        args: [
          "scripts/browser-first-release-scope-audit.mjs",
          "--committed",
          "--strict",
        ],
      });
      return { exitCode: 1, signal: null };
    },
  });

  assert.deepEqual(result, { exitCode: 1, signal: null });
  assert.equal(processRef.exitCode, 1);
});

test("propagates a strict security certification failure", async () => {
  const processRef = { exitCode: undefined, pid: 1234 };
  const securityCommand = ALPHA_COMMANDS.find(({ args }) =>
    args.includes("scripts/security-pipeline/run-check.mjs")
  );

  const result = await main({
    commands: [securityCommand],
    processRef,
    report: () => {},
    runner: async (command) => {
      assert.deepEqual(command, {
        command: "node",
        args: ["scripts/security-pipeline/run-check.mjs", "--certify"],
      });
      return { exitCode: 1, signal: null };
    },
  });

  assert.deepEqual(result, { exitCode: 1, signal: null });
  assert.equal(processRef.exitCode, 1);
});

test("propagates a terminating signal to the verifier process", async () => {
  const kills = [];
  const processRef = {
    exitCode: undefined,
    kill: (...args) => kills.push(args),
    pid: 1234,
  };

  await main({
    commands: [{ command: "signaled", args: [] }],
    processRef,
    report: () => {},
    runner: async () => ({ exitCode: null, signal: "SIGINT" }),
  });

  assert.deepEqual(kills, [[1234, "SIGINT"]]);
  assert.equal(processRef.exitCode, undefined);
});

test("does not serialize environment values or spawn error details", async () => {
  const secret = "verify-alpha-secret-sentinel";
  const previous = process.env.VERIFY_ALPHA_TEST_SECRET;
  process.env.VERIFY_ALPHA_TEST_SECRET = secret;
  const lines = [];

  try {
    await runVerifier({
      commands: [{ command: "missing", args: [] }],
      runner: async () => {
        throw new Error(`spawn details: ${secret}`);
      },
      report: (event) => reportEvent(event, (line) => lines.push(line)),
    });
  } finally {
    if (previous === undefined) {
      delete process.env.VERIFY_ALPHA_TEST_SECRET;
    } else {
      process.env.VERIFY_ALPHA_TEST_SECRET = previous;
    }
  }

  assert.deepEqual(lines, [
    "[verify-alpha] START missing",
    "[verify-alpha] RESULT spawn-error (exit 1) missing",
  ]);
  assert.equal(JSON.stringify(lines).includes(secret), false);
});

test("main uses the human-readable reporter by default", async () => {
  const lines = [];
  const originalError = console.error;
  console.error = (line) => lines.push(line);

  try {
    await main({
      commands: [{ command: "ok", args: [] }],
      processRef: { exitCode: undefined, pid: 1234 },
      runner: async () => ({ exitCode: 0, signal: null }),
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(lines, [
    "[verify-alpha] START ok",
    "[verify-alpha] RESULT passed (exit 0) ok",
  ]);
});

test("recognizes only direct ESM execution", () => {
  const scriptPath = "/repo/scripts/verify-alpha.mjs";
  const moduleUrl = pathToFileURL(scriptPath).href;

  assert.equal(isDirectExecution(moduleUrl, scriptPath), true);
  assert.equal(isDirectExecution(moduleUrl, "/repo/scripts/importer.mjs"), false);
  assert.equal(isDirectExecution(moduleUrl, undefined), false);
});
