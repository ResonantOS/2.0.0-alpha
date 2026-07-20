import assert from "node:assert/strict";
import test from "node:test";

import { createChatSessionStore } from "../resonantos-side-panel-extension/src/lib/chat-session-store.js";

function createHarness(initial = {}) {
  const writes = [];
  let model = "MiniMax-M3";
  let thinkingDepth = "high";
  const storage = {
    get: async () => initial,
    set: async (payload) => {
      writes.push(payload);
      Object.assign(initial, payload);
    }
  };
  const store = createChatSessionStore({
    storage,
    storageKeys: {
      messages: "messages",
      forks: "forks",
      sessions: "sessions",
      projects: "projects",
      activeSessionId: "activeSessionId",
      model: "model",
      thinkingDepth: "thinkingDepth",
      attachments: "attachments"
    },
    getModel: () => model,
    getThinkingDepth: () => thinkingDepth,
    setModel: (value) => {
      model = value;
    },
    setThinkingDepth: (value) => {
      thinkingDepth = value;
    },
    isAllowedModel: (value) => ["MiniMax-M3", "gpt-5.5"].includes(value),
    isAllowedThinkingDepth: (value) => ["low", "high"].includes(value),
    now: () => "2026-05-26T00:00:00.000Z",
    createId: (() => {
      let index = 0;
      return () => `message-${++index}`;
    })()
  });
  return {
    getModel: () => model,
    getThinkingDepth: () => thinkingDepth,
    store,
    writes
  };
}

test("chat session store hydrates valid state and ignores invalid messages/settings", async () => {
  const harness = createHarness({
    messages: [
      { id: "a", role: "user", content: "hello", createdAt: "now" },
      { id: "b", role: "bad", content: "drop me", createdAt: "now" }
    ],
    forks: [{ id: "fork-a" }],
    model: "gpt-5.5",
    thinkingDepth: "low",
    attachments: [{ id: "file-a", name: "a.md" }]
  });

  await harness.store.hydrate();

  assert.equal(harness.getModel(), "gpt-5.5");
  assert.equal(harness.getThinkingDepth(), "low");
  assert.equal(harness.store.getMessages().length, 1);
  assert.equal(harness.store.getSessions().length, 1);
  assert.equal(harness.store.getForks().length, 1);
  assert.equal(harness.store.getAttachments().length, 1);
});

test("chat session store clears stale project references on hydrate", async () => {
  const harness = createHarness({
    sessions: [{
      id: "session-a",
      title: "Old project chat",
      projectId: "missing-project",
      messages: [{ id: "message-a", role: "user", content: "hello", createdAt: "2026-05-25T00:00:00.000Z" }]
    }],
    projects: [{
      id: "archived-project",
      name: "Archived",
      archivedAt: "2026-05-25T00:00:00.000Z"
    }],
    activeSessionId: "session-a"
  });

  await harness.store.hydrate();

  assert.equal(harness.store.getActiveSession().projectId, "");
});


test("chat session store creates and switches durable chat workspaces", async () => {
  const harness = createHarness();

  await harness.store.hydrate();
  await harness.store.addMessage("user", "first workspace question");
  const firstSessionId = harness.store.getActiveSessionId();
  const second = await harness.store.createSession();
  await harness.store.addMessage("user", "second workspace question");

  assert.notEqual(second.id, firstSessionId);
  assert.equal(harness.store.getMessages()[0].content, "second workspace question");
  assert.equal(harness.store.getSessions()[0].title, "second workspace question");

  await harness.store.switchSession(firstSessionId);

  assert.equal(harness.store.getMessages()[0].content, "first workspace question");
  assert.equal(harness.store.getActiveSessionId(), firstSessionId);
});

test("chat session store starts a fresh blank session on app launch without erasing history", async () => {
  const harness = createHarness({
    sessions: [
      {
        id: "old-session",
        title: "Old task",
        workspaceId: "answer",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
        messages: [{ id: "old-message", role: "user", content: "old task", createdAt: "2026-05-25T00:00:00.000Z" }]
      }
    ],
    activeSessionId: "old-session"
  });

  await harness.store.hydrate();
  const fresh = await harness.store.ensureFreshSession();

  assert.notEqual(fresh.id, "old-session");
  assert.equal(harness.store.getMessages().length, 0);
  assert.equal(harness.store.getSessions().some((session) => session.id === "old-session"), true);
  assert.equal(harness.store.getActiveSessionId(), fresh.id);

  const sameFresh = await harness.store.ensureFreshSession();
  assert.equal(sameFresh.id, fresh.id);
});

test("chat session store renames, deletes, and tracks session workspace metadata", async () => {
  const harness = createHarness();

  await harness.store.hydrate();
  const first = harness.store.getActiveSession();
  await harness.store.setActiveSessionWorkspace("memory");
  await harness.store.renameSession(first.id, "Research memory work");
  await harness.store.addMessage("user", "this should not overwrite the edited title");

  assert.equal(harness.store.getActiveSession().title, "Research memory work");
  assert.equal(harness.store.getActiveSession().titleEdited, true);
  assert.equal(harness.store.getActiveSession().workspaceId, "memory");

  const second = await harness.store.createSession({ workspaceId: "opencode" });
  assert.equal(second.workspaceId, "opencode");
  assert.equal(harness.store.getActiveSessionId(), second.id);

  await harness.store.deleteSession(second.id);
  assert.equal(harness.store.getActiveSessionId(), first.id);
  assert.equal(harness.store.getActiveSession().workspaceId, "memory");
});

test("chat session store pins sessions and assigns projects", async () => {
  const harness = createHarness();

  await harness.store.hydrate();
  const project = await harness.store.createProject("Memory");
  await harness.store.addMessage("user", "project research");
  const session = harness.store.getActiveSession();

  await harness.store.setSessionPinned(session.id, true);
  await harness.store.setSessionProject(session.id, project.id);

  assert.equal(harness.store.getActiveSession().pinned, true);
  assert.equal(harness.store.getActiveSession().projectId, project.id);
  assert.equal(await harness.store.setSessionProject(session.id, "missing-project"), null);
  assert.equal(harness.store.getActiveSession().projectId, project.id);

  await harness.store.setSessionPinned(session.id, false);
  await harness.store.setSessionProject(session.id, "");

  assert.equal(harness.store.getActiveSession().pinned, false);
  assert.equal(harness.store.getActiveSession().projectId, "");
});

test("chat session store creates pins and deletes real projects", async () => {
  const harness = createHarness();

  await harness.store.hydrate();
  const project = await harness.store.createProject("ResonantOS Browser");
  await harness.store.addMessage("user", "project chat");
  const session = harness.store.getActiveSession();
  await harness.store.setSessionProject(session.id, project.id);
  await harness.store.setProjectPinned(project.id, true);

  assert.equal(harness.store.getProjects()[0].name, "ResonantOS Browser");
  assert.equal(harness.store.getProjects()[0].pinned, true);
  assert.equal(harness.store.getActiveSession().projectId, project.id);

  await harness.store.deleteProject(project.id);

  assert.equal(harness.store.getProjects().length, 0);
  assert.equal(harness.store.getActiveSession().projectId, "");
});

test("chat session store renames, expands, archives, and restores projects and chats", async () => {
  const harness = createHarness();

  await harness.store.hydrate();
  const project = await harness.store.createProject("Draft Project");
  await harness.store.renameProject(project.id, "Client Project");
  await harness.store.setProjectExpanded(project.id, false);
  await harness.store.addMessage("user", "project conversation");
  const session = harness.store.getActiveSession();
  await harness.store.renameSession(session.id, "Client Chat");
  await harness.store.setSessionProject(session.id, project.id);
  await harness.store.setSessionUnread(session.id, true);

  assert.equal(harness.store.getProjects()[0].name, "Client Project");
  assert.equal(harness.store.getProjects()[0].expanded, false);
  assert.equal(harness.store.getActiveSession().title, "Client Chat");
  assert.equal(harness.store.getActiveSession().unread, true);

  await harness.store.setSessionArchived(session.id, true);
  await harness.store.setProjectArchived(project.id, true);

  assert.ok(harness.store.getSessions().some((item) => item.id === session.id && item.archivedAt));
  assert.ok(harness.store.getProjects().some((item) => item.id === project.id && item.archivedAt));
  assert.notEqual(harness.store.getActiveSessionId(), session.id);

  await harness.store.setSessionArchived(session.id, false);
  await harness.store.setProjectArchived(project.id, false);

  assert.equal(harness.store.getSessions().find((item) => item.id === session.id).archivedAt, "");
  assert.equal(harness.store.getProjects().find((item) => item.id === project.id).archivedAt, "");
});

test("chat session store adds, deletes, forks, and trims messages", async () => {
  const harness = createHarness();

  const user = await harness.store.addMessage("user", "first");
  await harness.store.addMessage("assistant", "answer");
  const secondUser = await harness.store.addMessage("user", "second");
  await harness.store.addMessage("assistant", "second answer");

  assert.equal(user.id, "message-1");
  assert.equal(harness.store.getMessages().length, 4);

  const fork = await harness.store.forkFromMessage(secondUser.id);
  assert.equal(fork.sourceMessageId, secondUser.id);
  assert.equal(harness.store.getMessages().length, 3);
  assert.equal(harness.store.getForks().length, 1);

  await harness.store.deleteMessage(user.id);
  assert.equal(harness.store.findMessage(user.id), null);
});

test("chat session store forks whole sessions while preserving project context", async () => {
  const harness = createHarness();

  await harness.store.hydrate();
  const project = await harness.store.createProject("OpenCode");
  await harness.store.addMessage("user", "source conversation");
  const source = harness.store.getActiveSession();
  await harness.store.setSessionProject(source.id, project.id);
  await harness.store.setSessionPinned(source.id, true);

  const fork = await harness.store.forkSession(source.id);

  assert.equal(fork.sourceSessionId, source.id);
  assert.equal(harness.store.getMessages()[0].content, "source conversation");
  assert.equal(harness.store.getActiveSession().projectId, project.id);
  assert.equal(harness.store.getActiveSession().pinned, false);
  assert.match(harness.store.getActiveSession().title, /^Fork:/);
});

test("chat session store branches preserve compact memory and source references", async () => {
  const compactState = {
    threadId: "source-session",
    compactedAt: "2026-06-22T10:00:00.000Z",
    sourceRange: {
      fromMessageId: "message-a",
      toMessageId: "message-c"
    },
    userIntent: {
      goal: "Keep branch work aligned with the original compacted objective.",
      why: "The parent context was compacted before branching.",
      successCriteria: ["branch keeps compact context"],
      prioritySignals: ["avoid regression"],
      sourceMessageIds: ["message-a"]
    },
    workingSummary: "The user wants compact context copied into chat branches.",
    decisions: [{
      decisionId: "decision-1",
      decision: "Copy compact memory metadata at branch time.",
      reason: "Visible messages may no longer contain the original intent.",
      scope: "browser-first-session",
      status: "accepted",
      sourceMessageIds: ["message-b"],
      relatedDocPaths: ["docs/architecture/ADR-016-context-memory-compaction.md"]
    }],
    facts: [],
    preferences: [],
    openTasks: [{
      taskId: "task-1",
      description: "Add a deterministic branch regression test.",
      owner: "agent",
      status: "open",
      verificationRequired: ["browser-first store test"],
      sourceMessageIds: ["message-c"]
    }],
    artifacts: [{
      artifactId: "artifact-1",
      ref: "browser-first/test/chat-session-store.test.mjs",
      kind: "file",
      sourceMessageIds: ["message-c"]
    }],
    sourceReferences: [{
      messageId: "message-a",
      ref: "transcript:source-session:message-a"
    }],
    risks: [],
    unresolvedQuestions: [],
    preservedRecentMessageIds: ["message-b", "message-c"],
    checksum: "fnv32:test-compact-state"
  };
  const sourceReferences = [{
    messageId: "message-a",
    ref: "transcript:source-session:message-a"
  }];
  const harness = createHarness({
    sessions: [{
      id: "source-session",
      title: "Compacted parent",
      messages: [
        { id: "message-a", role: "user", content: "original intent", createdAt: "2026-06-22T09:00:00.000Z" },
        { id: "message-b", role: "assistant", content: "decision recorded", createdAt: "2026-06-22T09:01:00.000Z" },
        { id: "message-c", role: "user", content: "branch this", createdAt: "2026-06-22T09:02:00.000Z" }
      ],
      compactState,
      sourceReferences
    }],
    activeSessionId: "source-session"
  });

  await harness.store.hydrate();

  const wholeFork = await harness.store.forkSession("source-session");
  const wholeForkSession = harness.store.getActiveSession();

  assert.equal(wholeFork.sourceSessionId, "source-session");
  assert.deepEqual(wholeForkSession.compactState, compactState);
  assert.deepEqual(wholeForkSession.sourceReferences, sourceReferences);
  assert.notStrictEqual(wholeForkSession.compactState, compactState);
  assert.deepEqual(
    harness.writes.at(-1).sessions.find((session) => session.id === wholeFork.id).compactState,
    compactState
  );

  await harness.store.switchSession("source-session");
  const messageFork = await harness.store.forkFromMessage("message-c");
  const messageForkSession = harness.store.getActiveSession();

  assert.equal(messageFork.sourceMessageId, "message-c");
  assert.deepEqual(messageForkSession.compactState.userIntent, compactState.userIntent);
  assert.deepEqual(messageForkSession.compactState.decisions, compactState.decisions);
  assert.deepEqual(messageForkSession.compactState.openTasks, compactState.openTasks);
  assert.deepEqual(messageForkSession.compactState.artifacts, compactState.artifacts);
  assert.deepEqual(messageForkSession.compactState.sourceReferences, compactState.sourceReferences);
  assert.deepEqual(messageForkSession.sourceReferences, sourceReferences);
});

test("chat session store trims to previous user message for regeneration", async () => {
  const harness = createHarness();

  const user = await harness.store.addMessage("user", "first");
  const assistant = await harness.store.addMessage("assistant", "answer");

  const regeneratedFrom = await harness.store.trimToPreviousUserMessage(assistant.id);

  assert.equal(regeneratedFrom.id, user.id);
  assert.deepEqual(harness.store.getMessages().map((message) => message.id), [user.id]);
});

test("chat session store prepares overwrite regeneration without creating a branch", async () => {
  const harness = createHarness();

  const user = await harness.store.addMessage("user", "first");
  const assistant = await harness.store.addMessage("assistant", "answer");

  const prepared = await harness.store.prepareRegenerationFromMessage(assistant.id, { mode: "overwrite" });

  assert.equal(prepared.mode, "overwrite");
  assert.equal(prepared.userMessage.id, user.id);
  assert.deepEqual(harness.store.getMessages().map((message) => message.id), [user.id]);
  assert.equal(harness.store.getForks().length, 0);
});

test("chat session store prepares branch regeneration with compact state scoped to retained messages", async () => {
  const harness = createHarness({
    sessions: [{
      id: "session-source",
      title: "Source conversation",
      workspaceId: "answer",
      projectId: "project-a",
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
      messages: [
        { id: "u1", role: "user", content: "first", createdAt: "2026-05-25T00:01:00.000Z" },
        { id: "a1", role: "assistant", content: "answer", createdAt: "2026-05-25T00:02:00.000Z" },
        { id: "u2", role: "user", content: "second", createdAt: "2026-05-25T00:03:00.000Z" },
        { id: "a2", role: "assistant", content: "second answer", createdAt: "2026-05-25T00:04:00.000Z" }
      ],
      compactState: {
        summary: "first turn retained as summary",
        preservedRecentMessageIds: ["u1", "a1", "u2", "a2"],
        sourceRange: {
          fromMessageId: "u1",
          toMessageId: "a2"
        }
      }
    }],
    projects: [{ id: "project-a", name: "Project A" }],
    activeSessionId: "session-source"
  });

  await harness.store.hydrate();
  const prepared = await harness.store.prepareRegenerationFromMessage("a2", { mode: "branch" });

  assert.equal(prepared.mode, "branch");
  assert.equal(prepared.userMessage.id, "u2");
  assert.equal(prepared.fork.sourceSessionId, "session-source");
  assert.equal(prepared.fork.sourceMessageId, "a2");
  assert.deepEqual(harness.store.getMessages().map((message) => message.id), ["u1", "a1", "u2"]);

  const active = harness.store.getActiveSession();
  assert.notEqual(active.id, "session-source");
  assert.equal(active.projectId, "project-a");
  assert.match(active.title, /^Regenerate:/);
  assert.equal(active.compactState.summary, "first turn retained as summary");
  assert.deepEqual(active.compactState.preservedRecentMessageIds, ["u1", "a1", "u2"]);
  assert.deepEqual(active.compactState.sourceRange, {
    fromMessageId: "u1",
    toMessageId: "u2"
  });
});

test("chat session store manages attachments and persists selected provider settings", async () => {
  const harness = createHarness();

  await harness.store.addAttachments([{ id: "a", name: "a.md" }, { id: "b", name: "b.md" }]);
  assert.equal(harness.store.getAttachments().length, 2);

  await harness.store.removeAttachment("a");
  assert.deepEqual(harness.store.getAttachments().map((attachment) => attachment.id), ["b"]);

  await harness.store.clearAttachments();
  assert.equal(harness.store.getAttachments().length, 0);
  assert.equal(harness.writes.at(-1).model, "MiniMax-M3");
  assert.equal(harness.writes.at(-1).thinkingDepth, "high");
});
