import test from "node:test";
import assert from "node:assert/strict";

import { redactTraceText } from "../resonantos-side-panel-extension/src/lib/trace-redaction.js";

test("redactTraceText redacts secret URL query parameters and preserves benign ones", () => {
  const input = "https://example.test/login?token=abc123&email=a@b.com&api_key=sekrit&ref=home";
  const output = redactTraceText(input);
  assert.equal(output, "https://example.test/login?token=REDACTED&email=a@b.com&api_key=REDACTED&ref=home");
});

test("redactTraceText redacts secret assignment forms", () => {
  assert.equal(redactTraceText("password=hunter2secret"), "password=REDACTED");
  assert.equal(redactTraceText("password: hunter2secret"), "password: REDACTED");
  assert.equal(redactTraceText("password:hunter2secret"), "password:REDACTED");
  assert.equal(redactTraceText("api_key = super-secret-value"), "api_key = REDACTED");
  assert.equal(redactTraceText("pin: 9876"), "pin: REDACTED");
  assert.equal(redactTraceText("otp is 123456"), "otp is 123456");
});

test("redactTraceText redacts the token following a Bearer scheme", () => {
  const bearer = redactTraceText("Token: Bearer abc123");
  assert.match(bearer, /Token: REDACTED/);
  assert.doesNotMatch(bearer, /Bearer/);
  assert.doesNotMatch(bearer, /abc123/);
  const authorization = redactTraceText("Authorization: Bearer eyJhbGci.payload.signature-x");
  assert.match(authorization, /Authorization: REDACTED/);
  assert.doesNotMatch(authorization, /Bearer/);
  assert.doesNotMatch(authorization, /eyJhbGci/);
});

test("redactTraceText redacts session, sid, csrf, key, and code assignments", () => {
  assert.equal(redactTraceText("session=abc123def"), "session=REDACTED");
  assert.equal(redactTraceText("sid: s-778899"), "sid: REDACTED");
  assert.equal(redactTraceText("csrf=t0k3n-v4lue"), "csrf=REDACTED");
  assert.equal(redactTraceText("key = private-key-material"), "key = REDACTED");
  assert.equal(redactTraceText("code: 84h2k9"), "code: REDACTED");
  const oauth = redactTraceText("https://a.test/cb?code=4/0AbCdEf&state=xyz");
  assert.match(oauth, /code=REDACTED/);
  assert.doesNotMatch(oauth, /4\/0AbCdEf/);
});

test("redactTraceText redacts secrets inside percent-encoded nested URLs", () => {
  const nested = redactTraceText("https://a.test/login?next=https%3A%2F%2Fb.com%2F%3Ftoken%3Dabc123");
  assert.match(nested, /%3Ftoken%3DREDACTED/i);
  assert.doesNotMatch(nested, /abc123/);
  const chained = redactTraceText("?return=https%3A%2F%2Fc.com%2Fpage%3Fa%3D1%26api_key%3Dsekrit99%26b%3D2");
  assert.match(chained, /%26api_key%3DREDACTED/i);
  assert.doesNotMatch(chained, /sekrit99/);
  assert.match(chained, /%26b%3D2/i);
});

test("redactTraceText redacts full assignment values through commas and semicolons", () => {
  assert.equal(redactTraceText("password=abc,defsecret"), "password=REDACTED");
  assert.equal(redactTraceText("token: v1;part2;part3 done"), "token: REDACTED done");
  assert.doesNotMatch(redactTraceText("secret=left,right tail"), /right/);
});

test("redactTraceText redacts long hex tokens and preserves short hex and normal text", () => {
  const longHex = "7f3c9a1b2d4e5f68790a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f";
  assert.equal(redactTraceText(`token ${longHex} end`), "token [REDACTED-TOKEN] end");
  assert.equal(redactTraceText("color #f3c9a1"), "color #f3c9a1");
  assert.equal(redactTraceText("the quick brown fox"), "the quick brown fox");
});

test("redactTraceText returns an empty string for non-string input", () => {
  assert.equal(redactTraceText(undefined), "");
  assert.equal(redactTraceText(null), "");
  assert.equal(redactTraceText(42), "");
  assert.equal(redactTraceText({ token: "abc" }), "");
});

test("redactTraceText leaves clean trace text unchanged", () => {
  const clean = [
    "# Browser Job Report",
    "- status: completed",
    "1. Read page - ok - read product page",
    "## Boundary",
    "Intake artifact only."
  ].join("\n");
  assert.equal(redactTraceText(clean), clean);
});

const secretNames = [
  'password', 'passwd', 'pwd', 'token', 'secret', 'otp', 'pin', 'signature', 'jwt', 'session', 'sid', 'csrf', 'key', 'code',
  ...['api:key', 'access:token', 'refresh:token', 'auth:code', 'client:secret', 'client:id', 'client:token',
    'session:id', 'session:token', 'session:key', 'id:token', 'csrf:token', 'jwt:token']
    .flatMap((parts) => ['', '_', '-'].map((separator) => parts.replace(':', separator)))
];
for (const options of [{}, { replacement: '[redacted]', tokenReplacement: '[redacted]' }]) {
  const replacement = options.replacement ?? 'REDACTED';
  test(`shared redaction preserves the strict union in ${replacement} output style`, () => {
    for (const name of secretNames) {
      for (const spelling of [name, name.toUpperCase()]) {
        for (const [input, expected] of [
          [`?${spelling}=synthetic-value&view=wide`, `?${spelling}=${replacement}&view=wide`],
          [`%3F${spelling}%3Dsynthetic-value%26view%3Dwide`, `%3F${spelling}%3D${replacement}%26view%3Dwide`],
          [`${spelling}=synthetic-value done`, `${spelling}=${replacement} done`],
          [`{"${spelling}":"synthetic-value","view":"wide"}`, `{"${spelling}":"${replacement}","view":"wide"}`]
        ]) {
          assert.equal(redactTraceText(input, options), expected, input);
          assert.equal(redactTraceText(expected, options), expected, `idempotence: ${input}`);
        }
      }
    }
    const tokens = ['sk_live_' + 'X'.repeat(8), 'AKIA' + 'X'.repeat(16), 'AIza' + 'x'.repeat(25),
      ...'pousr'.split('').map((c) => `gh${c}_` + 'x'.repeat(20)),
      ...'abp'.split('').map((c) => `xox${c}-` + 'x'.repeat(10)), 'Z'.repeat(40), 'a'.repeat(32)];
    for (const token of tokens) assert.equal(redactTraceText(`before ${token} after`, options), `before ${options.tokenReplacement ?? '[REDACTED-TOKEN]'} after`);
    const benign = 'job-123 control-abc https://example.test/?view=wide&ref=home abcdef sk_live_short ghp_short xoxb-short';
    assert.equal(redactTraceText(benign, options), benign);
  });
  test(`Bearer and quoted credentials are consumed completely in ${replacement} style`, () => {
    for (const [input, expected] of [
      ['Token: Bearer synthetic-a1-value done', `Token: ${replacement} done`],
      ['client_secret="left: right" done', `client_secret="${replacement}" done`],
      ['password="left \\"middle\\" right" done', `password="${replacement}" done`],
      ["client_secret='left: right' done", `client_secret='${replacement}' done`],
      ['?token=Bearer synthetic-a1-value&view=wide', `?token=${replacement}&view=wide`],
      ['%3Fclient_secret%3Dleft%3A%20right%26view%3Dwide', `%3Fclient_secret%3D${replacement}%26view%3Dwide`],
      ['password=left,right;end done', `password=${replacement} done`]
    ]) assert.equal(redactTraceText(input, options), expected);
  });
}

test('recursive trace redaction detaches and safely handles arbitrary JSON', async () => {
  const { redactTraceValue } = await import('../resonantos-side-panel-extension/src/lib/trace-redaction.js');
  assert.equal(typeof redactTraceValue, 'function', 'recursive redactor exists');
  let reads = 0;
  const input = { nested: [{ password: 'x', pin: 7, client_secret: { private: true }, note: 'token=synthetic-value' }], count: 2, ok: true, empty: null };
  Object.defineProperty(input, 'getter', { enumerable: true, get() { reads++; return 'secret'; } });
  Object.defineProperty(input, '__proto__', { enumerable: true, value: { note: 'safe' } });
  input['token=first'] = 'first'; input['token=second'] = 'second'; input.self = input;
  input.unsupported = () => {}; input.infinity = Infinity;
  const output = redactTraceValue(input);
  assert.equal(reads, 0);
  assert.notEqual(output, input); assert.notEqual(output.nested, input.nested);
  assert.deepEqual(output.nested, [{ password: 'REDACTED', pin: 'REDACTED', client_secret: 'REDACTED', note: 'token=REDACTED' }]);
  assert.equal(output.count, 2); assert.equal(output.ok, true); assert.equal(output.empty, null);
  assert.equal(output.getter, null); assert.equal(output.self, null); assert.equal(output.unsupported, null); assert.equal(output.infinity, null);
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.ok(Object.hasOwn(output, '__proto__')); assert.deepEqual(output.__proto__, { note: 'safe' });
  assert.deepEqual(Object.entries(output).filter(([key]) => key.startsWith('token=')).map(([, value]) => value), ['first', 'second']);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-value|token=first|token=second/);
  assert.deepEqual(redactTraceValue(output), output);
});

test('quoted JSON numeric credentials retain benign neighboring fields', () => {
  assert.equal(redactTraceText('{"pin":1234,"view":"wide"}'), '{"pin":REDACTED,"view":"wide"}');
});

test('provider and heuristic boundaries retain below-threshold benign text', () => {
  const benign = ['sk_live_' + 'X'.repeat(7), 'AKIA' + 'X'.repeat(15), 'AIza' + 'x'.repeat(24),
    'ghp_' + 'x'.repeat(19), 'xoxb-' + 'x'.repeat(9), 'Z'.repeat(39), 'Z'.repeat(91), 'a'.repeat(31)];
  for (const text of benign) assert.equal(redactTraceText(text), text);
});

test('quoted names preserve full unquoted comma and semicolon secret coverage', () => {
  assert.equal(redactTraceText('"token":left,right;end done'), '"token":REDACTED done');
  assert.equal(redactTraceText('{"pin":1234,"view":"wide"}'), '{"pin":REDACTED,"view":"wide"}');
  assert.equal(redactTraceText('{"pin":REDACTED,"view":"wide"}'), '{"pin":REDACTED,"view":"wide"}');
});
