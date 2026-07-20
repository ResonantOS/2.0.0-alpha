import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  evaluateBridgeRequestForSelfTest,
  runBridgeAuthSelfTest,
  bridgeServerPort,
  startBridgeServer,
} from "./bridge-server.mjs";
import { capabilityForBridgeRoute } from "../resonantos-side-panel-extension/src/lib/bridge-client.js";

function cmdEchoLine(line) {
  const escaped = String(line)
    .replace(/\^/g, "^^")
    .replace(/&/g, "^&")
    .replace(/\|/g, "^|")
    .replace(/</g, "^<")
    .replace(/>/g, "^>");
  return escaped ? `echo ${escaped}` : "echo.";
}

function fakeCliScript(output) {
  if (process.platform === "win32") {
    return ["@echo off", ...String(output).split("\n").map(cmdEchoLine), ""].join("\r\n");
  }
  return `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\n`;
}

function fakeOpenCodeCliScript(output) {
  if (process.platform === "win32") {
    return [
      "@echo off",
      "if \"%OPENAI_API_KEY%\"==\"\" (echo selected provider env missing 1>&2 & exit /b 32)",
      "if not \"%RESONANTOS_PROVIDER_SECRETS_JSON%\"==\"\" (echo ResonantOS provider store leaked 1>&2 & exit /b 33)",
      "echo %* | findstr /C:\"OpenCode operating as a ResonantOS add-on coding agent\" >nul && (echo prompt leaked in argv 1>&2 & exit /b 31)",
      "echo %* | findstr /C:\"openai/gpt-5.4-mini\" >nul || (echo model missing 1>&2 & exit /b 34)",
      "echo %* | findstr /C:\"json\" >nul || (echo json format missing 1>&2 & exit /b 37)",
      ...String(output).split("\n").map(cmdEchoLine),
      "",
    ].join("\r\n");
  }
  return `#!/bin/sh
if [ -z "\${OPENAI_API_KEY:-}" ]; then
  echo "selected provider env missing" >&2
  exit 32
fi
if [ -n "\${RESONANTOS_PROVIDER_SECRETS_JSON:-}" ]; then
  echo "ResonantOS provider store leaked" >&2
  exit 33
fi
case "$*" in
  *"OpenCode operating as a ResonantOS add-on coding agent"*|*"Validate that enabled OpenCode CLI execution produces"*)
    echo "prompt leaked in argv" >&2
    exit 31
    ;;
esac
case "$*" in
  *"openai/gpt-5.4-mini"*) ;;
  *)
    echo "model missing" >&2
    exit 34
    ;;
esac
case "$*" in
  *"--format json"*) ;;
  *)
    echo "json format missing" >&2
    exit 37
    ;;
esac
prompt_file=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--file" ]; then
    prompt_file="$arg"
  fi
  previous="$arg"
done
if [ -z "$prompt_file" ] || [ ! -f "$prompt_file" ]; then
  echo "missing prompt file" >&2
  exit 35
fi
if ! grep -q "OpenCode operating as a ResonantOS add-on coding agent" "$prompt_file"; then
  echo "prompt missing from file" >&2
  exit 36
fi
cat <<'EOF'
${output}
EOF
`;
}

function fakeHermesPythonScript(output) {
  const encoded = JSON.stringify({
    ok: true,
    finalResponse: String(output),
    completed: true,
    apiCalls: 1,
  });
  if (process.platform === "win32") {
    return [
      "@echo off",
      "if \"%OPENAI_API_KEY%\"==\"\" (echo selected provider env missing 1>&2 & exit /b 32)",
      "if not \"%RESONANTOS_PROVIDER_SECRETS_JSON%\"==\"\" (echo ResonantOS provider store leaked 1>&2 & exit /b 33)",
      "echo %* | findstr /C:\"Hermes operating as a ResonantOS add-on agent\" >nul && (echo prompt leaked in argv 1>&2 & exit /b 31)",
      "if not \"%HERMES_INFERENCE_PROVIDER%\"==\"openai-api\" (echo provider missing 1>&2 & exit /b 34)",
      "if not \"%HERMES_INFERENCE_MODEL%\"==\"gpt-5.4-mini\" (echo model missing 1>&2 & exit /b 35)",
      "findstr /C:\"Hermes operating as a ResonantOS add-on agent\" \"%~2\" >nul || (echo prompt missing from file 1>&2 & exit /b 36)",
      `> "%~3" echo ${encoded.replace(/%/g, "%%")}`,
      "",
    ].join("\r\n");
  }
  return `#!/bin/sh
if [ -z "\${OPENAI_API_KEY:-}" ]; then
  echo "selected provider env missing" >&2
  exit 32
fi
if [ -n "\${RESONANTOS_PROVIDER_SECRETS_JSON:-}" ]; then
  echo "ResonantOS provider store leaked" >&2
  exit 33
fi
case "$*" in
  *"Hermes operating as a ResonantOS add-on agent"*)
    echo "prompt leaked in argv" >&2
    exit 31
    ;;
esac
if [ "\${HERMES_INFERENCE_PROVIDER:-}" != "openai-api" ]; then
  echo "provider missing" >&2
  exit 34
fi
if [ "\${HERMES_INFERENCE_MODEL:-}" != "gpt-5.4-mini" ]; then
  echo "model missing" >&2
  exit 35
fi
if ! grep -q "Hermes operating as a ResonantOS add-on agent" "$2"; then
  echo "prompt missing from file" >&2
  exit 36
fi
cat > "$3" <<'EOF'
${encoded}
EOF
`;
}

async function writeFakeHermesPythonRuntime(root, output) {
  const agentRoot = path.join(root, "hermes-agent");
  const binRoot = path.join(agentRoot, "venv", "bin");
  const fakeHermes = path.join(binRoot, process.platform === "win32" ? "hermes.cmd" : "hermes");
  const fakePython = path.join(binRoot, process.platform === "win32" ? "python.cmd" : "python");
  await mkdir(binRoot, { recursive: true });
  await writeFile(path.join(agentRoot, "run_agent.py"), "# fake Hermes run_agent marker for ResonantOS self-tests\n");
  await writeFile(fakeHermes, process.platform === "win32" ? "@echo off\r\necho fake hermes\r\n" : "#!/bin/sh\necho fake hermes\n");
  await writeFile(fakePython, fakeHermesPythonScript(output));
  await chmod(fakeHermes, 0o755).catch(() => undefined);
  await chmod(fakePython, 0o755).catch(() => undefined);
  return fakeHermes;
}

export async function runBrowserFirstSelfTest(context) {
  const {
    args,
    bridgeCapabilityTokens,
    bridgeRoutes,
    bridgeToken,
    invokeBridgeRouteForSelfTest,
    memoryRoot,
    memorySettingsPath,
    memorySourceFileManifestPath,
    memorySourceSyncHistoryPath,
    readMemorySourceMoveHistory,
    readMemorySourceRepairHistory,
    resonantExtensionOrigin,
    safeFileSlug,
    setAddonRuntimeSelfTestHomeDir,
  } = context;

  const capabilityTokenForRoute = (routePath, method = "POST", explicitToken) => {
    if (explicitToken !== undefined) return explicitToken;
    const capability = capabilityForBridgeRoute(routePath, method);
    return capability ? (bridgeCapabilityTokens[capability] ?? "") : "";
  };

  if (args.get("bridge-auth-self-test") === "true") {
    const result = await runBridgeAuthSelfTest({
      port: Number(args.get("bridge-port") ?? 0),
      bridgeToken,
      extensionOrigin: resonantExtensionOrigin,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (args.get("bridge-auth-inprocess-self-test") === "true") {
    const unauthorized = await evaluateBridgeRequestForSelfTest({
      method: "GET",
      url: "/status",
      headers: {},
      bridgeToken,
      bridgeCapabilityTokens,
      routes: bridgeRoutes,
    });
    const wrongToken = await evaluateBridgeRequestForSelfTest({
      method: "GET",
      url: "/status",
      headers: { "X-ResonantOS-Bridge-Token": "wrong-token" },
      bridgeToken,
      bridgeCapabilityTokens,
      routes: bridgeRoutes,
    });
    const authorized = await evaluateBridgeRequestForSelfTest({
      method: "GET",
      url: "/status",
      headers: { "X-ResonantOS-Bridge-Token": bridgeToken },
      bridgeToken,
      bridgeCapabilityTokens,
      routes: bridgeRoutes,
    });
    const ok = unauthorized.status === 401 &&
      wrongToken.status === 401 &&
      authorized.status === 200 &&
      authorized.payload.ok === true;
    console.log(JSON.stringify({
      ok,
      mode: "in-process",
      route: "/status",
      unauthorizedStatus: unauthorized.status,
      wrongTokenStatus: wrongToken.status,
      authorizedStatus: authorized.status,
    }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  if (args.get("memory-source-move-inprocess-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-move-bridge-inprocess-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    const source = path.join(tempRoot, "Human Vault");
    const staleSource = path.join(tempRoot, "Changing Vault");
    const partialRollbackSource = path.join(tempRoot, "Partial Rollback Vault");
    const bridgeCapabilityToken = bridgeCapabilityTokens["memory-source-move"];
    const settingsCapabilityToken = bridgeCapabilityTokens["memory-settings-write"];
    let exitCode = 1;
    try {
      await mkdir(path.join(source, ".obsidian"), { recursive: true });
      await writeFile(path.join(source, "note.md"), "# Human note\n");
      await writeFile(path.join(source, ".obsidian", "app.json"), "{}\n");
      await mkdir(staleSource, { recursive: true });
      await writeFile(path.join(staleSource, "first.md"), "# First version\n");
      await mkdir(partialRollbackSource, { recursive: true });
      await writeFile(path.join(partialRollbackSource, "partial.md"), "# Partial rollback\n");

      const post = (routePath, body, capabilityToken = bridgeCapabilityToken) => invokeBridgeRouteForSelfTest({
        method: "POST",
        routePath,
        body,
        capabilityToken,
      });

      const unauthorizedCapability = await post("/memory/source/move-preflight", { path: source }, "");
      const ordinaryMoveSettingsResponse = await post("/memory/settings", {
        source: {
          path: source,
          kind: "obsidian-vault",
          ownership: "human-knowledge",
          importMode: "move-on-import",
        },
      }, settingsCapabilityToken);
      const stalePreflightResponse = await post("/memory/source/move-preflight", {
        path: staleSource,
        kind: "folder",
        ownership: "mixed-library",
      });
      const stalePreflight = stalePreflightResponse.payload;
      await writeFile(path.join(staleSource, "added-after-preflight.md"), "# Added after preflight\n");
      const staleExecuteResponse = await post("/memory/source/move-execute", {
        path: staleSource,
        kind: "folder",
        ownership: "mixed-library",
        confirmation: stalePreflight.confirmationPhrase,
        preflightFingerprint: stalePreflight.preflightFingerprint,
      });
      const staleSourcePreserved = existsSync(path.join(staleSource, "first.md")) &&
        existsSync(path.join(staleSource, "added-after-preflight.md"));
      const preflightResponse = await post("/memory/source/move-preflight", {
        path: source,
        kind: "obsidian-vault",
        ownership: "human-knowledge",
      });
      const preflight = preflightResponse.payload;
      const executeResponse = await post("/memory/source/move-execute", {
        path: source,
        kind: "obsidian-vault",
        ownership: "human-knowledge",
        confirmation: preflight.confirmationPhrase,
        preflightFingerprint: preflight.preflightFingerprint,
      });
      const executed = executeResponse.payload;
      const movedNoteExists = existsSync(path.join(executed.destinationRoot ?? "", "note.md"));
      const sourceRemoved = !existsSync(source);
      const rollbackResponse = await post("/memory/source/move-rollback", {
        ledgerPath: executed.ledgerPath,
        confirmation: "ROLLBACK MOVE",
      });
      const rollback = rollbackResponse.payload;
      const partialPreflightResponse = await post("/memory/source/move-preflight", {
        path: partialRollbackSource,
        kind: "folder",
        ownership: "mixed-library",
      });
      const partialPreflight = partialPreflightResponse.payload;
      const partialExecuteResponse = await post("/memory/source/move-execute", {
        path: partialRollbackSource,
        kind: "folder",
        ownership: "mixed-library",
        confirmation: partialPreflight.confirmationPhrase,
        preflightFingerprint: partialPreflight.preflightFingerprint,
      });
      const partialExecuted = partialExecuteResponse.payload;
      await writeFile(path.join(partialExecuted.destinationRoot ?? "", "partial.md"), "# Tampered after move\n");
      const partialRollbackResponse = await post("/memory/source/move-rollback", {
        ledgerPath: partialExecuted.ledgerPath,
        confirmation: "ROLLBACK MOVE",
      });
      const partialRollback = partialRollbackResponse.payload;
      const outsideLedger = path.join(tempRoot, "outside-ledger.jsonl");
      await writeFile(outsideLedger, "");
      const outsideRollbackResponse = await post("/memory/source/move-rollback", {
        ledgerPath: outsideLedger,
        confirmation: "ROLLBACK MOVE",
      });
      const restoredNoteExists = existsSync(path.join(source, "note.md"));
      const settings = JSON.parse(await readFile(memorySettingsPath(), "utf8").catch(() => "{\"sources\":[]}"));
      const moveHistoryEntries = await readMemorySourceMoveHistory(10);
      const moveHistorySerialized = JSON.stringify(moveHistoryEntries);
      const moveHistoryRedactsSourcePaths = !moveHistorySerialized.includes(source) &&
        !moveHistorySerialized.includes(partialRollbackSource) &&
        !moveHistorySerialized.includes(tempRoot) &&
        moveHistorySerialized.includes(`[path]/${path.basename(source)}`) &&
        moveHistorySerialized.includes("CONFIG/move-imports/");
      const ok = unauthorizedCapability.status === 403 &&
        ordinaryMoveSettingsResponse.status === 500 &&
        /audited move preflight and execute flow/i.test(String(ordinaryMoveSettingsResponse.payload.error ?? "")) &&
        stalePreflightResponse.status === 200 &&
        stalePreflight.okToMove === true &&
        staleExecuteResponse.status === 500 &&
        staleExecuteResponse.payload.ok === false &&
        /source changed after preflight/i.test(String(staleExecuteResponse.payload.error ?? "")) &&
        staleSourcePreserved &&
        preflightResponse.status === 200 &&
        preflight.ok &&
        preflight.okToMove === true &&
        preflight.hiddenFiles === 1 &&
        executeResponse.status === 200 &&
        executed.ok &&
        executed.status === "moved" &&
        executed.sourceCleanupStatus === "removed" &&
        movedNoteExists &&
        sourceRemoved &&
        rollbackResponse.status === 200 &&
        rollback.ok &&
        rollback.restoredCount === 2 &&
        partialPreflightResponse.status === 200 &&
        partialPreflight.okToMove === true &&
        partialExecuteResponse.status === 200 &&
        partialExecuted.ok &&
        partialRollbackResponse.status === 200 &&
        partialRollback.ok &&
        partialRollback.restoredCount === 0 &&
        partialRollback.skippedCount === 1 &&
        outsideRollbackResponse.status === 500 &&
        restoredNoteExists &&
        !settings.sources?.some((sourceEntry) => path.resolve(sourceEntry.ledgerPath ?? "") === path.resolve(executed.ledgerPath)) &&
        settings.sources?.some((sourceEntry) => path.resolve(sourceEntry.ledgerPath ?? "") === path.resolve(partialExecuted.ledgerPath)) &&
        moveHistoryEntries.length >= 4 &&
        moveHistoryEntries[0]?.action === "move-rollback" &&
        moveHistoryEntries[0]?.status === "partial" &&
        moveHistoryEntries.some((entry) => entry.action === "move-execute" && entry.status === "moved") &&
        moveHistoryRedactsSourcePaths;
      console.log(JSON.stringify({
        ok,
        mode: "in-process",
        unauthorizedCapabilityStatus: unauthorizedCapability.status,
        ordinaryMoveSettings: {
          status: ordinaryMoveSettingsResponse.status,
          error: ordinaryMoveSettingsResponse.payload.error,
        },
        stalePreflight: {
          ok: stalePreflight.ok,
          executeStatus: staleExecuteResponse.status,
          sourcePreserved: staleSourcePreserved,
          error: staleExecuteResponse.payload.error,
        },
        preflight: {
          ok: preflight.ok,
          okToMove: preflight.okToMove,
          fileCount: preflight.fileCount,
          hiddenFiles: preflight.hiddenFiles,
          preflightFingerprint: preflight.preflightFingerprint,
        },
        execute: {
          ok: executed.ok,
          status: executed.status,
          movedCount: executed.movedCount,
          sourceCleanupStatus: executed.sourceCleanupStatus,
          sourceRemoved,
          movedNoteExists,
        },
        rollback: {
          ok: rollback.ok,
          restoredCount: rollback.restoredCount,
          restoredNoteExists,
          outsideLedgerStatus: outsideRollbackResponse.status,
        },
        partialRollback: {
          ok: partialRollback.ok,
          restoredCount: partialRollback.restoredCount,
          skippedCount: partialRollback.skippedCount,
          sourceStillRegistered: settings.sources?.some((sourceEntry) =>
            path.resolve(sourceEntry.ledgerPath ?? "") === path.resolve(partialExecuted.ledgerPath)
          ) ?? false,
        },
        moveHistory: {
          count: moveHistoryEntries.length,
          latestAction: moveHistoryEntries[0]?.action ?? "",
          latestStatus: moveHistoryEntries[0]?.status ?? "",
          latestOriginalPath: moveHistoryEntries[0]?.originalPath ?? "",
          latestManagedPath: moveHistoryEntries[0]?.managedPath ?? "",
          latestManifestPath: moveHistoryEntries[0]?.manifestPath ?? "",
          sourcePathSample: moveHistoryEntries.find((entry) => entry.originalPath)?.originalPath ?? "",
          ledgerPathSample: moveHistoryEntries.find((entry) => entry.ledgerPath)?.ledgerPath ?? "",
          redactsSourcePaths: moveHistoryRedactsSourcePaths,
        },
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } finally {
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("hermes-delegation-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-hermes-bridge-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousHermesCommand = process.env.HERMES_COMMAND;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    let server = null;
    let exitCode = 1;
    try {
      setAddonRuntimeSelfTestHomeDir(tempRoot);
      const fakeHermes = path.join(tempRoot, ".hermes", "bin", process.platform === "win32" ? "hermes.exe" : "hermes");
      await mkdir(path.dirname(fakeHermes), { recursive: true });
      await writeFile(fakeHermes, process.platform === "win32" ? "@echo off\r\necho fake hermes\r\n" : "#!/bin/sh\necho fake hermes\n");
      await chmod(fakeHermes, 0o755).catch(() => undefined);
      process.env.HERMES_COMMAND = fakeHermes;
      server = await startBridgeServer({
        port: Number(args.get("bridge-port") ?? 0),
        bridgeToken,
        bridgeCapabilityTokens,
        extensionOrigin: resonantExtensionOrigin,
        routes: bridgeRoutes,
      });
      const actualPort = bridgeServerPort(server, Number(args.get("bridge-port") ?? 0));
      const request = async (route, body = {}) => {
        const capabilityToken = capabilityTokenForRoute(route, "POST");
        const response = await fetch(`http://127.0.0.1:${actualPort}${route}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": resonantExtensionOrigin,
            "X-ResonantOS-Bridge-Token": bridgeToken,
            ...(capabilityToken ? { "X-ResonantOS-Bridge-Capability-Token": capabilityToken } : {}),
          },
          body: JSON.stringify(body),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(`${route} failed: ${payload.error || response.status}`);
        }
        return payload;
      };
      const created = await request("/addons/delegate", {
        target: "hermes",
        mission: "Prepare a routine coordination summary for deterministic Hermes lifecycle testing.",
        contextMarkdown: "Visible page and task context are bounded test evidence.",
      });
      const gated = await request("/addons/delegate", {
        target: "hermes",
        mission: "Check that real Hermes execution is gated unless explicitly enabled.",
      });
      const gatedStart = await request("/hermes/delegation/start", { path: gated.path });
      const statusBefore = await request("/hermes/delegation/status", { path: created.path });
      const started = await request("/hermes/delegation/start", { path: created.path, adapter: "deterministic" });
      const artifact = await request("/hermes/delegation/artifact", { path: created.path });
      const listed = await request("/addons/delegate/list", { target: "hermes", limit: 5 });
      const statusAfter = await request("/hermes/delegation/status", { path: created.path });
      const hermesStatus = await request("/hermes/status", {});
      const ok = (
        created.status === "queued" &&
        gatedStart.status === "blocked" &&
        /execution is disabled/i.test(gatedStart.blockedReason || "") &&
        statusBefore.status === "queued" &&
        started.status === "completed" &&
        /Hermes delegation is ready for review/.test(artifact.finalSummary) &&
        listed.delegations.some((delegation) => delegation.id === created.id && delegation.status === "completed") &&
        statusAfter.resultArtifactPath &&
        hermesStatus.boundary?.includes("Hermes is an add-on agent")
      );
      console.log(JSON.stringify({
        ok,
        artifactPath: artifact.path,
        created: created.id,
        gatedStatus: gatedStart.status,
        hermesMode: hermesStatus.mode,
        listed: listed.delegations.length,
        statusAfter: statusAfter.status,
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousHermesCommand === undefined) {
        delete process.env.HERMES_COMMAND;
      } else {
        process.env.HERMES_COMMAND = previousHermesCommand;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("hermes-delegation-inprocess-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-hermes-bridge-inprocess-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousHermesCommand = process.env.HERMES_COMMAND;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    let exitCode = 1;
    try {
      setAddonRuntimeSelfTestHomeDir(tempRoot);
      const fakeHermes = path.join(tempRoot, ".hermes", "bin", process.platform === "win32" ? "hermes.exe" : "hermes");
      await mkdir(path.dirname(fakeHermes), { recursive: true });
      await writeFile(fakeHermes, process.platform === "win32" ? "@echo off\r\necho fake hermes\r\n" : "#!/bin/sh\necho fake hermes\n");
      await chmod(fakeHermes, 0o755).catch(() => undefined);
      process.env.HERMES_COMMAND = fakeHermes;
      const request = async (routePath, body = {}) => {
        const response = await invokeBridgeRouteForSelfTest({
          method: "POST",
          routePath,
          body,
          capabilityToken: capabilityTokenForRoute(routePath, "POST"),
        });
        if (response.status !== 200) {
          throw new Error(`${routePath} failed: ${response.payload.error || response.status}`);
        }
        return response.payload;
      };
      const created = await request("/addons/delegate", {
        target: "hermes",
        mission: "Prepare a routine coordination summary for deterministic Hermes lifecycle testing.",
        contextMarkdown: "Visible page and task context are bounded test evidence.",
      });
      const gated = await request("/addons/delegate", {
        target: "hermes",
        mission: "Check that real Hermes execution is gated unless explicitly enabled.",
      });
      const gatedStart = await request("/hermes/delegation/start", { path: gated.path });
      const statusBefore = await request("/hermes/delegation/status", { path: created.path });
      const started = await request("/hermes/delegation/start", { path: created.path, adapter: "deterministic" });
      const artifact = await request("/hermes/delegation/artifact", { path: created.path });
      const listed = await request("/addons/delegate/list", { target: "hermes", limit: 5 });
      const statusAfter = await request("/hermes/delegation/status", { path: created.path });
      const hermesStatus = await request("/hermes/status", {});
      const ok = (
        created.status === "queued" &&
        gatedStart.status === "blocked" &&
        /execution is disabled/i.test(gatedStart.blockedReason || "") &&
        statusBefore.status === "queued" &&
        started.status === "completed" &&
        /Hermes delegation is ready for review/.test(artifact.finalSummary) &&
        listed.delegations.length >= 1 &&
        Boolean(statusAfter.resultArtifactPath) &&
        statusAfter.status === "completed" &&
        hermesStatus.boundary?.includes("Hermes is an add-on agent")
      );
      console.log(JSON.stringify({
        ok,
        mode: "in-process",
        artifactPath: artifact.path,
        created: created.id,
        gatedStatus: gatedStart.status,
        hermesMode: hermesStatus.mode,
        listed: listed.delegations.length,
        statusAfter: statusAfter.status,
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousHermesCommand === undefined) {
        delete process.env.HERMES_COMMAND;
      } else {
        process.env.HERMES_COMMAND = previousHermesCommand;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("hermes-cli-execution-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-hermes-cli-bridge-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousHermesCommand = process.env.HERMES_COMMAND;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousProviderSecretsJson = process.env.RESONANTOS_PROVIDER_SECRETS_JSON;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    let server = null;
    let exitCode = 1;
    try {
      setAddonRuntimeSelfTestHomeDir(tempRoot);
      const fakeOutput = [
        "## Final Summary",
        "Hermes CLI adapter completed the requested production execution test.",
        "",
        "## Actions Taken",
        "- Parsed the ResonantOS task packet.",
        "- Returned a reviewable artifact instead of taking external action.",
        "",
        "## Approval Needs",
        "- Human approval remains required for any external send, submit, wallet action, or trusted memory write.",
        "",
        "## Residual Risks",
        "- This is a fake Hermes executable used only for deterministic adapter validation.",
        "",
        "## Verification",
        "- Local Hermes CLI process was invoked through the host boundary.",
      ].join("\n");
      const fakeHermes = await writeFakeHermesPythonRuntime(path.join(tempRoot, ".hermes"), fakeOutput);
      process.env.HERMES_COMMAND = fakeHermes;
      delete process.env.OPENAI_API_KEY;
      process.env.RESONANTOS_PROVIDER_SECRETS_JSON = JSON.stringify({ "shared-openai": "must-not-reach-hermes" });
      server = await startBridgeServer({
        port: Number(args.get("bridge-port") ?? 0),
        bridgeToken,
        bridgeCapabilityTokens,
        extensionOrigin: resonantExtensionOrigin,
        routes: bridgeRoutes,
      });
      const actualPort = bridgeServerPort(server, Number(args.get("bridge-port") ?? 0));
      const request = async (route, { method = "POST", body = {}, capabilityToken } = {}) => {
        const effectiveCapabilityToken = capabilityTokenForRoute(route, method, capabilityToken);
        const response = await fetch(`http://127.0.0.1:${actualPort}${route}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Origin": resonantExtensionOrigin,
            "X-ResonantOS-Bridge-Token": bridgeToken,
            ...(effectiveCapabilityToken ? { "X-ResonantOS-Bridge-Capability-Token": effectiveCapabilityToken } : {}),
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(`${route} failed: ${payload.error || response.status}`);
        }
        return payload;
      };
      await request("/addons/execution-settings", {
        body: { addon: "hermes", localCliExecution: true },
        capabilityToken: bridgeCapabilityTokens["addon-execution-settings-write"],
      });
      await request("/providers/credentials", {
        body: { providerId: "shared-openai", credential: "hermes-runtime-key" },
        capabilityToken: bridgeCapabilityTokens["provider-credential-write"],
      });
      const created = await request("/addons/delegate", {
        body: {
          target: "hermes",
          mission: "Validate that enabled Hermes CLI execution produces a governed artifact.",
          contextMarkdown: "This is deterministic test context only.",
        },
      });
      const started = await request("/hermes/delegation/start", { body: { path: created.path } });
      const artifact = await request("/hermes/delegation/artifact", { body: { path: created.path } });
      const statusAfter = await request("/hermes/delegation/status", { body: { path: created.path } });
      const hermesStatus = await request("/hermes/status", { body: {} });
      const ok = (
        started.status === "completed" &&
        /Hermes CLI adapter completed/.test(artifact.finalSummary ?? "") &&
        statusAfter.status === "completed" &&
        hermesStatus.executionEnabled === true &&
        hermesStatus.mode === "local-hermes-cli"
      );
      console.log(JSON.stringify({
        ok,
        adapter: started.adapter,
        artifactPath: artifact.path,
        hermesMode: hermesStatus.mode,
        statusAfter: statusAfter.status,
        summary: artifact.finalSummary ?? "",
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousHermesCommand === undefined) {
        delete process.env.HERMES_COMMAND;
      } else {
        process.env.HERMES_COMMAND = previousHermesCommand;
      }
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousProviderSecretsJson === undefined) {
        delete process.env.RESONANTOS_PROVIDER_SECRETS_JSON;
      } else {
        process.env.RESONANTOS_PROVIDER_SECRETS_JSON = previousProviderSecretsJson;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("hermes-cli-execution-inprocess-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-hermes-cli-bridge-inprocess-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousHermesCommand = process.env.HERMES_COMMAND;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousProviderSecretsJson = process.env.RESONANTOS_PROVIDER_SECRETS_JSON;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    let exitCode = 1;
    try {
      setAddonRuntimeSelfTestHomeDir(tempRoot);
      const fakeOutput = [
        "## Final Summary",
        "Hermes CLI adapter completed the requested production execution test.",
        "",
        "## Actions Taken",
        "- Parsed the ResonantOS task packet.",
        "- Returned a reviewable artifact instead of taking external action.",
        "",
        "## Approval Needs",
        "- Human approval remains required for any external send, submit, wallet action, or trusted memory write.",
        "",
        "## Residual Risks",
        "- This is a fake Hermes executable used only for deterministic adapter validation.",
        "",
        "## Verification",
        "- Local Hermes CLI process was invoked through the host boundary.",
      ].join("\n");
      const fakeHermes = await writeFakeHermesPythonRuntime(path.join(tempRoot, ".hermes"), fakeOutput);
      process.env.HERMES_COMMAND = fakeHermes;
      delete process.env.OPENAI_API_KEY;
      delete process.env.RESONANTOS_PROVIDER_SECRETS_JSON;
      const request = async (routePath, { method = "POST", body = {}, capabilityToken } = {}) => {
        const response = await invokeBridgeRouteForSelfTest({
          method,
          routePath,
          body,
          capabilityToken: capabilityTokenForRoute(routePath, method, capabilityToken),
        });
        if (response.status !== 200) {
          throw new Error(`${routePath} failed: ${response.payload.error || response.status}`);
        }
        return response.payload;
      };
      await request("/addons/execution-settings", {
        body: { addon: "hermes", localCliExecution: true },
          capabilityToken: bridgeCapabilityTokens["addon-execution-settings-write"],
        });
      const blockedCreated = await request("/addons/delegate", {
        body: {
          target: "hermes",
          mission: "Validate that Hermes reports missing provider credentials as blocked.",
          contextMarkdown: "This is deterministic test context only.",
        },
      });
      const blockedStarted = await request("/hermes/delegation/start", {
        body: {
          path: blockedCreated.path,
          provider: "missing-provider",
          model: "missing-model",
        },
      });
      if (blockedStarted.status !== "blocked" || !/provider credential unavailable/i.test(blockedStarted.blockedReason ?? "")) {
        throw new Error(`Hermes missing-provider regression did not return blocked guidance: ${JSON.stringify({
          blockedReason: blockedStarted.blockedReason,
          failureReason: blockedStarted.failureReason,
          status: blockedStarted.status,
        })}`);
      }
      process.env.RESONANTOS_PROVIDER_SECRETS_JSON = JSON.stringify({ "shared-openai": "must-not-reach-hermes" });
      await request("/providers/credentials", {
        body: { providerId: "shared-openai", credential: "hermes-runtime-key" },
        capabilityToken: bridgeCapabilityTokens["provider-credential-write"],
      });
      const created = await request("/addons/delegate", {
        body: {
          target: "hermes",
          mission: "Validate that enabled Hermes CLI execution produces a governed artifact.",
          contextMarkdown: "This is deterministic test context only.",
        },
      });
      const started = await request("/hermes/delegation/start", { body: { path: created.path } });
      const artifact = await request("/hermes/delegation/artifact", { body: { path: created.path } });
      const statusAfter = await request("/hermes/delegation/status", { body: { path: created.path } });
      const hermesStatus = await request("/hermes/status", { body: {} });
      const ok = (
        started.status === "completed" &&
        /Hermes CLI adapter completed/.test(artifact.finalSummary ?? "") &&
        statusAfter.status === "completed" &&
        hermesStatus.executionEnabled === true &&
        hermesStatus.mode === "local-hermes-cli"
      );
      console.log(JSON.stringify({
        ok,
        mode: "in-process",
        adapter: started.adapter,
        artifactPath: artifact.path,
        hermesMode: hermesStatus.mode,
        statusAfter: statusAfter.status,
        summary: artifact.finalSummary ?? "",
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousHermesCommand === undefined) {
        delete process.env.HERMES_COMMAND;
      } else {
        process.env.HERMES_COMMAND = previousHermesCommand;
      }
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousProviderSecretsJson === undefined) {
        delete process.env.RESONANTOS_PROVIDER_SECRETS_JSON;
      } else {
        process.env.RESONANTOS_PROVIDER_SECRETS_JSON = previousProviderSecretsJson;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("opencode-delegation-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-opencode-bridge-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousOpenCodeCommand = process.env.OPENCODE_COMMAND;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    let server = null;
    let exitCode = 1;
    try {
      setAddonRuntimeSelfTestHomeDir(tempRoot);
      const fakeOpenCode = path.join(tempRoot, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
      await mkdir(path.dirname(fakeOpenCode), { recursive: true });
      await writeFile(fakeOpenCode, process.platform === "win32" ? "@echo off\r\necho fake opencode\r\n" : "#!/bin/sh\necho fake opencode\n");
      await chmod(fakeOpenCode, 0o755).catch(() => undefined);
      process.env.OPENCODE_COMMAND = fakeOpenCode;
      server = await startBridgeServer({
        port: Number(args.get("bridge-port") ?? 0),
        bridgeToken,
        bridgeCapabilityTokens,
        extensionOrigin: resonantExtensionOrigin,
        routes: bridgeRoutes,
      });
      const actualPort = bridgeServerPort(server, Number(args.get("bridge-port") ?? 0));
      const request = async (route, body = {}) => {
        const capabilityToken = capabilityTokenForRoute(route, "POST");
        const response = await fetch(`http://127.0.0.1:${actualPort}${route}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": resonantExtensionOrigin,
            "X-ResonantOS-Bridge-Token": bridgeToken,
            ...(capabilityToken ? { "X-ResonantOS-Bridge-Capability-Token": capabilityToken } : {}),
          },
          body: JSON.stringify(body),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(`${route} failed: ${payload.error || response.status}`);
        }
        return payload;
      };
      const created = await request("/addons/delegate", {
        target: "opencode",
        mission: "Inspect the deterministic OpenCode lifecycle test and return verification evidence.",
        contextMarkdown: "This is a bounded coding-task fixture; no real files should be edited.",
      });
      const gated = await request("/addons/delegate", {
        target: "opencode",
        mission: "Check that real OpenCode execution is gated unless explicitly enabled.",
      });
      const gatedStart = await request("/opencode/delegation/start", { path: gated.path });
      const statusBefore = await request("/opencode/delegation/status", { path: created.path });
      const started = await request("/opencode/delegation/start", { path: created.path, adapter: "deterministic" });
      const artifact = await request("/opencode/delegation/artifact", { path: created.path });
      const listed = await request("/addons/delegate/list", { target: "opencode", limit: 5 });
      const statusAfter = await request("/opencode/delegation/status", { path: created.path });
      const ok = (
        created.status === "queued" &&
        gatedStart.status === "blocked" &&
        /execution is disabled/i.test(gatedStart.blockedReason || "") &&
        statusBefore.status === "queued" &&
        started.status === "completed" &&
        /OpenCode coding delegation is ready for review/.test(artifact.finalSummary) &&
        listed.delegations.length >= 1 &&
        statusAfter.status === "completed" &&
        Boolean(statusAfter.resultArtifactPath)
      );
      console.log(JSON.stringify({
        ok,
        artifactPath: artifact.path,
        created: created.id,
        gatedStatus: gatedStart.status,
        listed: listed.delegations.length,
        statusAfter: statusAfter.status,
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousOpenCodeCommand === undefined) {
        delete process.env.OPENCODE_COMMAND;
      } else {
        process.env.OPENCODE_COMMAND = previousOpenCodeCommand;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("opencode-delegation-inprocess-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-opencode-bridge-inprocess-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousOpenCodeCommand = process.env.OPENCODE_COMMAND;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    let exitCode = 1;
    try {
      setAddonRuntimeSelfTestHomeDir(tempRoot);
      const fakeOpenCode = path.join(tempRoot, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
      await mkdir(path.dirname(fakeOpenCode), { recursive: true });
      await writeFile(fakeOpenCode, process.platform === "win32" ? "@echo off\r\necho fake opencode\r\n" : "#!/bin/sh\necho fake opencode\n");
      await chmod(fakeOpenCode, 0o755).catch(() => undefined);
      process.env.OPENCODE_COMMAND = fakeOpenCode;
      const request = async (routePath, body = {}) => {
        const response = await invokeBridgeRouteForSelfTest({
          method: "POST",
          routePath,
          body,
          capabilityToken: capabilityTokenForRoute(routePath, "POST"),
        });
        if (response.status !== 200) {
          throw new Error(`${routePath} failed: ${response.payload.error || response.status}`);
        }
        return response.payload;
      };
      const created = await request("/addons/delegate", {
        target: "opencode",
        mission: "Inspect the deterministic OpenCode lifecycle test and return verification evidence.",
        contextMarkdown: "This is a bounded coding-task fixture; no real files should be edited.",
      });
      const gated = await request("/addons/delegate", {
        target: "opencode",
        mission: "Check that real OpenCode execution is gated unless explicitly enabled.",
      });
      const gatedStart = await request("/opencode/delegation/start", { path: gated.path });
      const statusBefore = await request("/opencode/delegation/status", { path: created.path });
      const started = await request("/opencode/delegation/start", { path: created.path, adapter: "deterministic" });
      const artifact = await request("/opencode/delegation/artifact", { path: created.path });
      const listed = await request("/addons/delegate/list", { target: "opencode", limit: 5 });
      const statusAfter = await request("/opencode/delegation/status", { path: created.path });
      const ok = (
        created.status === "queued" &&
        gatedStart.status === "blocked" &&
        /execution is disabled/i.test(gatedStart.blockedReason || "") &&
        statusBefore.status === "queued" &&
        started.status === "completed" &&
        /OpenCode coding delegation is ready for review/.test(artifact.finalSummary) &&
        listed.delegations.length >= 1 &&
        statusAfter.status === "completed" &&
        Boolean(statusAfter.resultArtifactPath)
      );
      console.log(JSON.stringify({
        ok,
        mode: "in-process",
        artifactPath: artifact.path,
        created: created.id,
        gatedStatus: gatedStart.status,
        listed: listed.delegations.length,
        statusAfter: statusAfter.status,
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousOpenCodeCommand === undefined) {
        delete process.env.OPENCODE_COMMAND;
      } else {
        process.env.OPENCODE_COMMAND = previousOpenCodeCommand;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("opencode-cli-execution-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-opencode-cli-bridge-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousOpenCodeCommand = process.env.OPENCODE_COMMAND;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousProviderSecretsJson = process.env.RESONANTOS_PROVIDER_SECRETS_JSON;
    const previousOpenCodeProviderEnv = process.env.RESONANTOS_OPENCODE_PROVIDER_ENV;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    let server = null;
    let exitCode = 1;
    try {
      setAddonRuntimeSelfTestHomeDir(tempRoot);
      const fakeOpenCode = path.join(tempRoot, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
      const fakeOutput = [
        "## Final Summary",
        "OpenCode CLI adapter completed the requested production execution test.",
        "",
        "## Changed Files",
        "- None; fake runtime validation only.",
        "",
        "## Commands Run",
        "- opencode run <governed prompt> --dir <workspace>",
        "",
        "## Tests",
        "- Validated the fake OpenCode executable through the host boundary.",
        "",
        "## Residual Risks",
        "- This is a fake OpenCode executable used only for deterministic adapter validation.",
        "",
        "## Verification",
        "- Local OpenCode CLI process was invoked through the host boundary.",
      ].join("\n");
      await mkdir(path.dirname(fakeOpenCode), { recursive: true });
      delete process.env.OPENAI_API_KEY;
      process.env.RESONANTOS_PROVIDER_SECRETS_JSON = JSON.stringify({ "shared-openai": "must-not-reach-opencode" });
      process.env.RESONANTOS_OPENCODE_PROVIDER_ENV = "RESONANTOS_PROVIDER_SECRETS_JSON";
      await writeFile(fakeOpenCode, fakeOpenCodeCliScript(fakeOutput));
      await chmod(fakeOpenCode, 0o755).catch(() => undefined);
      process.env.OPENCODE_COMMAND = fakeOpenCode;
      server = await startBridgeServer({
        port: Number(args.get("bridge-port") ?? 0),
        bridgeToken,
        bridgeCapabilityTokens,
        extensionOrigin: resonantExtensionOrigin,
        routes: bridgeRoutes,
      });
      const actualPort = bridgeServerPort(server, Number(args.get("bridge-port") ?? 0));
      const request = async (route, { method = "POST", body = {}, capabilityToken } = {}) => {
        const effectiveCapabilityToken = capabilityTokenForRoute(route, method, capabilityToken);
        const response = await fetch(`http://127.0.0.1:${actualPort}${route}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Origin": resonantExtensionOrigin,
            "X-ResonantOS-Bridge-Token": bridgeToken,
            ...(effectiveCapabilityToken ? { "X-ResonantOS-Bridge-Capability-Token": effectiveCapabilityToken } : {}),
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(`${route} failed: ${payload.error || response.status}`);
        }
        return payload;
      };
      await request("/addons/execution-settings", {
        body: { addon: "opencode", localCliExecution: true },
        capabilityToken: bridgeCapabilityTokens["addon-execution-settings-write"],
      });
      await request("/providers/credentials", {
        body: { providerId: "shared-openai", credential: "opencode-runtime-key" },
        capabilityToken: bridgeCapabilityTokens["provider-credential-write"],
      });
      const created = await request("/addons/delegate", {
        body: {
          target: "opencode",
          mission: "Validate that enabled OpenCode CLI execution produces a governed coding artifact.",
          contextMarkdown: "This is deterministic test context only.",
        },
      });
      const started = await request("/opencode/delegation/start", { body: { path: created.path } });
      const artifact = await request("/opencode/delegation/artifact", { body: { path: created.path } });
      const statusAfter = await request("/opencode/delegation/status", { body: { path: created.path } });
      const opencodeStatus = await request("/opencode/status", { method: "GET" });
      const ok = (
        started.status === "completed" &&
        started.adapter === "opencode-cli" &&
        statusAfter.status === "completed" &&
        statusAfter.resultArtifactPath &&
        opencodeStatus.executionEnabled === true &&
        opencodeStatus.mode === "local-opencode-cli" &&
        opencodeStatus.providerEnvKeys?.includes("OPENAI_API_KEY") &&
        /OpenCode CLI adapter completed/.test(artifact.finalSummary) &&
        /host boundary/.test(artifact.verification)
      );
      console.log(JSON.stringify({
        ok,
        adapter: started.adapter,
        artifactPath: artifact.path,
        opencodeMode: opencodeStatus.mode,
        statusAfter: statusAfter.status,
        summary: artifact.finalSummary,
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousOpenCodeCommand === undefined) {
        delete process.env.OPENCODE_COMMAND;
      } else {
        process.env.OPENCODE_COMMAND = previousOpenCodeCommand;
      }
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousProviderSecretsJson === undefined) {
        delete process.env.RESONANTOS_PROVIDER_SECRETS_JSON;
      } else {
        process.env.RESONANTOS_PROVIDER_SECRETS_JSON = previousProviderSecretsJson;
      }
      if (previousOpenCodeProviderEnv === undefined) {
        delete process.env.RESONANTOS_OPENCODE_PROVIDER_ENV;
      } else {
        process.env.RESONANTOS_OPENCODE_PROVIDER_ENV = previousOpenCodeProviderEnv;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("opencode-cli-execution-inprocess-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-opencode-cli-bridge-inprocess-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousOpenCodeCommand = process.env.OPENCODE_COMMAND;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousProviderSecretsJson = process.env.RESONANTOS_PROVIDER_SECRETS_JSON;
    const previousOpenCodeProviderEnv = process.env.RESONANTOS_OPENCODE_PROVIDER_ENV;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    let exitCode = 1;
    try {
      setAddonRuntimeSelfTestHomeDir(tempRoot);
      const fakeOpenCode = path.join(tempRoot, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
      const fakeOutput = [
        "## Final Summary",
        "OpenCode CLI adapter completed the requested production execution test.",
        "",
        "## Changed Files",
        "- None; fake runtime validation only.",
        "",
        "## Commands Run",
        "- opencode run <governed prompt> --dir <workspace>",
        "",
        "## Tests",
        "- Validated the fake OpenCode executable through the host boundary.",
        "",
        "## Residual Risks",
        "- This is a fake OpenCode executable used only for deterministic adapter validation.",
        "",
        "## Verification",
        "- Local OpenCode CLI process was invoked through the host boundary.",
      ].join("\n");
      await mkdir(path.dirname(fakeOpenCode), { recursive: true });
      delete process.env.OPENAI_API_KEY;
      process.env.RESONANTOS_PROVIDER_SECRETS_JSON = JSON.stringify({ "shared-openai": "must-not-reach-opencode" });
      process.env.RESONANTOS_OPENCODE_PROVIDER_ENV = "RESONANTOS_PROVIDER_SECRETS_JSON";
      await writeFile(fakeOpenCode, fakeOpenCodeCliScript(fakeOutput));
      await chmod(fakeOpenCode, 0o755).catch(() => undefined);
      process.env.OPENCODE_COMMAND = fakeOpenCode;
      const request = async (routePath, { method = "POST", body = {}, capabilityToken } = {}) => {
        const response = await invokeBridgeRouteForSelfTest({
          method,
          routePath,
          body,
          capabilityToken: capabilityTokenForRoute(routePath, method, capabilityToken),
        });
        if (response.status !== 200) {
          throw new Error(`${routePath} failed: ${response.payload.error || response.status}`);
        }
        return response.payload;
      };
      await request("/addons/execution-settings", {
        body: { addon: "opencode", localCliExecution: true },
        capabilityToken: bridgeCapabilityTokens["addon-execution-settings-write"],
      });
      await request("/providers/credentials", {
        body: { providerId: "shared-openai", credential: "opencode-runtime-key" },
        capabilityToken: bridgeCapabilityTokens["provider-credential-write"],
      });
      const created = await request("/addons/delegate", {
        body: {
          target: "opencode",
          mission: "Validate that enabled OpenCode CLI execution produces a governed coding artifact.",
          contextMarkdown: "This is deterministic test context only.",
        },
      });
      const started = await request("/opencode/delegation/start", { body: { path: created.path } });
      const artifact = await request("/opencode/delegation/artifact", { body: { path: created.path } });
      const statusAfter = await request("/opencode/delegation/status", { body: { path: created.path } });
      const opencodeStatus = await request("/opencode/status", { method: "GET" });
      const ok = (
        started.status === "completed" &&
        started.adapter === "opencode-cli" &&
        statusAfter.status === "completed" &&
        statusAfter.resultArtifactPath &&
        opencodeStatus.executionEnabled === true &&
        opencodeStatus.mode === "local-opencode-cli" &&
        opencodeStatus.providerEnvKeys?.includes("OPENAI_API_KEY") &&
        /OpenCode CLI adapter completed/.test(artifact.finalSummary) &&
        /host boundary/.test(artifact.verification)
      );
      console.log(JSON.stringify({
        ok,
        mode: "in-process",
        adapter: started.adapter,
        artifactPath: artifact.path,
        opencodeMode: opencodeStatus.mode,
        statusAfter: statusAfter.status,
        summary: artifact.finalSummary,
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousOpenCodeCommand === undefined) {
        delete process.env.OPENCODE_COMMAND;
      } else {
        process.env.OPENCODE_COMMAND = previousOpenCodeCommand;
      }
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousProviderSecretsJson === undefined) {
        delete process.env.RESONANTOS_PROVIDER_SECRETS_JSON;
      } else {
        process.env.RESONANTOS_PROVIDER_SECRETS_JSON = previousProviderSecretsJson;
      }
      if (previousOpenCodeProviderEnv === undefined) {
        delete process.env.RESONANTOS_OPENCODE_PROVIDER_ENV;
      } else {
        process.env.RESONANTOS_OPENCODE_PROVIDER_ENV = previousOpenCodeProviderEnv;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("addon-execution-settings-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-addon-execution-bridge-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousHermesCommand = process.env.HERMES_COMMAND;
    const previousOpenCodeCommand = process.env.OPENCODE_COMMAND;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    let server = null;
    let exitCode = 1;
    try {
      setAddonRuntimeSelfTestHomeDir(tempRoot);
      const hermesBinRoot = path.join(tempRoot, ".hermes", "bin");
      const openCodeBinRoot = path.join(tempRoot, ".opencode", "bin");
      const fakeHermes = path.join(hermesBinRoot, process.platform === "win32" ? "hermes.exe" : "hermes");
      const fakeOpenCode = path.join(openCodeBinRoot, process.platform === "win32" ? "opencode.exe" : "opencode");
      await Promise.all([
        mkdir(hermesBinRoot, { recursive: true }),
        mkdir(openCodeBinRoot, { recursive: true }),
      ]);
      await writeFile(fakeHermes, process.platform === "win32" ? "@echo off\r\necho fake hermes\r\n" : "#!/bin/sh\necho fake hermes\n");
      await writeFile(fakeOpenCode, process.platform === "win32" ? "@echo off\r\necho fake opencode\r\n" : "#!/bin/sh\necho fake opencode\n");
      await chmod(fakeHermes, 0o755).catch(() => undefined);
      await chmod(fakeOpenCode, 0o755).catch(() => undefined);
      process.env.HERMES_COMMAND = fakeHermes;
      process.env.OPENCODE_COMMAND = fakeOpenCode;
      server = await startBridgeServer({
        port: Number(args.get("bridge-port") ?? 0),
        bridgeToken,
        bridgeCapabilityTokens,
        extensionOrigin: resonantExtensionOrigin,
        routes: bridgeRoutes,
      });
      const actualPort = bridgeServerPort(server, Number(args.get("bridge-port") ?? 0));
      const request = async (route, { method = "GET", body, capabilityToken } = {}) => {
        const response = await fetch(`http://127.0.0.1:${actualPort}${route}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Origin": resonantExtensionOrigin,
            "X-ResonantOS-Bridge-Token": bridgeToken,
            ...(capabilityToken ? { "X-ResonantOS-Bridge-Capability-Token": capabilityToken } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const payload = await response.json();
        return { ok: response.ok, payload, status: response.status };
      };
      const initial = await request("/addons/execution-settings");
      const denied = await request("/addons/execution-settings", {
        method: "POST",
        body: { addon: "hermes", localCliExecution: true },
      });
      const hermesEnabled = await request("/addons/execution-settings", {
        method: "POST",
        capabilityToken: bridgeCapabilityTokens["addon-execution-settings-write"],
        body: { addon: "hermes", localCliExecution: true },
      });
      const opencodeEnabled = await request("/addons/execution-settings", {
        method: "POST",
        capabilityToken: bridgeCapabilityTokens["addon-execution-settings-write"],
        body: { addon: "opencode", localCliExecution: true },
      });
      const after = await request("/addons/execution-settings");
      const hermesStatus = await request("/hermes/status", {
        method: "POST",
        body: {},
        capabilityToken: bridgeCapabilityTokens["addon-runtime-read"],
      });
      const opencodeStatus = await request("/opencode/status");
      const addons = await request("/addons/status");
      const ok = (
        initial.ok &&
        initial.payload.settings.hermes.localCliExecution === false &&
        initial.payload.settings.opencode.localCliExecution === false &&
        denied.status === 403 &&
        hermesEnabled.payload.status === "enabled" &&
        opencodeEnabled.payload.status === "enabled" &&
        after.payload.settings.hermes.localCliExecution === true &&
        after.payload.settings.opencode.localCliExecution === true &&
        hermesStatus.payload.executionEnabled === true &&
        hermesStatus.payload.mode === "local-hermes-cli" &&
        opencodeStatus.payload.executionEnabled === true &&
        opencodeStatus.payload.mode === "local-opencode-cli" &&
        addons.payload.addons.some((addon) => addon.id === "addon.hermes" && addon.available === true && addon.execution?.localCliExecution === true && addon.execution?.runtimeAvailable === true) &&
        addons.payload.addons.some((addon) => addon.id === "addon.opencode" && addon.execution?.localCliExecution === true)
      );
      console.log(JSON.stringify({
        ok,
        deniedStatus: denied.status,
        enabled: after.payload.settings.hermes.localCliExecution === true && after.payload.settings.opencode.localCliExecution === true,
        hermesMode: hermesStatus.payload.mode,
        opencodeMode: opencodeStatus.payload.mode,
        settings: after.payload.settings,
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousHermesCommand === undefined) {
        delete process.env.HERMES_COMMAND;
      } else {
        process.env.HERMES_COMMAND = previousHermesCommand;
      }
      if (previousOpenCodeCommand === undefined) {
        delete process.env.OPENCODE_COMMAND;
      } else {
        process.env.OPENCODE_COMMAND = previousOpenCodeCommand;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("addon-execution-settings-inprocess-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-addon-execution-bridge-inprocess-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousHermesCommand = process.env.HERMES_COMMAND;
    const previousOpenCodeCommand = process.env.OPENCODE_COMMAND;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    let exitCode = 1;
    try {
      setAddonRuntimeSelfTestHomeDir(tempRoot);
      const hermesBinRoot = path.join(tempRoot, ".hermes", "bin");
      const openCodeBinRoot = path.join(tempRoot, ".opencode", "bin");
      const fakeHermes = path.join(hermesBinRoot, process.platform === "win32" ? "hermes.exe" : "hermes");
      const fakeOpenCode = path.join(openCodeBinRoot, process.platform === "win32" ? "opencode.exe" : "opencode");
      await Promise.all([
        mkdir(hermesBinRoot, { recursive: true }),
        mkdir(openCodeBinRoot, { recursive: true }),
      ]);
      await writeFile(fakeHermes, process.platform === "win32" ? "@echo off\r\necho fake hermes\r\n" : "#!/bin/sh\necho fake hermes\n");
      await writeFile(fakeOpenCode, process.platform === "win32" ? "@echo off\r\necho fake opencode\r\n" : "#!/bin/sh\necho fake opencode\n");
      await chmod(fakeHermes, 0o755).catch(() => undefined);
      await chmod(fakeOpenCode, 0o755).catch(() => undefined);
      process.env.HERMES_COMMAND = fakeHermes;
      process.env.OPENCODE_COMMAND = fakeOpenCode;
      const request = (routePath, { method = "GET", body = {}, capabilityToken = "" } = {}) =>
        invokeBridgeRouteForSelfTest({ method, routePath, body, capabilityToken });
      const initial = await request("/addons/execution-settings");
      const denied = await request("/addons/execution-settings", {
        method: "POST",
        body: { addon: "hermes", localCliExecution: true },
      });
      const hermesEnabled = await request("/addons/execution-settings", {
        method: "POST",
        capabilityToken: bridgeCapabilityTokens["addon-execution-settings-write"],
        body: { addon: "hermes", localCliExecution: true },
      });
      const opencodeEnabled = await request("/addons/execution-settings", {
        method: "POST",
        capabilityToken: bridgeCapabilityTokens["addon-execution-settings-write"],
        body: { addon: "opencode", localCliExecution: true },
      });
      const after = await request("/addons/execution-settings");
      const hermesStatus = await request("/hermes/status", {
        method: "POST",
        body: {},
        capabilityToken: bridgeCapabilityTokens["addon-runtime-read"],
      });
      const opencodeStatus = await request("/opencode/status");
      const addons = await request("/addons/status");
      const ok = (
        initial.status === 200 &&
        initial.payload.settings.hermes.localCliExecution === false &&
        initial.payload.settings.opencode.localCliExecution === false &&
        denied.status === 403 &&
        hermesEnabled.payload.status === "enabled" &&
        opencodeEnabled.payload.status === "enabled" &&
        after.payload.settings.hermes.localCliExecution === true &&
        after.payload.settings.opencode.localCliExecution === true &&
        hermesStatus.payload.executionEnabled === true &&
        hermesStatus.payload.mode === "local-hermes-cli" &&
        opencodeStatus.payload.executionEnabled === true &&
        opencodeStatus.payload.mode === "local-opencode-cli" &&
        addons.payload.addons.some((addon) => addon.id === "addon.hermes" && addon.available === true && addon.execution?.localCliExecution === true && addon.execution?.runtimeAvailable === true) &&
        addons.payload.addons.some((addon) => addon.id === "addon.opencode" && addon.execution?.localCliExecution === true)
      );
      console.log(JSON.stringify({
        ok,
        mode: "in-process",
        deniedStatus: denied.status,
        enabled: after.payload.settings.hermes.localCliExecution === true && after.payload.settings.opencode.localCliExecution === true,
        hermesMode: hermesStatus.payload.mode,
        opencodeMode: opencodeStatus.payload.mode,
        settings: after.payload.settings,
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousHermesCommand === undefined) {
        delete process.env.HERMES_COMMAND;
      } else {
        process.env.HERMES_COMMAND = previousHermesCommand;
      }
      if (previousOpenCodeCommand === undefined) {
        delete process.env.OPENCODE_COMMAND;
      } else {
        process.env.OPENCODE_COMMAND = previousOpenCodeCommand;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("memory-source-move-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-move-bridge-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    const source = path.join(tempRoot, "Human Vault");
    const staleSource = path.join(tempRoot, "Changing Vault");
    const partialRollbackSource = path.join(tempRoot, "Partial Rollback Vault");
    const bridgeCapabilityToken = bridgeCapabilityTokens["memory-source-move"];
    const settingsCapabilityToken = bridgeCapabilityTokens["memory-settings-write"];
    let server = null;
    let exitCode = 1;
    try {
      await mkdir(path.join(source, ".obsidian"), { recursive: true });
      await writeFile(path.join(source, "note.md"), "# Human note\n");
      await writeFile(path.join(source, ".obsidian", "app.json"), "{}\n");
      await mkdir(staleSource, { recursive: true });
      await writeFile(path.join(staleSource, "first.md"), "# First version\n");
      await mkdir(partialRollbackSource, { recursive: true });
      await writeFile(path.join(partialRollbackSource, "partial.md"), "# Partial rollback\n");
      server = await startBridgeServer({
        port: Number(args.get("bridge-port") ?? 0),
        bridgeToken,
        bridgeCapabilityTokens,
        extensionOrigin: resonantExtensionOrigin,
        routes: bridgeRoutes,
      });
      const actualPort = bridgeServerPort(server, Number(args.get("bridge-port") ?? 0));
      const urlFor = (route) => `http://127.0.0.1:${actualPort}${route}`;
      const post = (route, body, capabilityToken = bridgeCapabilityToken) => fetch(urlFor(route), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ResonantOS-Bridge-Token": bridgeToken,
          ...(capabilityToken ? { "X-ResonantOS-Bridge-Capability-Token": capabilityToken } : {}),
        },
        body: JSON.stringify(body),
      });

      const unauthorizedCapability = await post("/memory/source/move-preflight", { path: source }, "");
      const ordinaryMoveSettingsResponse = await post("/memory/settings", {
        source: {
          path: source,
          kind: "obsidian-vault",
          ownership: "human-knowledge",
          importMode: "move-on-import",
        },
      }, settingsCapabilityToken);
      const ordinaryMoveSettings = await ordinaryMoveSettingsResponse.json();
      const stalePreflightResponse = await post("/memory/source/move-preflight", {
        path: staleSource,
        kind: "folder",
        ownership: "mixed-library",
      });
      const stalePreflight = await stalePreflightResponse.json();
      await writeFile(path.join(staleSource, "added-after-preflight.md"), "# Added after preflight\n");
      const staleExecuteResponse = await post("/memory/source/move-execute", {
        path: staleSource,
        kind: "folder",
        ownership: "mixed-library",
        confirmation: stalePreflight.confirmationPhrase,
        preflightFingerprint: stalePreflight.preflightFingerprint,
      });
      const staleExecute = await staleExecuteResponse.json();
      const staleSourcePreserved = existsSync(path.join(staleSource, "first.md")) &&
        existsSync(path.join(staleSource, "added-after-preflight.md"));
      const preflightResponse = await post("/memory/source/move-preflight", {
        path: source,
        kind: "obsidian-vault",
        ownership: "human-knowledge",
      });
      const preflight = await preflightResponse.json();
      const executeResponse = await post("/memory/source/move-execute", {
        path: source,
        kind: "obsidian-vault",
        ownership: "human-knowledge",
        confirmation: preflight.confirmationPhrase,
        preflightFingerprint: preflight.preflightFingerprint,
      });
      const executed = await executeResponse.json();
      const movedNoteExists = existsSync(path.join(executed.destinationRoot ?? "", "note.md"));
      const sourceRemoved = !existsSync(source);
      const rollbackResponse = await post("/memory/source/move-rollback", {
        ledgerPath: executed.ledgerPath,
        confirmation: "ROLLBACK MOVE",
      });
      const rollback = await rollbackResponse.json();
      const partialPreflightResponse = await post("/memory/source/move-preflight", {
        path: partialRollbackSource,
        kind: "folder",
        ownership: "mixed-library",
      });
      const partialPreflight = await partialPreflightResponse.json();
      const partialExecuteResponse = await post("/memory/source/move-execute", {
        path: partialRollbackSource,
        kind: "folder",
        ownership: "mixed-library",
        confirmation: partialPreflight.confirmationPhrase,
        preflightFingerprint: partialPreflight.preflightFingerprint,
      });
      const partialExecuted = await partialExecuteResponse.json();
      await writeFile(path.join(partialExecuted.destinationRoot ?? "", "partial.md"), "# Tampered after move\n");
      const partialRollbackResponse = await post("/memory/source/move-rollback", {
        ledgerPath: partialExecuted.ledgerPath,
        confirmation: "ROLLBACK MOVE",
      });
      const partialRollback = await partialRollbackResponse.json();
      const outsideLedger = path.join(tempRoot, "outside-ledger.jsonl");
      await writeFile(outsideLedger, "");
      const outsideRollbackResponse = await post("/memory/source/move-rollback", {
        ledgerPath: outsideLedger,
        confirmation: "ROLLBACK MOVE",
      });
      const restoredNoteExists = existsSync(path.join(source, "note.md"));
      const settings = JSON.parse(await readFile(memorySettingsPath(), "utf8").catch(() => "{\"sources\":[]}"));
      const ok = unauthorizedCapability.status === 403 &&
        ordinaryMoveSettingsResponse.status === 500 &&
        /audited move preflight and execute flow/i.test(String(ordinaryMoveSettings.error ?? "")) &&
        stalePreflightResponse.ok &&
        stalePreflight.okToMove === true &&
        staleExecuteResponse.status === 500 &&
        staleExecute.ok === false &&
        /source changed after preflight/i.test(String(staleExecute.error ?? "")) &&
        staleSourcePreserved &&
        preflightResponse.ok &&
        preflight.ok &&
        preflight.okToMove === true &&
        preflight.hiddenFiles === 1 &&
        executeResponse.ok &&
        executed.ok &&
        executed.status === "moved" &&
        executed.sourceCleanupStatus === "removed" &&
        movedNoteExists &&
        sourceRemoved &&
        rollbackResponse.ok &&
        rollback.ok &&
        rollback.restoredCount === 2 &&
        partialPreflightResponse.ok &&
        partialPreflight.okToMove === true &&
        partialExecuteResponse.ok &&
        partialExecuted.ok &&
        partialRollbackResponse.ok &&
        partialRollback.ok &&
        partialRollback.restoredCount === 0 &&
        partialRollback.skippedCount === 1 &&
        outsideRollbackResponse.status === 500 &&
        restoredNoteExists &&
        !settings.sources?.some((sourceEntry) => path.resolve(sourceEntry.ledgerPath ?? "") === path.resolve(executed.ledgerPath)) &&
        settings.sources?.some((sourceEntry) => path.resolve(sourceEntry.ledgerPath ?? "") === path.resolve(partialExecuted.ledgerPath));
      console.log(JSON.stringify({
        ok,
        unauthorizedCapabilityStatus: unauthorizedCapability.status,
        ordinaryMoveSettings: {
          status: ordinaryMoveSettingsResponse.status,
          error: ordinaryMoveSettings.error,
        },
        preflight: {
          ok: preflight.ok,
          okToMove: preflight.okToMove,
          fileCount: preflight.fileCount,
          hiddenFiles: preflight.hiddenFiles,
          preflightFingerprint: preflight.preflightFingerprint,
        },
        stalePreflight: {
          ok: stalePreflight.ok,
          status: staleExecuteResponse.status,
          sourcePreserved: staleSourcePreserved,
          error: staleExecute.error,
        },
        execute: {
          ok: executed.ok,
          status: executed.status,
          movedCount: executed.movedCount,
          sourceCleanupStatus: executed.sourceCleanupStatus,
          sourceRemoved,
          movedNoteExists,
        },
        rollback: {
          ok: rollback.ok,
          restoredCount: rollback.restoredCount,
          restoredNoteExists,
          outsideLedgerStatus: outsideRollbackResponse.status,
        },
        partialRollback: {
          ok: partialRollback.ok,
          restoredCount: partialRollback.restoredCount,
          skippedCount: partialRollback.skippedCount,
          sourceStillRegistered: settings.sources?.some((sourceEntry) =>
            path.resolve(sourceEntry.ledgerPath ?? "") === path.resolve(partialExecuted.ledgerPath)
          ) ?? false,
        },
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } finally {
      await new Promise((resolve) => server?.close?.(resolve) ?? resolve());
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("memory-source-file-intake-inprocess-self-test") === "true") {
    const shortTempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
    const tempRoot = await mkdtemp(path.join(shortTempBase, "rfi-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousFixedNow = process.env.RESONANTOS_BROWSER_FIRST_FILE_INTAKE_FIXED_NOW;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    const source = path.join(tempRoot, "Human Vault");
    const syncSource = path.join(tempRoot, "Sync Vault");
    const collisionPrefix = `Source ${"same prefix ".repeat(12)}`;
    const collisionSourceA = path.join(tempRoot, `${collisionPrefix}A`);
    const collisionSourceB = path.join(tempRoot, `${collisionPrefix}B`);
      const settingsCapabilityToken = bridgeCapabilityTokens["memory-settings-write"];
      const fileIntakeCapabilityToken = bridgeCapabilityTokens["memory-source-file-intake"];
      const sourceReviewCapabilityToken = bridgeCapabilityTokens["memory-source-review"];
      const sourceManageCapabilityToken = bridgeCapabilityTokens["memory-source-manage"];
    let exitCode = 1;
    try {
      await mkdir(source, { recursive: true });
      await mkdir(syncSource, { recursive: true });
      await mkdir(collisionSourceA, { recursive: true });
      await mkdir(collisionSourceB, { recursive: true });
      await writeFile(path.join(tempRoot, "outside.md"), "# Outside\n");
      await writeFile(path.join(syncSource, "tracked.md"), "# Tracked\n\nVersion 1.\n");
      await writeFile(path.join(collisionSourceA, "a.md"), "# A\n");
      await writeFile(path.join(collisionSourceB, "b.md"), "# B\n");
      for (let index = 0; index < 205; index += 1) {
        await writeFile(path.join(source, `note-${String(index).padStart(3, "0")}.md`), `# Note ${index}\n\nVersion ${index}.\n`);
      }
      await writeFile(path.join(source, "fail.md"), "# Failing file\n\nThis reservation must roll back.\n");
      const post = (routePath, body, capabilityToken) => invokeBridgeRouteForSelfTest({
        method: "POST",
        routePath,
        body,
        capabilityToken,
      });

      const savedResponse = await post("/memory/settings", {
        source: {
          path: source,
          kind: "folder",
          ownership: "human-knowledge",
          importMode: "copy-on-import",
        },
      }, settingsCapabilityToken);
      const saved = savedResponse.payload;
      const syncSavedResponse = await post("/memory/settings", {
        source: {
          path: syncSource,
          kind: "folder",
          ownership: "human-knowledge",
          importMode: "copy-on-import",
        },
      }, settingsCapabilityToken);
      const syncSaved = syncSavedResponse.payload;
      await post("/memory/settings", {
        source: {
          path: collisionSourceA,
          kind: "folder",
          ownership: "mixed-library",
          importMode: "copy-on-import",
        },
      }, settingsCapabilityToken);
      const collisionSavedResponse = await post("/memory/settings", {
        source: {
          path: collisionSourceB,
          kind: "folder",
          ownership: "mixed-library",
          importMode: "copy-on-import",
        },
      }, settingsCapabilityToken);
      const collisionSources = collisionSavedResponse.payload.settings.sources.filter((entry) =>
        entry.path === collisionSourceA || entry.path === collisionSourceB
      );
      const sourceIdCollisionAvoided = collisionSources.length === 2 &&
        new Set(collisionSources.map((entry) => entry.id)).size === 2;
      const sourceId = syncSaved.settings.sources.find((entry) => entry.path === source)?.id ?? saved.settings.sources[0].id;
      const syncSourceId = syncSaved.settings.sources.find((entry) => entry.path === syncSource)?.id;
      const requestedFiles = [
        "note-000.md",
        "note-000.md",
        "../outside.md",
        ...Array.from({ length: 205 }, (_, index) => `note-${String(index).padStart(3, "0")}.md`),
      ];
      const unauthorizedCapability = await post("/memory/source/file-intake", {
        sourceId,
        files: ["note-000.md"],
      }, "");
      const intakeResponse = await post("/memory/source/file-intake", {
        sourceId,
        files: requestedFiles,
      }, fileIntakeCapabilityToken);
      const intake = intakeResponse.payload;
      const syncFirstIntakeResponse = await post("/memory/source/file-intake", {
        sourceId: syncSourceId,
        files: ["tracked.md"],
      }, fileIntakeCapabilityToken);
      const syncFirstReviewResponse = await post("/memory/source/review", {
        sourceId: syncSourceId,
        limit: 20,
      }, sourceReviewCapabilityToken);
      await writeFile(path.join(syncSource, "tracked.md"), "# Tracked\n\nVersion 2.\n");
      await writeFile(path.join(syncSource, "new.md"), "# New\n\nFresh source.\n");
      const syncSecondReviewResponse = await post("/memory/source/review", {
        sourceId: syncSourceId,
        limit: 20,
      }, sourceReviewCapabilityToken);
      const syncSecondIntakeResponse = await post("/memory/source/file-intake", {
        sourceId: syncSourceId,
        files: ["tracked.md", "new.md"],
      }, fileIntakeCapabilityToken);
      const syncUnchangedIntakeResponse = await post("/memory/source/file-intake", {
        sourceId: syncSourceId,
        files: ["tracked.md"],
      }, fileIntakeCapabilityToken);
      await post("/memory/settings", {
        autoSync: true,
        syncMode: "auto-intake-review",
      }, settingsCapabilityToken);
      await writeFile(path.join(syncSource, "auto.md"), "# Auto\n\nNew auto-sync source.\n");
      const autoSyncResponse = await post("/memory/source/sync", {
        sourceIds: [syncSourceId],
        maxFilesPerSource: 10,
      }, fileIntakeCapabilityToken);
      const autoSyncResult = autoSyncResponse.payload;
      await post("/memory/settings", {
        autoSync: false,
        syncMode: "manual-review",
      }, settingsCapabilityToken);
      await writeFile(path.join(syncSource, "manual.md"), "# Manual\n\nReview-only source.\n");
      const manualSyncResponse = await post("/memory/source/sync", {
        sourceIds: [syncSourceId],
        maxFilesPerSource: 10,
      }, fileIntakeCapabilityToken);
      const manualSyncResult = manualSyncResponse.payload;
      await post("/memory/settings", {
        autoSync: true,
        syncMode: "paused",
      }, settingsCapabilityToken);
      await writeFile(path.join(syncSource, "paused.md"), "# Paused\n\nShould not be scanned.\n");
      const pausedSyncResponse = await post("/memory/source/sync", {
        sourceIds: [syncSourceId],
        maxFilesPerSource: 10,
      }, fileIntakeCapabilityToken);
      const pausedSyncResult = pausedSyncResponse.payload;
      const syncHistory = JSON.parse(await readFile(memorySourceSyncHistoryPath(), "utf8"));
      const syncHistoryEntries = Array.isArray(syncHistory.entries) ? syncHistory.entries : [];
      const syncHistorySerialized = JSON.stringify(syncHistory);
      const syncHistoryRedactsSourcePaths = !syncHistorySerialized.includes(syncSource) &&
        !syncHistorySerialized.includes(tempRoot) &&
        syncHistorySerialized.includes(`[path]/${path.basename(syncSource)}`);
      for (let index = 0; index < 55; index += 1) {
        await post("/memory/source/sync", {
          sourceIds: [syncSourceId],
          maxFilesPerSource: 10,
        }, fileIntakeCapabilityToken);
      }
      const boundedSyncHistory = JSON.parse(await readFile(memorySourceSyncHistoryPath(), "utf8"));
      const boundedSyncHistoryEntries = Array.isArray(boundedSyncHistory.entries) ? boundedSyncHistory.entries : [];
      const syncHistoryBounded = boundedSyncHistoryEntries.length <= 50;

      const fixedNow = "2026-06-01T10:00:00.000Z";
      process.env.RESONANTOS_BROWSER_FIRST_FILE_INTAKE_FIXED_NOW = fixedNow;
      const intakeDir = path.join(memoryRoot(), "INTAKE", "sources", safeFileSlug(path.basename(source) || sourceId));
      const failingArtifact = path.join(
        intakeDir,
        `${fixedNow.replace(/[:.]/g, "-")}-${safeFileSlug("fail.md")}.md`,
      );
      await mkdir(failingArtifact, { recursive: true });
      const failureResponse = await post("/memory/source/file-intake", {
        sourceId,
        files: ["fail.md"],
      }, fileIntakeCapabilityToken);
      const manifest = JSON.parse(await readFile(memorySourceFileManifestPath(), "utf8"));
      const failVersions = Object.values(manifest.files ?? {})
        .filter((entry) => entry?.sourceId === sourceId && entry?.sourceFile === "fail.md");
      const firstSnapshotPath = manifest.files?.[`${sourceId}::note-000.md`]?.latestSnapshotPath ?? "";
      const firstSnapshotContent = firstSnapshotPath
        ? await readFile(path.join(memoryRoot(), firstSnapshotPath), "utf8").catch(() => "")
        : "";
      const syncFirstReview = syncFirstReviewResponse.payload;
      const syncSecondReview = syncSecondReviewResponse.payload;
      const syncSecondIntake = syncSecondIntakeResponse.payload;
      const syncFirstTracked = syncFirstReview.candidates?.find((candidate) => candidate.path === "tracked.md");
      const syncChangedTracked = syncSecondReview.candidates?.find((candidate) => candidate.path === "tracked.md");
      const syncNewFile = syncSecondReview.candidates?.find((candidate) => candidate.path === "new.md");
      const syncManifest = JSON.parse(await readFile(memorySourceFileManifestPath(), "utf8"));
      const syncTrackedEntry = syncManifest.files?.[`${syncSourceId}::tracked.md`];
      const syncNewEntry = syncManifest.files?.[`${syncSourceId}::new.md`];
      const syncFlowOk = syncSavedResponse.status === 200 &&
        syncFirstIntakeResponse.status === 200 &&
        syncFirstIntakeResponse.payload.created?.length === 1 &&
        syncFirstReviewResponse.status === 200 &&
        syncFirstTracked?.versionStatus === "unchanged" &&
        syncFirstTracked?.sourceVersion === 1 &&
        syncSecondReviewResponse.status === 200 &&
        syncChangedTracked?.versionStatus === "changed" &&
        syncChangedTracked?.sourceVersion === 1 &&
        syncNewFile?.versionStatus === "new" &&
        syncSecondIntakeResponse.status === 200 &&
        syncSecondIntake.created?.length === 2 &&
        syncTrackedEntry?.latestVersion === 2 &&
        syncNewEntry?.latestVersion === 1 &&
        syncUnchangedIntakeResponse.status === 500 &&
        /unchanged since imported version 2/.test(syncUnchangedIntakeResponse.payload.error ?? "") &&
        autoSyncResponse.status === 200 &&
        autoSyncResult.autoIntake === true &&
        autoSyncResult.reviewedSources === 1 &&
        autoSyncResult.createdArtifacts === 1 &&
        autoSyncResult.reviewRequests === 1 &&
        autoSyncResult.sources?.[0]?.eligibleFiles === 1 &&
        manualSyncResponse.status === 200 &&
        manualSyncResult.autoIntake === false &&
        manualSyncResult.reviewedSources === 1 &&
        manualSyncResult.eligibleFiles === 1 &&
        manualSyncResult.createdArtifacts === 0 &&
        manualSyncResult.reviewRequests === 0 &&
        pausedSyncResponse.status === 200 &&
        pausedSyncResult.status === "paused" &&
        pausedSyncResult.reviewedSources === 0 &&
        pausedSyncResult.createdArtifacts === 0 &&
        syncHistoryEntries.length >= 3 &&
        syncHistoryEntries[0]?.status === "paused" &&
        syncHistoryEntries[1]?.status === "review-only" &&
        syncHistoryEntries[2]?.status === "intake-created" &&
        syncHistoryRedactsSourcePaths &&
        syncHistoryBounded;
      await writeFile(memorySourceFileManifestPath(), "{not-json\n", { mode: 0o600 });
      const corruptReviewResponse = await post("/memory/source/review", {
        sourceId,
        limit: 20,
      }, sourceReviewCapabilityToken);
      const corruptBlockedCandidate = corruptReviewResponse.payload.candidates?.find((candidate) => candidate.path === "note-000.md");
      const unauthorizedRepairResponse = await post("/memory/source/versions/repair", {
        sourceId,
        confirmation: "REPAIR SOURCE VERSIONS",
      }, "");
      const missingConfirmationRepairResponse = await post("/memory/source/versions/repair", {
        sourceId,
        confirmation: "repair",
      }, sourceManageCapabilityToken);
      const repairResponse = await post("/memory/source/versions/repair", {
        sourceId,
        confirmation: "REPAIR SOURCE VERSIONS",
      }, sourceManageCapabilityToken);
      const repairedReviewResponse = await post("/memory/source/review", {
        sourceId,
        limit: 20,
      }, sourceReviewCapabilityToken);
      const repairedCandidate = repairedReviewResponse.payload.candidates?.find((candidate) => candidate.path === "note-000.md");
      const repairHistoryEntries = await readMemorySourceRepairHistory(5);
      const repairHistorySerialized = JSON.stringify(repairHistoryEntries);
      const repairHistoryRedactsSourcePaths = !repairHistorySerialized.includes(source) &&
        !repairHistorySerialized.includes(tempRoot) &&
        repairHistorySerialized.includes(`[path]/${path.basename(source)}`);
      const repairFlowOk = corruptReviewResponse.status === 200 &&
        corruptReviewResponse.payload.versionManifestError &&
        corruptBlockedCandidate?.versionStatus === "version-manifest-unavailable" &&
        unauthorizedRepairResponse.status === 403 &&
        missingConfirmationRepairResponse.status === 500 &&
        repairResponse.status === 200 &&
        repairResponse.payload.status === "repaired" &&
        /^CONFIG\/source-file-history\/repairs\//.test(repairResponse.payload.backupPath ?? "") &&
        repairHistoryEntries[0]?.status === "repaired" &&
        repairHistoryEntries[0]?.sourceId === sourceId &&
        /^CONFIG\/source-file-history\/repairs\//.test(repairHistoryEntries[0]?.backupPath ?? "") &&
        repairHistoryRedactsSourcePaths &&
        repairedReviewResponse.status === 200 &&
        !repairedReviewResponse.payload.versionManifestError &&
        repairedCandidate?.versionStatus === "new";
      const intakeRejected = Array.isArray(intake.rejected) ? intake.rejected : [];
      const duplicateRejected = intakeRejected.some((entry) =>
        entry.sourceFile === "note-000.md" && /duplicate/.test(entry.reason)
      );
      const escapeRejected = intakeRejected.some((entry) =>
        entry.sourceFile === "../outside.md" && /must stay inside|outside source root|parent traversal|escapes/i.test(entry.reason)
      );
      const overflowRejected = intakeRejected.filter((entry) => /batch limit/.test(entry.reason)).length;
      const intakeCreated = Array.isArray(intake.created) ? intake.created : [];
      const ok = savedResponse.status === 200 &&
        unauthorizedCapability.status === 403 &&
        intakeResponse.status === 200 &&
        intakeCreated.length === 200 &&
        firstSnapshotPath.startsWith("CONFIG/source-file-history/blobs/") &&
        firstSnapshotContent.includes("# Note 0") &&
        duplicateRejected &&
        escapeRejected &&
        overflowRejected === 5 &&
        failureResponse.status === 500 &&
        /No selected source files could be imported/.test(failureResponse.payload.error ?? "") &&
        failVersions.length === 0 &&
        syncFlowOk &&
        repairFlowOk &&
        sourceIdCollisionAvoided;
      console.log(JSON.stringify({
        ok,
        mode: "in-process",
        unauthorizedCapabilityStatus: unauthorizedCapability.status,
        createdCount: intakeCreated.length,
        rejectedCount: intakeRejected.length,
        intakeStatus: intakeResponse.status,
        intakeError: intake.error ?? "",
        snapshotRecorded: firstSnapshotPath.startsWith("CONFIG/source-file-history/blobs/"),
        duplicateRejected,
        escapeRejected,
        overflowRejected,
        failureStatus: failureResponse.status,
        rollbackReservedVersions: failVersions.length,
        syncFirstStatus: syncFirstTracked?.versionStatus ?? "",
        syncChangedStatus: syncChangedTracked?.versionStatus ?? "",
        syncNewStatus: syncNewFile?.versionStatus ?? "",
        syncChangedVersion: syncTrackedEntry?.latestVersion ?? 0,
        syncNewVersion: syncNewEntry?.latestVersion ?? 0,
        syncUnchangedStatus: syncUnchangedIntakeResponse.status,
        autoSyncStatus: autoSyncResponse.status,
        autoSyncCreatedArtifacts: autoSyncResult.createdArtifacts ?? 0,
        autoSyncReviewRequests: autoSyncResult.reviewRequests ?? 0,
        manualSyncCreatedArtifacts: manualSyncResult.createdArtifacts ?? -1,
        manualSyncEligibleFiles: manualSyncResult.eligibleFiles ?? 0,
        pausedSyncStatus: pausedSyncResult.status ?? "",
        pausedSyncReviewedSources: pausedSyncResult.reviewedSources ?? -1,
        syncHistoryCount: syncHistoryEntries.length,
        syncHistoryLatestStatus: syncHistoryEntries[0]?.status ?? "",
        syncHistoryPreviousStatus: syncHistoryEntries[1]?.status ?? "",
        syncHistoryRedactsSourcePaths,
        syncHistoryBounded,
        boundedSyncHistoryCount: boundedSyncHistoryEntries.length,
        syncHistoryEligibleFileSample: syncHistoryEntries[1]?.sources?.[0]?.eligibleFileSamples?.[0] ?? "",
        syncHistoryCreatedArtifactSample: syncHistoryEntries[2]?.sources?.[0]?.createdArtifactSamples?.[0]?.path ?? "",
        syncHistorySourcePathSample: syncHistoryEntries[2]?.sources?.[0]?.path ?? "",
        corruptReviewStatus: corruptReviewResponse.status,
        corruptCandidateStatus: corruptBlockedCandidate?.versionStatus ?? "",
        unauthorizedRepairStatus: unauthorizedRepairResponse.status,
        missingConfirmationRepairStatus: missingConfirmationRepairResponse.status,
        repairStatus: repairResponse.status,
        repairPayloadStatus: repairResponse.payload.status ?? "",
        repairBackupPath: repairResponse.payload.backupPath ?? "",
        repairHistoryCount: repairHistoryEntries.length,
        repairHistoryLatestStatus: repairHistoryEntries[0]?.status ?? "",
        repairHistorySourcePathSample: repairHistoryEntries[0]?.sourcePath ?? "",
        repairHistoryBackupPath: repairHistoryEntries[0]?.backupPath ?? "",
        repairHistoryRedactsSourcePaths,
        repairedCandidateStatus: repairedCandidate?.versionStatus ?? "",
        sourceIdCollisionAvoided,
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } finally {
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousFixedNow === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_FILE_INTAKE_FIXED_NOW;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_FILE_INTAKE_FIXED_NOW = previousFixedNow;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }

  if (args.get("memory-source-file-intake-self-test") === "true") {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-file-intake-bridge-"));
    const previousUserRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
    const previousFixedNow = process.env.RESONANTOS_BROWSER_FIRST_FILE_INTAKE_FIXED_NOW;
    process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = path.join(tempRoot, "ResonantOS_User");
    const source = path.join(tempRoot, "Human Vault");
    const settingsCapabilityToken = bridgeCapabilityTokens["memory-settings-write"];
    const fileIntakeCapabilityToken = bridgeCapabilityTokens["memory-source-file-intake"];
    let server = null;
    let exitCode = 1;
    try {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(tempRoot, "outside.md"), "# Outside\n");
      for (let index = 0; index < 205; index += 1) {
        await writeFile(path.join(source, `note-${String(index).padStart(3, "0")}.md`), `# Note ${index}\n\nVersion ${index}.\n`);
      }
      await writeFile(path.join(source, "fail.md"), "# Failing file\n\nThis reservation must roll back.\n");
      server = await startBridgeServer({
        port: Number(args.get("bridge-port") ?? 0),
        bridgeToken,
        bridgeCapabilityTokens,
        extensionOrigin: resonantExtensionOrigin,
        routes: bridgeRoutes,
      });
      const actualPort = bridgeServerPort(server, Number(args.get("bridge-port") ?? 0));
      const post = (route, body, capabilityToken) => fetch(`http://127.0.0.1:${actualPort}${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": resonantExtensionOrigin,
          "X-ResonantOS-Bridge-Token": bridgeToken,
          ...(capabilityToken ? { "X-ResonantOS-Bridge-Capability-Token": capabilityToken } : {}),
        },
        body: JSON.stringify(body),
      });

      const savedResponse = await post("/memory/settings", {
        source: {
          path: source,
          kind: "folder",
          ownership: "human-knowledge",
          importMode: "copy-on-import",
        },
      }, settingsCapabilityToken);
      const saved = await savedResponse.json();
      const sourceId = saved.settings.sources[0].id;
      const requestedFiles = [
        "note-000.md",
        "note-000.md",
        "../outside.md",
        ...Array.from({ length: 205 }, (_, index) => `note-${String(index).padStart(3, "0")}.md`),
      ];
      const unauthorizedCapability = await post("/memory/source/file-intake", {
        sourceId,
        files: ["note-000.md"],
      }, "");
      const intakeResponse = await post("/memory/source/file-intake", {
        sourceId,
        files: requestedFiles,
      }, fileIntakeCapabilityToken);
      const intake = await intakeResponse.json();

      const fixedNow = "2026-06-01T10:00:00.000Z";
      process.env.RESONANTOS_BROWSER_FIRST_FILE_INTAKE_FIXED_NOW = fixedNow;
      const intakeDir = path.join(memoryRoot(), "INTAKE", "sources", safeFileSlug(path.basename(source) || sourceId));
      const failingArtifact = path.join(
        intakeDir,
        `${fixedNow.replace(/[:.]/g, "-")}-${safeFileSlug("fail.md")}.md`,
      );
      await mkdir(failingArtifact, { recursive: true });
      const failureResponse = await post("/memory/source/file-intake", {
        sourceId,
        files: ["fail.md"],
      }, fileIntakeCapabilityToken);
      const failure = await failureResponse.json();
      const manifest = JSON.parse(await readFile(memorySourceFileManifestPath(), "utf8"));
      const failVersions = Object.values(manifest.files ?? {})
        .filter((entry) => entry?.sourceId === sourceId && entry?.sourceFile === "fail.md");
      const firstSnapshotPath = manifest.files?.[`${sourceId}::note-000.md`]?.latestSnapshotPath ?? "";
      const firstSnapshotContent = firstSnapshotPath
        ? await readFile(path.join(memoryRoot(), firstSnapshotPath), "utf8").catch(() => "")
        : "";
      const ok = savedResponse.ok &&
        unauthorizedCapability.status === 403 &&
        intakeResponse.ok &&
        intake.created.length === 200 &&
        firstSnapshotPath.startsWith("CONFIG/source-file-history/blobs/") &&
        firstSnapshotContent.includes("# Note 0") &&
        intake.rejected.some((entry) => entry.sourceFile === "note-000.md" && /duplicate/.test(entry.reason)) &&
        intake.rejected.some((entry) => entry.sourceFile === "../outside.md" && /must stay inside|outside source root|parent traversal|escapes/i.test(entry.reason)) &&
        intake.rejected.filter((entry) => /batch limit/.test(entry.reason)).length === 5 &&
        failureResponse.status === 500 &&
        /No selected source files could be imported/.test(failure.error ?? "") &&
        failVersions.length === 0;
      console.log(JSON.stringify({
        ok,
        unauthorizedCapabilityStatus: unauthorizedCapability.status,
        createdCount: intake.created.length,
        rejectedCount: intake.rejected.length,
        snapshotRecorded: firstSnapshotPath.startsWith("CONFIG/source-file-history/blobs/"),
        duplicateRejected: intake.rejected.some((entry) => entry.sourceFile === "note-000.md" && /duplicate/.test(entry.reason)),
        escapeRejected: intake.rejected.some((entry) => entry.sourceFile === "../outside.md" && /must stay inside|outside source root|parent traversal|escapes/i.test(entry.reason)),
        overflowRejected: intake.rejected.filter((entry) => /batch limit/.test(entry.reason)).length,
        failureStatus: failureResponse.status,
        rollbackReservedVersions: failVersions.length,
      }, null, 2));
      exitCode = ok ? 0 : 1;
    } finally {
      await new Promise((resolve) => server?.close?.(resolve) ?? resolve());
      if (previousUserRoot === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT = previousUserRoot;
      }
      if (previousFixedNow === undefined) {
        delete process.env.RESONANTOS_BROWSER_FIRST_FILE_INTAKE_FIXED_NOW;
      } else {
        process.env.RESONANTOS_BROWSER_FIRST_FILE_INTAKE_FIXED_NOW = previousFixedNow;
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    process.exit(exitCode);
  }


  return false;
}
