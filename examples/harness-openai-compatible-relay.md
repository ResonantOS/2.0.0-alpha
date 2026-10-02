# Optional OpenAI-compatible harness relay

This operator example adapts the OpenAI-compatible provider wire format used by
the [harness swap demo](../docs/addons/harness-adapter-demo.md). It was derived
from a live operator's loopback relay, without that run's credentials, prompts,
replies, logs, screenshots, or evidence bundle.

The relay is **not a privacy redactor**. It sends chat messages to the configured
upstream provider. The host decoder requires a `[DONE]` sentinel and rejects
error events, `tool_calls`, `function_call`, unsupported finish reasons, and
non-string content. It accepts unknown delta fields such as `name` and
`audio_content`, so stripping those fields is convenience cleanup; supplying
the sentinel after a valid finish event is the compatibility requirement. The
relay removes `store`, translates `max_completion_tokens` to `max_tokens`, and
removes known nonstandard SSE delta fields. It also removes literal
`<think>...</think>` tag pairs from visible text across frames. That removal is
lossy: literal tag pairs in an otherwise visible reply are discarded, and the
relay does not interpret every possible private marker. A missing `[DONE]` is
supplied only after an upstream finish event, while an upstream `[DONE]` is
passed through as the terminal marker. Other private content can still reach
the provider and appear in the signed evidence bundle. Review both before
sharing.

## Setup

Use Node.js 24.21.0 or newer. Set these values privately in the relay process
environment; do not put values in a repository file or paste them into an issue:

| Variable | Meaning |
| --- | --- |
| `UPSTREAM_CHAT` | Full HTTPS chat-completions URL. HTTP is accepted only for a numeric loopback test endpoint. |
| `UPSTREAM_MODELS` | Optional full models URL on the same origin; otherwise derived from `UPSTREAM_CHAT`. |
| `UPSTREAM_KEY` | The upstream provider bearer key. |
| `RELAY_BEARER` | A separate loopback bearer of at least 16 non-whitespace characters. |

After loading the variables, start one relay per compatible provider, on
different loopback ports and with different keys and bearers:

```bash
node examples/harness-openai-compatible-relay.mjs 8931
```

For the second provider, load its own environment values in a separate terminal
and use a different port, for example `8932`. The host-approved binding's
`endpoint` is `http://127.0.0.1:8931` (or the second port), and its bearer
source must resolve to the same `RELAY_BEARER` value used by that relay. Follow
the current demo guide's [Final certification setup](../docs/addons/harness-adapter-demo.md#final-certification-setup)
for the binding names, manifests, model selection, and DSH setup. This relay
does not replace DSH or grant any host capability.

The relay accepts only `POST /v1/chat/completions` and `GET /v1/models` (also
their unprefixed forms). It binds to `127.0.0.1`, requires its bearer on every
request, refuses upstream redirects, and writes no request or response dumps.
Upstream errors return a generic local error without the provider's body.

## Check the example

```bash
node --test examples/harness-openai-compatible-relay.test.mjs
```

For a live certification, run the demo's own `--verify` command on the original
signed `evidence.json`. The relay does not edit evidence or establish liveness;
compare both witnessed boot fingerprints as described in the demo guide.
