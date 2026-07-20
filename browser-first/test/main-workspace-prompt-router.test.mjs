import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDaoSlashCommand,
  parseControlSlashCommand,
  parseDraftSlashCommand,
  parseHermesSlashCommand,
  parseIntakeSlashCommand,
  parseMemorySlashCommand,
  parseOpenCodeSlashCommand,
  parseWorkspaceInspectionIntent,
  parseWalletSlashCommand,
  planMainWorkspacePrompt
} from "../resonantos-side-panel-extension/src/lib/main-workspace-prompt-router.js";

test("main workspace prompt router parses explicit workspace slash commands", () => {
  assert.equal(parseMemorySlashCommand("/memory augmentatism"), "augmentatism");
  assert.equal(parseControlSlashCommand("/control go to disney.com"), "go to disney.com");
  assert.equal(parseControlSlashCommand("/control"), "");
  assert.deepEqual(parseWorkspaceInspectionIntent("/control inspect this workspace and summarize languages"), {
    query: "inspect this workspace and summarize languages",
    source: "control-slash"
  });
  assert.equal(parseMemorySlashCommand("/archive"), "");
  assert.equal(parseHermesSlashCommand("/hermes coordinate research"), "coordinate research");
  assert.equal(parseOpenCodeSlashCommand("/open code inspect tests"), "inspect tests");
  assert.deepEqual(parseDraftSlashCommand("/email Follow up | body: Draft it"), {
    target: "email",
    body: "Follow up | body: Draft it"
  });
  assert.deepEqual(parseWalletSlashCommand("/wallet audit DAO vote"), {
    action: "audit",
    goal: "DAO vote"
  });
  assert.deepEqual(parseDaoSlashCommand("/dao audit governance page"), {
    action: "audit",
    goal: "governance page"
  });
});

test("main workspace prompt router parses delegation status slash commands", () => {
  assert.deepEqual(planMainWorkspacePrompt("/delegations hermes"), {
    action: "delegations",
    filter: "hermes"
  });
  assert.deepEqual(planMainWorkspacePrompt("/handoffs"), {
    action: "delegations",
    filter: ""
  });
});

test("main workspace prompt router parses reviewed intake slash commands", () => {
  assert.deepEqual(parseIntakeSlashCommand("/save"), {
    action: "page",
    body: ""
  });
  assert.deepEqual(parseIntakeSlashCommand("/intake selected quote"), {
    action: "selection",
    body: "quote"
  });
  assert.deepEqual(parseIntakeSlashCommand("/save summary"), {
    action: "summary",
    body: ""
  });
  assert.deepEqual(parseIntakeSlashCommand("/save trail DAO research"), {
    action: "trail",
    body: "DAO research"
  });
  assert.deepEqual(parseIntakeSlashCommand("/trail DAO research"), {
    action: "trail",
    body: "DAO research"
  });
  assert.deepEqual(planMainWorkspacePrompt("/save selection"), {
    action: "intake",
    command: {
      action: "selection",
      body: ""
    }
  });
});

test("main workspace prompt router delegates natural agent requests before provider chat", () => {
  assert.deepEqual(planMainWorkspacePrompt("ask Hermes to research the add-on strategy"), {
    action: "delegate",
    intent: {
      missingTarget: false,
      mission: "research the add-on strategy",
      target: "hermes"
    }
  });
  assert.deepEqual(planMainWorkspacePrompt("delegate this to OpenCode: inspect the browser tests"), {
    action: "delegate",
    intent: {
      missingTarget: false,
      mission: "inspect the browser tests",
      target: "opencode"
    }
  });
  assert.deepEqual(planMainWorkspacePrompt("spawn Hermes to review the research packet"), {
    action: "delegate",
    intent: {
      missingTarget: false,
      mission: "review the research packet",
      target: "hermes"
    }
  });
  assert.deepEqual(planMainWorkspacePrompt("can you delegate this to another agent?"), {
    action: "delegate",
    intent: {
      missingTarget: true,
      mission: "to another agent?",
      target: ""
    }
  });
  assert.deepEqual(planMainWorkspacePrompt("can you use the ResonantOS agent control layer directly?"), {
    action: "delegate",
    intent: {
      missingTarget: true,
      mission: "can you use the ResonantOS agent control layer directly?",
      target: ""
    }
  });
});

test("main workspace prompt router preserves explicit command priority", () => {
  assert.equal(planMainWorkspacePrompt("/hermes ask OpenCode to do nothing").action, "hermes");
  assert.equal(planMainWorkspacePrompt("/opencode ask Hermes to do nothing").action, "opencode");
  assert.equal(planMainWorkspacePrompt("/memory ask Hermes about archive").action, "memory");
  assert.equal(planMainWorkspacePrompt("/save ask Hermes about archive").action, "intake");
  assert.equal(planMainWorkspacePrompt("/wallet status").action, "wallet");
  assert.equal(planMainWorkspacePrompt("/dao review proposal").action, "dao");
  assert.equal(planMainWorkspacePrompt("/calendar Planning | body: Tuesday 10").action, "draft");
  assert.deepEqual(planMainWorkspacePrompt("/control go to disney.com"), {
    action: "control",
    goal: "go to disney.com"
  });
  assert.deepEqual(planMainWorkspacePrompt("/control inspect this workspace and summarize the languages, frameworks, runtimes, and package managers used"), {
    action: "workspace-inspection",
    intent: {
      query: "inspect this workspace and summarize the languages, frameworks, runtimes, and package managers used",
      source: "control-slash"
    }
  });
});

test("main workspace prompt router separates browser control from normal chat", () => {
  assert.equal(planMainWorkspacePrompt("go to resonantos.com and summarize the page").action, "control");
  assert.equal(planMainWorkspacePrompt("can you navigate to manoloremiddi.com?").action, "control");
  assert.equal(planMainWorkspacePrompt("find latest AI news on the internet").action, "control");
  assert.equal(planMainWorkspacePrompt("hey what's the most inportant new in the world today?").action, "control");
  assert.equal(planMainWorkspacePrompt("what is your technology stack?").action, "workspace-inspection");
  assert.equal(planMainWorkspacePrompt("inspect this workspace and summarize the package managers").action, "workspace-inspection");
  assert.equal(planMainWorkspacePrompt("explain the strategy without delegating").action, "chat");
  assert.equal(planMainWorkspacePrompt("").action, "empty");
});
