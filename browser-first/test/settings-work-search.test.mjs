import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderWorkSection } from "../resonantos-side-panel-extension/src/lib/settings/work-section.js";

function setup(t) {
  const dom = new JSDOM("<main></main>", { url: "https://example.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const container = document.querySelector("main");
  const projects = [];
  const sessions = [{ id: "one", title: "Alpha work" }, { id: "two", title: "Other chat" }];
  let loads = 0;
  renderWorkSection(container, {
    chatSessionStore: {
      getSessions: () => sessions, getProjects: () => projects,
      createProject: async (name) => { projects.push({ id: "new", name }); }
    },
    bridgeRequest: async () => { loads += 1; return { entries: [] }; }
  });
  return {
    container, dom, projects, loads: () => loads,
    search: () => container.querySelector('[aria-label="Search chats and projects"]'),
    draft: () => container.querySelector('[name="projectName"]'),
    input(node, value) {
      node.value = value;
      node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    }
  };
}

test("search retains focus and raw whitespace throughout continuous typing", async (t) => {
  const ui = setup(t);
  await Promise.resolve();
  ui.search().focus();
  for (const value of ["A", "Al", "Alpha", "Alpha ", "Alpha w"]) {
    ui.input(ui.search(), value);
    assert.equal(document.activeElement, ui.search());
    assert.equal(ui.search().value, value);
  }
  assert.match(ui.container.querySelector(".settings-work-list").textContent, /Alpha work/);
  assert.doesNotMatch(ui.container.querySelector(".settings-work-list").textContent, /Other chat/);
});

test("selection edits keep the caret without replacing the input", async (t) => {
  const ui = setup(t);
  await Promise.resolve();
  const search = ui.search();
  search.focus();
  search.value = "Alpha work";
  search.setSelectionRange(2, 5, "backward");
  search.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  assert.equal(ui.search(), search);
  assert.equal(search.selectionStart, 2);
  assert.equal(search.selectionEnd, 5);
  assert.equal(search.selectionDirection, "backward");
});

test("filtering preserves project drafts and the independent artifact panel", async (t) => {
  const ui = setup(t);
  await Promise.resolve();
  ui.draft().value = "Unsubmitted project";
  const artifacts = ui.container.querySelector(".settings-work-artifacts");
  const artifactSearch = artifacts.querySelector("input");
  ui.input(artifactSearch, "existing filter");
  ui.input(ui.search(), "Alpha");
  assert.equal(ui.draft().value, "Unsubmitted project");
  assert.equal(ui.container.querySelector(".settings-work-artifacts"), artifacts);
  assert.equal(artifactSearch.value, "existing filter");
  assert.equal(ui.loads(), 1);
});

test("creating a project clears only the submitted project draft", async (t) => {
  const ui = setup(t);
  await Promise.resolve();
  ui.input(ui.search(), "Alpha");
  ui.draft().value = "Alpha project";
  ui.container.querySelector(".settings-work-tools").dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  assert.deepEqual(ui.projects, [{ id: "new", name: "Alpha project" }]);
  assert.equal(ui.draft().value, "");
  assert.equal(ui.search().value, "Alpha");
  assert.equal(ui.loads(), 1);
});
