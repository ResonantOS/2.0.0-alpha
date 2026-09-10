# Subprocess No Shell-String

PR #338 adds a blocking security-pipeline check for the string-to-shell
process-construction class fixed in PR #333 (the engineer-runner ran
`spawnSync(command, { shell: true })` with contract-file strings). The adapter
is registered in [checks.yml](../../.github/security-pipeline/checks.yml) as
`subprocess-no-shell-string` (family `runtime-hardening`, policy `block`), and
the `subprocess no shell-string (gate)` job in
[security.yml](../../.github/workflows/security.yml) runs its own test file
before the check so a broken adapter fails before a silent pass.

## What It Detects

- `exec-string-api`: `exec()` / `execSync()` calls — the command string is
  shell-interpreted by design. Bare and member calls both match
  (`execSync(...)`, `child_process.execSync(...)`); only `.exec(` is excluded,
  because member `exec` is overwhelmingly `RegExp.prototype.exec` or a domain
  method.
- `shell-true-option`: spawn-family calls (`spawn`, `spawnSync`, `execFile`,
  `execFileSync`) with a `shell:` option whose value is anything except the
  bare boolean `false` — string values such as `shell: "bash"` (and
  `shell: "false"`, which names an executable, not the boolean) and the
  shorthand `{ shell }` form all flag.
- `template-command-arg`: spawn-family calls whose command argument is a
  template literal (dynamic command construction).
- `unparseable-call-span`: a matched call whose span cannot be parsed within
  8000 characters — a huge inline options object must not silently hide a
  `shell: true`.

The sanctioned pattern is argv form: `spawn(file, [args], { shell: false })`.

## Masking

String, template, comment, and regex-literal contents are masked before
matching, so call-shaped text inside literals never flags. Quote state resets
at newline for non-template strings, and regex literals are recognized
positionally (after `( , = : ? ; ! [ { & | >` — the `>` covers arrow-body
regexes — or the keywords `return case typeof in of new void delete await
yield`, or start of file), so a quote inside
`/["'()]/` cannot open a phantom string and invert masking for the rest of the
file. A `/` after an identifier, digit, `)`, or `]` stays division. This is a
heuristic, not a JS parser — ambiguous constructs are rare in practice and err
toward flagging.

## Scope

In a git checkout the check enumerates `git ls-files --cached --others
--exclude-standard` (the pattern validate-docs adopted in #365), so it scans
exactly tracked files plus visible untracked work: gitignored scratch and
nested agent worktrees never reach the scan, and the local gate matches a
clean checkout. Dot-directories are excluded on both enumeration paths.
Outside a git checkout it walks the tree with the same exclusions. A git
failure mid-scan (including a >32 MiB `ls-files` overflow, unreachable at this
repo's size) falls back to the plain walk — noted as a blind spot.

## Allowlisting

Each entry pins file, rule, and the exact trimmed source line, so moved or
edited code re-flags and forces a fresh look. Entries live in the adapter's
`ALLOWLIST` in
[subprocess-no-shell-string.mjs](../../scripts/security-pipeline/checks/subprocess-no-shell-string.mjs)
and must carry the data-flow rationale for why the site is safe (for example:
compile-time literal commands with no variable content). Known blind spots and
the current allowlisted sites are documented in the adapter header.

## Run Locally

```bash
node --test scripts/security-pipeline/checks/subprocess-no-shell-string.test.mjs
node scripts/security-pipeline/run-check.mjs --check subprocess-no-shell-string
```
