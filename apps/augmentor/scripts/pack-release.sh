#!/bin/sh

# Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
# Copyright © 2026 Manolo Remiddi
# SPDX-License-Identifier: MIT
# License: MIT — see LICENSE at the repository root.

# Packs the user-facing release bundle (the GitHub Release asset) and
# extracts the release notes for the same version.
#
# usage: scripts/pack-release.sh <version> [out.zip] [repo-root]
#   version     the release version, X.Y.Z (no leading v)
#   out.zip     defaults to <repo-root>/dist/augmentor-<version>-dist.zip
#   repo-root   defaults to this script's parent directory
#
# Checks (all must pass, in order):
#   1. version format X.Y.Z
#   2. three-way lockstep: version == plugin/package.json == extension/manifest.json
#   3. CHANGELOG.md carries a non-empty "## <version>" section
#   4. plugin/dist/index.js exists (the tracked built artifact — run
#      `npm run prepare` in plugin/ if it is missing or stale)
#
# The bundle is an ALLOWLIST copy (extension/, pipe, installer, presets,
# package files, plugin/ minus node_modules, docs) — never a denylist, so an
# accidental local file can never ride into the asset. A staged tree that
# contains node_modules or a .env fails the pack.
#
# Outputs:
#   <out.zip>                                  the release asset
#   <repo-root>/dist/augmentor-<version>-notes.md   the CHANGELOG section

set -eu

VER="${1:-}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="${3:-$(dirname -- "$SCRIPT_DIR")}"

[ -n "$VER" ] || { echo "usage: pack-release.sh <version> [out.zip] [repo-root]" >&2; exit 2; }
[ -d "$ROOT" ] || { echo "pack: repo root not found: $ROOT" >&2; exit 2; }
OUT="${2:-$ROOT/dist/augmentor-$VER-dist.zip}"
case "$OUT" in
  /*) : ;;
  *) OUT="$PWD/$OUT" ;;
esac
NOTES="$ROOT/dist/augmentor-$VER-notes.md"

fail() { echo "pack: ERROR: $*" >&2; exit 1; }

# 1. version format
printf '%s' "$VER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "version must be X.Y.Z, got: $VER"

# 2. three-way lockstep (tag/version <-> plugin <-> extension)
PKG_VER=$(node -p "require('$ROOT/plugin/package.json').version" 2>/dev/null) \
  || fail "plugin/package.json missing or unreadable"
MAN_VER=$(node -p "require('$ROOT/extension/manifest.json').version" 2>/dev/null) \
  || fail "extension/manifest.json missing or unreadable"
[ "$PKG_VER" = "$VER" ] || fail "lockstep broken: version $VER but plugin/package.json is $PKG_VER"
[ "$MAN_VER" = "$VER" ] || fail "lockstep broken: version $VER but extension/manifest.json is $MAN_VER"
echo "pack: lockstep ok — plugin=$PKG_VER extension=$MAN_VER"

# 3. CHANGELOG section
awk -v ver="$VER" '
  BEGIN { v = ver; gsub(/\./, "\\.", v); re = "^## " v "($| )" }
  /^## / && !found { if ($0 ~ re) { found = 1; next } next }
  /^## / && found { exit }
  found { print }
' "$ROOT/CHANGELOG.md" > "$ROOT/.pack-notes.tmp"
[ -s "$ROOT/.pack-notes.tmp" ] \
  || fail "CHANGELOG.md has no non-empty section for version $VER — add it before tagging"
mkdir -p "$ROOT/dist"
mv "$ROOT/.pack-notes.tmp" "$NOTES"
echo "pack: notes ok — $NOTES"

# 4. built plugin artifact
[ -f "$ROOT/plugin/dist/index.js" ] \
  || fail "plugin/dist/index.js missing — cd plugin && npm run prepare, then commit the rebuilt artifact"

# 5. stage the allowlist
for f in extension shared pipe.mjs wire.mjs install-native-host.sh presets \
         package.json pnpm-lock.yaml plugin README.md LICENSE CHANGELOG.md .env.example; do
  [ -e "$ROOT/$f" ] || fail "allowlist entry missing from repo: $f"
done
rm -f "$OUT"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/augmentor-$VER"
for f in extension shared pipe.mjs wire.mjs install-native-host.sh presets \
         package.json pnpm-lock.yaml plugin README.md LICENSE CHANGELOG.md .env.example; do
  cp -R "$ROOT/$f" "$STAGE/augmentor-$VER/"
done
# defensive: no dependency trees, no secret files may ride into the asset
rm -rf "$STAGE/augmentor-$VER/plugin/node_modules"
if find "$STAGE" \( -name node_modules -o -name .env \) | grep -q .; then
  find "$STAGE" \( -name node_modules -o -name .env \) -print >&2
  fail "staged tree contains node_modules or .env"
fi

# 6. zip
mkdir -p "$(dirname -- "$OUT")"
( cd "$STAGE" && zip -r9 -q "$OUT" "augmentor-$VER" )
[ -s "$OUT" ] || fail "zip came out empty: $OUT"
COUNT=$(unzip -l "$OUT" | tail -n1 | awk '{print $2}')
echo "pack: asset ok — $OUT ($COUNT entries)"
echo "pack: done"
