import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentControlHostService,
  sanitizeControlPlan,
  sanitizeControlStep,
  sanitizeNextActionDecision,
  trimPlannerSnapshot,
} from "../host/agent-control-host-service.mjs";

function baseDependencies(overrides = {}) {
  const route = {
    apiBaseUrl: "https://provider.example/v1",
    label: "Test Provider",
    providerId: "provider.test",
    providerType: "openai",
    wireModel: "test-model",
  };
  return {
    extractAssistantContent: (payload) => payload.choices?.[0]?.message?.content ?? "",
    extractJsonObject: JSON.parse,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Read first",
                steps: [{ type: "read" }],
              }),
            },
          },
        ],
        usage: { total_tokens: 42 },
      }),
    }),
    openAiReasoningEffort: () => "low",
    providerRouteForModel: () => route,
    readProviderSecrets: async () => ({ "provider.test": "secret-value" }),
    sanitizeAssistantContent: (_providerType, content) => content,
    ...overrides,
  };
}

test("Agent Control host service owns planner, next-action, and news routes", () => {
  const { agentControlRoutes } = createAgentControlHostService(baseDependencies());
  assert.deepEqual(
    agentControlRoutes.map((route) => `${route.method} ${route.path}`),
    [
      "POST /augmentor/control-plan",
      "POST /augmentor/next-action",
      "POST /web/news",
    ],
  );
  assert.deepEqual(
    agentControlRoutes.map((route) => route.requiredCapability),
    ["agent-control-plan", "agent-control-plan", "agent-control-plan"],
  );
});

test("Agent Control host service fails fast when provider dependencies are missing", () => {
  const dependencies = baseDependencies();
  delete dependencies.readProviderSecrets;
  assert.throws(
    () => createAgentControlHostService(dependencies),
    /Agent Control host service missing dependency: readProviderSecrets/,
  );
});

test("Agent Control host sanitizer blocks restricted browser actions", () => {
  assert.deepEqual(sanitizeControlStep({ type: "open", target: "example.com" }), {
    type: "open",
    target: "https://example.com/",
  });
  assert.throws(
    () => sanitizeControlStep({ type: "click", text: "Approve Phantom wallet transaction" }),
    /restricted click/,
  );
  assert.equal(
    sanitizeNextActionDecision({
      status: "continue",
      action: { type: "type", field: "Password", text: "secret" },
    }).status,
    "blocked",
  );
  assert.equal(sanitizeControlPlan({ steps: [{ type: "stop", reason: "Needs human approval" }] }).needsApproval, true);
});

test("Agent Control host planner trims page snapshots and calls provider without exposing secrets", async () => {
  const calls = [];
  const { executeControlPlan } = createAgentControlHostService(baseDependencies({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ summary: "Open", steps: [{ type: "read" }] }) } }],
          usage: { total_tokens: 7 },
        }),
      };
    },
  }));

  const result = await executeControlPlan({
    goal: "Read the current page",
    pageSnapshot: {
      title: "T".repeat(300),
      text: "A".repeat(7000),
      links: Array.from({ length: 35 }, (_, index) => ({ text: `link ${index}` })),
    },
  });

  assert.equal(result.providerId, "provider.test");
  assert.equal(result.plan.steps[0].type, "read");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-value");
  const body = JSON.parse(calls[0].options.body);
  const userPayload = JSON.parse(body.messages[1].content);
  assert.equal(userPayload.pageSnapshot.title.length, 180);
  assert.equal(userPayload.pageSnapshot.text.length, 6000);
  assert.equal(userPayload.pageSnapshot.links.length, 30);
});

test("Agent Control host news route parses RSS items and decodes XML entities", async () => {
  const { executeNewsSearch } = createAgentControlHostService(baseDependencies({
    fetchImpl: async (url, options) => {
      assert.match(url, /news\.google\.com\/rss\/search/);
      assert.equal(options.headers["User-Agent"], "Mozilla/5.0 ResonantOS BrowserFirst");
      return {
        ok: true,
        text: async () => `
          <rss><channel>
            <item>
              <title><![CDATA[AI &amp; Sovereignty]]></title>
              <link>https://example.com/a?x=1&amp;y=2</link>
              <source>Example News</source>
              <pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate>
            </item>
          </channel></rss>
        `,
      };
    },
  }));

  const result = await executeNewsSearch({ query: "AI sovereignty", limit: 3 });
  assert.equal(result.query, "AI sovereignty");
  assert.deepEqual(result.items, [
    {
      title: "AI & Sovereignty",
      link: "https://example.com/a?x=1&y=2",
      source: "Example News",
      publishedAt: "Mon, 01 Jun 2026 12:00:00 GMT",
    },
  ]);
});

test("trimPlannerSnapshot bounds hostile page snapshots", () => {
  const snapshot = trimPlannerSnapshot({
    title: "A".repeat(1000),
    url: "https://example.com/".padEnd(1200, "a"),
    text: "T".repeat(10_000),
    controls: Array.from({ length: 100 }, (_, index) => ({ ref: String(index) })),
    fields: Array.from({ length: 100 }, (_, index) => ({ ref: String(index) })),
    tabs: Array.from({ length: 100 }, (_, index) => ({ id: index })),
  });
  assert.equal(snapshot.title.length, 180);
  assert.equal(snapshot.url.length, 800);
  assert.equal(snapshot.text.length, 6000);
  assert.equal(snapshot.controls.length, 40);
  assert.equal(snapshot.fields.length, 30);
  assert.equal(snapshot.tabs.length, 30);
});
