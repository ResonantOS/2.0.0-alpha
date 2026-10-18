# DSH native authentication design review 3

Both supplied round-3 reviews were read in full as data. Both found all five
round-2 findings resolved. Grok raised no new findings. DeepSeek raised one new
Important finding. Accepted: 1. Rejected: 0. Deferred: 0.

Inputs under the parent checkout's `.resonant-rig/jobs/`:

- `specrev3-dsh-native-deepseek@1791928109.1442.26618.log`, new finding at line 14.
- `specrev3-dsh-native-grok@1791928108.1411.28919.log`, closure findings at lines
  2 through 10 and no new findings at line 12.

In the table, `scratch/` means the parent checkout's
`.resonant-rig/livepass-dsh02/prefix/`. Its metadata and filesystem layout were
inspected without running DSH or the historical probe. These are supporting
local observations, not repository authority. The conductor selected the whole
install prefix as the trust boundary.

| finding | ACCEPTED or REJECTED | evidence | spec change |
| --- | --- | --- | --- |
| DeepSeek R3-1, Important: package-only validation misses hoisted runtime dependencies. | ACCEPTED | DeepSeek input line 14. `scratch/node_modules/@deepseek-ai/dsh/package.json` identifies version `0.2.0-rc.2`, entry `lib/bin.js`, and dependencies including `js-yaml` and `commander`. The DSH directory has no nested `node_modules`. Both dependencies and other scoped packages are siblings under `scratch/node_modules`. The observed `scratch/node_modules/.bin/js-yaml` points to `../js-yaml/bin/js-yaml.js`. That target is outside the DSH package and inside the prefix. | Define `RESONANTOS_DSH_PACKAGE_ROOT` as a dedicated npm install prefix. Recommend a separate install directory under the ResonantOS user root. Check the entire prefix tree, all hoisted dependencies, and `.bin`. Retain ownership, write-bit, ancestor-through-`/`, and contained-link rules at the prefix boundary. Derive the same DSH package and `lib/bin.js` entry from the prefix. Add fixed ceilings of 50,000 entries and depth 64. Refuse overflow with a clear fixed error. Charge walk time to the existing startup deadline. Add the hoisted-dependency, writable-dependency, contained-link, escaping-link, and ceiling-refusal test requirements. |

The inspected prefix contains 29,981 entries, including its root, directories,
files, and links. Its maximum depth is 13 with the prefix at depth zero. The
count did not follow directory links. This observation informs the chosen
ceilings. It does not certify the prefix's ownership or permissions, other
package versions, or production walk time. The live lane must record count,
depth, and validation duration for each exact version.

The [spec self-review](dsh-native-auth-design.md#self-review) records this round.
The [review-2 record](dsh-native-auth-design-review-2.md) stays unchanged as
history. Its package-root containment wording is superseded by the whole-prefix
rule in the revised spec.

The approved decisions remain fixed: plugin-free native mode, a bridge-owned
child, memory-only tokens and cookies, disabled telemetry, and working plugin
mode. The auth, provider, Origin, and telemetry live gates remain pending.
The added runtime cases are test requirements, not executed runtime tests.
This revision contains no implementation or live certification claim.
