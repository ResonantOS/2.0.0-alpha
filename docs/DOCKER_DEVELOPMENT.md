# Safe Docker Development

Use this workflow to run npm, deterministic tests, and live extension
certification without loading ResonantOS into a production Chrome profile. It
uses Debian Chromium, Xvfb, a read-only source mount, an isolated dependency
volume, and an ephemeral working directory inside each container.

This environment prepares the repository for future contribution work. It does
not implement or close [issue #221](https://github.com/ResonantOS/2.0.0-alpha/issues/221).

## Build The Image

From the repository root:

```bash
docker build -f Dockerfile.dev -t resonantos-dev .
docker volume create resonantos-node-modules
```

The image uses Node.js 22.13.0 and Debian Chromium. Confirm the toolchain and
non-root account. The image uses `tini` to forward signals and reap Chromium and
Xvfb child processes correctly:

```bash
docker run --rm resonantos-dev node --version
docker run --rm resonantos-dev chromium --version
docker run --rm resonantos-dev id
```

## Install Dependencies

The source checkout is mounted read-only at `/source`. The entrypoint copies
tracked, modified, and non-ignored source files into the container's ephemeral
`/workspace`; it does not copy Git metadata, secrets, profiles, generated bridge
configuration, local evidence, or symbolic links. A `.git` pointer lets checks
read the source mount's Git metadata, but the read-only mount prevents commands
from changing it. Dependencies remain in the named volume.

```bash
docker run --rm -it \
  --mount type=bind,src="$PWD",dst=/source,readonly \
  --mount type=volume,src=resonantos-node-modules,dst=/workspace/node_modules \
  resonantos-dev \
  npm ci
```

Run this command again whenever `package-lock.json` changes. Do not pass provider
credentials or mount a real Chrome or Chromium profile into the container.

## Run Deterministic Tests

Focused tests still use the repository's existing Node test commands:

```bash
docker run --rm -it \
  --mount type=bind,src="$PWD",dst=/source,readonly \
  --mount type=volume,src=resonantos-node-modules,dst=/workspace/node_modules \
  resonantos-dev \
  node --test browser-first/test/composer-controller.test.mjs
```

Run the complete browser-first and controlled browser-host suites:

```bash
docker run --rm -it \
  --mount type=bind,src="$PWD",dst=/source,readonly \
  --mount type=volume,src=resonantos-node-modules,dst=/workspace/node_modules \
  resonantos-dev \
  npm run test:browser-first

docker run --rm -it \
  --mount type=bind,src="$PWD",dst=/source,readonly \
  --mount type=volume,src=resonantos-node-modules,dst=/workspace/node_modules \
  resonantos-dev \
  npm run test:browser-host
```

## Run Live Chromium Certification

The live command loads the extension into an isolated temporary Chromium
profile under Xvfb. Generated bridge credentials and certification artifacts
remain in the disposable container filesystem.

```bash
docker run --rm -it \
  --mount type=bind,src="$PWD",dst=/source,readonly \
  --mount type=volume,src=resonantos-node-modules,dst=/workspace/node_modules \
  --env CI=true \
  resonantos-dev \
  xvfb-run -a npm run test:browser-first:live
```

The standard command intentionally discards screenshots and generated bridge
state when the container exits. For pull-request evidence, record the command
result and redact diagnostics before attaching them outside the repository. Do
not commit screenshots, reports, bridge tokens, or browser state.

## Verify And Clean Up

After running the container workflow, confirm that no runtime state appeared in
the host checkout:

```bash
git status --short
```

Remove the cached dependency volume when dependencies need a completely fresh
install or when the environment is no longer needed:

```bash
docker volume rm resonantos-node-modules
```

The workflow never needs production Chrome, provider secrets, wallet material,
login cookies, or a real browser profile. Keep those resources outside every
container mount and pull-request artifact.
