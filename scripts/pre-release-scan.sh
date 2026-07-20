#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ZIP_PATH="${1:-resonantos-side-panel-extension.zip}"
EXTENSION_DIR="browser-first/resonantos-side-panel-extension"
DIST_DIR="dist"
SECRET_PATTERN='(^|[^[:alnum:]_-])(sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|rpa_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xai-[A-Za-z0-9_-]{16,})'
FOUNDER_PATH_PATTERN='(/Users/(dr\.tom|tom|thomas|vladimir)\b|/home/(dr\.tom|tom|thomas|vladimir)\b|/Volumes/|C:\\Users\\(dr\.tom|tom|thomas|vladimir)\b)'
ADDON_DEFAULT_PATTERN='"(installed|enabled|trusted)"[[:space:]]*:[[:space:]]*true'

declare -a SCAN_TARGETS=()
declare -a FAILURES=()
TMP_DIR=""

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

add_failure() {
  FAILURES+=("$1")
}

add_scan_target() {
  local path="$1"
  local label="$2"
  if [[ -e "$path" ]]; then
    SCAN_TARGETS+=("$label::$path")
  fi
}

scan_files() {
  local path="$1"
  shift
  find "$path" -type f "$@" \
    ! -path "*/node_modules/*" \
    ! -path "*/.git/*" \
    ! -name ".DS_Store" \
    ! -name "bridge-config.generated.js" \
    -print
}

scan_pattern() {
  local label="$1"
  local path="$2"
  local pattern="$3"
  local description="$4"
  shift 4
  local -a matches=()
  while IFS= read -r file; do
    while IFS= read -r match; do
      matches+=("${file}:${match}")
    done < <(grep -EnI "$pattern" "$file" 2>/dev/null || true)
  done < <(scan_files "$path" "$@")
  if (( ${#matches[@]} > 0 )); then
    add_failure "$description in $label:"
    for match in "${matches[@]:0:20}"; do
      add_failure "  $match"
    done
    if (( ${#matches[@]} > 20 )); then
      add_failure "  ... ${#matches[@]} total matches"
    fi
  fi
}

if [[ -f "$ZIP_PATH" ]]; then
  if ! command -v unzip >/dev/null 2>&1; then
    add_failure "unzip is required to inspect $ZIP_PATH"
  else
    TMP_DIR="$(mktemp -d)"
    unzip -qq "$ZIP_PATH" -d "$TMP_DIR/extension"
    add_scan_target "$TMP_DIR/extension" "packaged-extension"

    declare -a forbidden_zip_entries=()
    while IFS= read -r entry; do
      forbidden_zip_entries+=("$entry")
    done < <(unzip -Z1 "$ZIP_PATH" | grep -E '(^|/)(bridge-config\.generated\.js|\.env|ResonantOS_User|Runtime|ProviderFabric|Delegations)(/|$)' || true)
    if (( ${#forbidden_zip_entries[@]} > 0 )); then
      add_failure "Forbidden local runtime/generated files were bundled in $ZIP_PATH:"
      for entry in "${forbidden_zip_entries[@]}"; do
        add_failure "  $entry"
      done
    fi
  fi
else
  add_scan_target "$EXTENSION_DIR" "extension-source-fallback"
fi

add_scan_target "$DIST_DIR" "vite-dist"

if (( ${#SCAN_TARGETS[@]} == 0 )); then
  add_failure "No distributable artifacts found. Run npm run build and package the extension before pre-release scanning."
fi

for target in "${SCAN_TARGETS[@]}"; do
  label="${target%%::*}"
  path="${target#*::}"
  scan_pattern "$label" "$path" "$SECRET_PATTERN" "Provider-key-like credential pattern" \( -name "*.js" -o -name "*.mjs" -o -name "*.json" -o -name "*.html" -o -name "*.css" \)
  scan_pattern "$label" "$path" "$FOUNDER_PATH_PATTERN" "Founder/local filesystem path" \( -name "*.js" -o -name "*.mjs" \)
  scan_pattern "$label" "$path" "$ADDON_DEFAULT_PATTERN" "Bundled add-on appears installed/enabled by default" \( -name "*.json" \)
done

if (( ${#FAILURES[@]} > 0 )); then
  echo "FAIL: pre-release scan found release-blocking findings."
  printf '%s\n' "${FAILURES[@]}"
  exit 1
fi

echo "PASS: no provider-key strings, founder paths, generated runtime files, or default enabled add-ons found in distributable artifacts."
