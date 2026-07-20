import assert from "node:assert/strict";
import test from "node:test";

import { findRoadmapProjectMismatches } from "./check-roadmap-project.mjs";

const projectItems = [
  {
    content: { number: 179 },
    "release Scope": null,
    labels: ["feat", "scope:community-test", "area:living-archive"],
  },
];

test("reports a roadmap scope that contradicts the Project field or unique managed label", () => {
  const roadmap = [
    "# Roadmap",
    "",
    "## Deferred",
    "- [#179: Export](https://github.com/ResonantOS/2.0.0-alpha/issues/179)",
  ].join("\n");

  assert.deepEqual(findRoadmapProjectMismatches(roadmap, projectItems), [
    {
      issue: 179,
      projectScope: "Community Test",
      roadmapScope: "Deferred / Waived",
    },
  ]);
});

test("accepts roadmap scope aligned with a populated Project field", () => {
  const roadmap = [
    "# Roadmap",
    "",
    "## Community Test",
    "- [#179: Export](https://github.com/ResonantOS/2.0.0-alpha/issues/179)",
  ].join("\n");
  const items = [{ ...projectItems[0], "release Scope": "Community Test" }];

  assert.deepEqual(findRoadmapProjectMismatches(roadmap, items), []);
});

test("ignores closed Project items retained as explicit roadmap history", () => {
  const roadmap = [
    "# Roadmap",
    "",
    "## Experimental",
    "- [#238: Closed experiment](https://github.com/ResonantOS/2.0.0-alpha/issues/238)",
  ].join("\n");
  const items = [{
    content: { number: 238, state: "CLOSED" },
    "release Scope": null,
    labels: [],
  }];

  assert.deepEqual(findRoadmapProjectMismatches(roadmap, items), []);
});

test("populated gh Project field overrides a contradictory managed label", () => {
  const roadmap = [
    "# Roadmap",
    "",
    "## Community Test",
    "- [#179: Export](https://github.com/ResonantOS/2.0.0-alpha/issues/179)",
  ].join("\n");
  const items = [{
    content: { number: 179 },
    "release Scope": "Deferred / Waived",
    labels: ["scope:community-test"],
  }];

  assert.deepEqual(findRoadmapProjectMismatches(roadmap, items), [{
    issue: 179,
    projectScope: "Deferred / Waived",
    roadmapScope: "Community Test",
  }]);
});
