#!/bin/sh

# Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
# Copyright © 2026 Manolo Remiddi
# SPDX-License-Identifier: MIT
# License: MIT — see LICENSE at the repository root.

# Installs the Chromium native messaging host manifest for the Augmentor pipe.
#
# usage: ./install-native-host.sh <extension-id> [config-dir]
#   extension-id  from chrome://extensions (unpacked, developer mode)
#   config-dir    defaults to ~/.config/chromium
#
# The manifest must be readable by the browser user and the `node` binary
# must be resolvable (launch Chromium from a terminal where `node` works,
# or set NODE in this script).
set -eu

EXT_ID="${1:?usage: $0 <extension-id> [config-dir]}"
CONFIG_DIR="${2:-$HOME/.config/chromium}"
HOST_NAME="com.deepseek.dsh.augmentor"
NODE_BIN="${NODE:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH; set NODE=/abs/path/to/node and re-run" >&2
  exit 1
fi

AUGMENTOR_DIR="$(cd "$(dirname "$0")" && pwd)"
# The host is the /api pipe (pipe.mjs) — the browser talks to DSH over a
# loopback /api relay, no sidecar bridge.
HOST_SH="$AUGMENTOR_DIR/bin/pipe-host.sh"
mkdir -p "$AUGMENTOR_DIR/bin"
cat > "$HOST_SH" <<EOF
#!/bin/sh
# Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
# Copyright © 2026 Manolo Remiddi
# SPDX-License-Identifier: MIT
# License: MIT — see LICENSE at the repository root.
exec "$NODE_BIN" "$AUGMENTOR_DIR/pipe.mjs"
EOF
chmod +x "$HOST_SH"

# Fresh clones have no node_modules anywhere, and both runtime entry
# points need packages resolved:
#   - pipe.mjs (root) imports ws from <repo>/node_modules
#   - the plugin's dist bundle imports ws / @deepseek-ai/dsh-tools /
#     @deepseek-ai/schemastery (local-dir mount: <repo>/plugin/node_modules)
# The npm path (dsh plugin add dsh-augmentor) installs its own deps and
# only needs the root install for the pipe. The installer runs inside the
# clone, so it makes the first pipe boot deterministic here instead of
# asking the user for an extra install step.
# Reconcile on upgrades too: an existing node_modules may still contain the
# old DSH tools SDK. Node/npm is sufficient when pnpm is not installed.
if command -v pnpm >/dev/null 2>&1; then
  (cd "$AUGMENTOR_DIR" && pnpm install --frozen-lockfile --ignore-scripts)
  (cd "$AUGMENTOR_DIR/plugin" && pnpm install --frozen-lockfile --ignore-scripts)
else
  (cd "$AUGMENTOR_DIR" && npm install --ignore-scripts)
  (cd "$AUGMENTOR_DIR/plugin" && npm install --ignore-scripts)
fi

# Per-machine action-channel secret (drives the user's browser). The plugin
# and the pipe both read this file; creating it at install time makes the
# first pipe boot deterministic. 0600: same user only.
# S15 (audit): atomic O_EXCL creation (same trick as the plugin and the
# pipe) — if a concurrent first boot already won, that is not an error.
DSH_DATA_DIR="${DSH_HOME:-$HOME/.dsh}"
TOKEN_FILE="$DSH_DATA_DIR/augmentor-ws-token"
mkdir -p "$DSH_DATA_DIR"
"$NODE_BIN" -e '
  const fs = require("node:fs"), c = require("node:crypto")
  try {
    const fd = fs.openSync(process.argv[1], "wx", 0o600)
    fs.writeSync(fd, c.randomBytes(16).toString("hex") + "\n")
    fs.closeSync(fd)
    process.stdout.write("created " + process.argv[1] + "\n")
  } catch (e) {
    if (e.code !== "EEXIST") { console.error("token file: " + e.message); process.exit(1) }
  }
' "$TOKEN_FILE"

# Install the shipped persona for fresh users, preserving any customized
# existing preset. DSH discovers user presets from its own data directory.
"$NODE_BIN" -e '
  const fs = require("node:fs"), path = require("node:path")
  const dest = path.join(process.argv[2], ".agent-presets", "augmentor")
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(process.argv[1], dest, { recursive: true, errorOnExist: true, force: false })
    console.log("installed Augmentor agent preset")
  } else {
    const file = path.join(dest, "agent.cordis.yml")
    if (fs.existsSync(file)) {
      const original = fs.readFileSync(file, "utf8")
      // Rename only the legacy persona key, preserving the prompt and all
      // customized entries. Retain an exclusive backup before migration.
      const migrated = original.replace(/(name: .?@deepseek-ai\/dsh-persona.?\r?\n[ \t]+config:\r?\n[ \t]+)text:/, "$1prefix:")
      if (migrated !== original) {
        fs.writeFileSync(file + ".pre-0.1.32.bak", original, { flag: "wx" })
        fs.writeFileSync(file, migrated)
        console.log("migrated persona text to prefix; backup retained")
      }
    }
  }
' "$AUGMENTOR_DIR/presets/augmentor" "$DSH_DATA_DIR"

# D5 (audit): M1 <-> M4 mount conflict guard.
#   M1 mounted the plugin entry directly from source in the DSH home patch
#   file:  - insert: / - id: dsh-augmentor / name: '<abs path>?src=<commit>'
#   M4 (dsh plugin add) mounts the package by bare name:
#                - insert: / - id: dsh-augmentor / name: 'dsh-augmentor'
# Both can coexist in the SAME file (separate list items, same id). When
# that happens the source mount is stale: the package in the profile's
# node_modules is what the plugin reconcile keeps. Drop the M1 block (its
# comment header included), keep a .bak, and warn. Only when the file holds
# exactly one ?src= mount AND at least one bare-name mount — otherwise
# leave the file untouched (no guessing).
DSH_PATCH="${DSH_PATCH:-$DSH_DATA_DIR/cordis.patch.yml}"
if [ -f "$DSH_PATCH" ]; then
  RANGE="$(awk '
    { L[NR] = $0 }
    END {
      n = NR
      # Top-level entries start at column-0 "- " lines; the comment/blank
      # run directly above each start belongs to that entry.
      m = 0
      for (i = 1; i <= n; i++) if (L[i] ~ /^- /) { m++; S[m] = i }
      for (k = 1; k <= m; k++) {
        t = S[k]
        while (t > 1 && (L[t-1] ~ /^#/ || L[t-1] ~ /^[[:space:]]*$/)) t--
        TS[k] = t
      }
      # second pass: TE depends on the NEXT entry TS (not computed yet
      # inside the loop above)
      for (k = 1; k <= m; k++) TE[k] = (k < m ? TS[k+1] - 1 : n)
      m1 = 0; m4 = 0; m1k = 0
      for (k = 1; k <= m; k++) {
        inb = 0; src = 0
        for (i = TS[k]; i <= TE[k]; i++) {
          if (L[i] ~ /id:[[:space:]]*dsh-augmentor[[:space:]]*$/) inb = 1
          if (inb && L[i] ~ /\?src=/) src = 1
        }
        if (!inb) continue
        if (src) { m1++; m1k = k } else m4++
      }
      if (m1 == 1 && m4 >= 1) print TS[m1k], TE[m1k]
    }
  ' "$DSH_PATCH")"
  if [ -n "$RANGE" ]; then
    set -- $RANGE
    cp "$DSH_PATCH" "$DSH_PATCH.bak"
    awk -v s="$1" -v e="$2" 'NR >= s && NR <= e { next } { print }' "$DSH_PATCH" > "$DSH_PATCH.tmp"
    mv "$DSH_PATCH.tmp" "$DSH_PATCH"
    echo "warn: dropped the stale M1 source mount (?src=) for dsh-augmentor from $DSH_PATCH (lines $1-$2); the M4 package mount wins. Backup: $DSH_PATCH.bak" >&2
  fi
fi

mkdir -p "$CONFIG_DIR/NativeMessagingHosts"
OUT="$CONFIG_DIR/NativeMessagingHosts/$HOST_NAME.json"
cat > "$OUT" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Augmentor pipe (powered by DSH)",
  "path": "$HOST_SH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "wrote $OUT"
echo "pipe: $HOST_SH"
echo "note: relaunch Chromium (or reload the extension) so the host manifest is picked up."
