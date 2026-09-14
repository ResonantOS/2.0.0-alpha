<!--
  Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
  Copyright © 2026 Manolo Remiddi
  SPDX-License-Identifier: MIT
  License: MIT — see LICENSE at the repository root.
-->

# DSH 0.1.5 compatibility verification

Verified on 2026-09-10 with DSH **0.1.5-rc.1**, Node **24.19.0** and
Chromium **152.0.7977.82** on Linux. Live model checks used a local
OpenAI-compatible Qwen server. All proof runs used separate OS homes,
DSH homes, browser profiles, ports, tokens and chat storage.

## Public release failure

The exact [v0.1.31 GitHub release ZIP](https://github.com/ManoloRemiddi/augmentor-dsh-extension-plugin/releases/tag/v0.1.31)
with `dsh-augmentor@0.1.31` from npm failed after DSH restarted. Its old
tools dependency imports `CallId`, which the latest DSH LLM package no
longer exports. DSH exited before the extension could connect. The public
master tree at `a6a43fb150f2a8fed591d061541d32c4cd6d91b0` failed too.

Further integration checks exposed changed API routes and authentication,
the renamed persona setting, missing preset installation, and native port
reconnection leaks. A matching tools SDK must be a host-provided optional
peer: bundling a second tools runtime as a dependency breaks the host's
tool scheduler even when imports succeed.

## Candidate result

The **0.1.32 candidate** passed the complete installation proof in **56.6
seconds**, using the extracted release ZIP and the packed npm tarball
together. This verifies the distribution path as well as source installation.

- Fresh DSH install, plugin installation, native-host registration, app
  restart and real Chromium extension handshake succeeded with one pipe.
- Existing-user migration preserved custom preset content and the token,
  retained an exact backup, and changed the legacy persona key to `prefix`.
- Unauthenticated DSH API access, wrong Augmentor tokens, browser Origins
  and foreign Host headers were refused.
- A fresh chat using the shipped preset could be created, renamed and
  listed. The actual side panel loaded the model catalog and enabled Send.
- A real model turn invoked all five browser tools. Assertions checked
  navigation, the resulting page DOM after click/type, the rendered reply,
  tool history, and Save/Unsave.
- Stop cancelled a second admitted model turn and returned the panel to idle.
- All **13 regression tests** passed, including cookie renewal, no replay
  after uncertain command outcomes, stream adaptation, approval pass-through,
  native-host heartbeat expiry, prompt-library isolation and safe rendering.

Candidate artifact SHA-256 values:

```text
c713487709217bbe1fa641058a2294caecb3f4437f5e7e788a9ea4c0dbe7638f  augmentor-0.1.32-dist.zip
37d0b9372392e4b70fb7ecede1dfd940fa1d1df16566355fa166bfa9456ab068  dsh-augmentor-0.1.32.tgz
```

## Reproduction and limits

Run `node --test test/*.test.mjs` for regression coverage. To exercise a
candidate before publication, pack it with `sh scripts/pack-release.sh
0.1.32` and `npm pack` in `plugin/`, extract the ZIP, then run:

```sh
PROOF_TREE=/absolute/path/to/extracted/augmentor-0.1.32 \
PROOF_SOURCE=npm \
PROOF_NPM_SPEC=/absolute/path/to/dsh-augmentor-0.1.32.tgz \
PROOF_MODEL_HOME=/absolute/path/to/disposable/model-config \
PROOF_LLM=1 node test/install-proof.mjs
```

Supply the model's required environment variables through the shell. The
proof copies model configuration only when `PROOF_LLM=1`; it does not modify
the original. Without that flag, the installation, migration, authentication,
chat creation and panel checks still run without model credentials.

These results cover Linux Chromium and the local model route. macOS,
Windows, cloud model providers and earlier DSH versions were not verified.
The legacy e2e scripts target the old DSH API; the new installation/browser
proof and regression suite provide the checks reported here. This report
records a tested candidate, not a completed public release or npm publication.
