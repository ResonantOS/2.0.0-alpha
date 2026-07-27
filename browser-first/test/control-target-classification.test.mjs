import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyControlTarget,
  isControllableTabUrl,
} from "../resonantos-side-panel-extension/src/lib/control-target-classification.js";

test("isControllableTabUrl accepts only http(s) pages", () => {
  assert.equal(isControllableTabUrl("https://example.com"), true);
  assert.equal(isControllableTabUrl("http://example.com/page"), true);
  assert.equal(isControllableTabUrl("chrome://settings"), false);
  assert.equal(isControllableTabUrl("chrome-extension://abc/main.html"), false);
  assert.equal(isControllableTabUrl("about:blank"), false);
  assert.equal(isControllableTabUrl(""), false);
  assert.equal(isControllableTabUrl(undefined), false);
});

test("classifyControlTarget marks a normal website controllable", () => {
  const result = classifyControlTarget("https://fifa.com/news");
  assert.equal(result.controllable, true);
  assert.equal(result.reason, "ok");
  assert.equal(result.guidance, "");
});

test("classifyControlTarget names the restricted Chrome page and explains why", () => {
  const result = classifyControlTarget("chrome://settings");
  assert.equal(result.controllable, false);
  assert.equal(result.reason, "restricted");
  assert.equal(result.label, "a Chrome page");
  // The message must name the page and explain the platform limit — not a generic ask.
  assert.match(result.guidance, /chrome:\/\/settings/);
  assert.match(result.guidance, /Chrome blocks extensions/);
});

test("classifyControlTarget labels other restricted schemes", () => {
  assert.equal(classifyControlTarget("chrome-extension://abc/x.html").label, "an extension page");
  assert.equal(classifyControlTarget("view-source:https://x.com").label, "a view-source page");
  assert.equal(classifyControlTarget("about:preferences").label, "a browser page");
});

test("classifyControlTarget falls back to the generic ask for no open page", () => {
  for (const empty of [undefined, "", "about:blank"]) {
    const result = classifyControlTarget(empty);
    assert.equal(result.controllable, false);
    assert.equal(result.reason, "empty");
    assert.match(result.guidance, /needs a normal web page target/);
  }
});
