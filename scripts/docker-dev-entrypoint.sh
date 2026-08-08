#!/usr/bin/env bash
set -euo pipefail

source_dir="${RESONANTOS_DEV_SOURCE_DIR:-/source}"
workspace_dir="${RESONANTOS_DEV_WORKSPACE_DIR:-/workspace}"

is_rejected_path() {
  local relative_path="$1"
  local basename="${relative_path##*/}"
  local wrapped="/${relative_path}/"

  case "$wrapped" in
    */.git/*|*/node_modules/*|*/Memory/*|*/Living_Archive/*|*/ResonantOS_User/*|*/.resonantos/*|*/.codex/*|*/.abacusai/*|*/.understand-anything/*|*/logs/*|*/tmp/*|*/output/*|*/runs/*|*/artifacts/*|*/evidence/*|*/screenshots/*|*/playwright-report/*|*/test-results/*|*/browser-first/certs/*|*/chrome-user-data/*|*/chrome-profile/*|*/chrome-profiles/*|*/chromium/*|*/google-chrome/*|*/Sessions/*|*/Session\ Storage/*|*/Local\ Storage/*|*/IndexedDB/*)
      return 0
      ;;
  esac

  case "$basename" in
    .env|.env.*|*.key|*.pem|*.p12|*.mobileprovision|*.keystore|*.log|Cookies|Cookies-journal|Login\ Data|Login\ Data-journal|History|History-journal|Web\ Data|Web\ Data-journal|Local\ State|Preferences|Secure\ Preferences|Favicons|Favicons-journal|Top\ Sites|Top\ Sites-journal|Network\ Action\ Predictor|Network\ Action\ Predictor-journal|Visited\ Links|bridge-config.generated.js)
      return 0
      ;;
  esac

  return 1
}

stage_worktree() {
  local git_metadata_dir

  if [[ ! -e "$source_dir/.git" ]]; then
    echo "resonantos-dev-entrypoint: $source_dir is not a Git working tree" >&2
    return 1
  fi
  if [[ "$workspace_dir" == "$source_dir" ]]; then
    echo "resonantos-dev-entrypoint: source and workspace must be different directories" >&2
    return 1
  fi

  unset GIT_DIR GIT_WORK_TREE
  mkdir -p "$workspace_dir"
  while IFS= read -r -d '' relative_path; do
    if [[ "$relative_path" == /* || "$relative_path" == ".." || "$relative_path" == ../* || "$relative_path" == */../* ]]; then
      echo "resonantos-dev-entrypoint: rejected unsafe path: $relative_path" >&2
      return 1
    fi
    if is_rejected_path "$relative_path"; then
      continue
    fi
    if [[ -L "$source_dir/$relative_path" ]]; then
      echo "resonantos-dev-entrypoint: rejected symbolic link: $relative_path" >&2
      return 1
    fi
    if [[ ! -e "$source_dir/$relative_path" ]]; then
      continue
    fi

    mkdir -p "$workspace_dir/$(dirname "$relative_path")"
    cp -a "$source_dir/$relative_path" "$workspace_dir/$relative_path"
  done < <(
    git -c safe.directory="$source_dir" -C "$source_dir" \
      ls-files --cached --others --exclude-standard -z
  )

  git_metadata_dir="$(git -c safe.directory="$source_dir" -C "$source_dir" rev-parse --absolute-git-dir)"
  printf 'gitdir: %s\n' "$git_metadata_dir" > "$workspace_dir/.git"
}

if [[ -d "$source_dir" ]]; then
  stage_worktree
fi

cd "$workspace_dir"
exec "$@"
