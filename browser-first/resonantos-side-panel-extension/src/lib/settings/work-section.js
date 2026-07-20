import { metricCard, noteCard, safeErrorMessage, settingsHeader, setStatus } from "./settings-common.js";

function itemTitle(item) {
  return item.name || item.title || "Untitled";
}

function formatTime(value) {
  if (!value) return "recently";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "recently";
}

function projectName(projects, projectId) {
  if (!projectId) return "No project";
  return projects.find((project) => project.id === projectId)?.name ?? "Missing project";
}

function confirmableButton({ label, confirmLabel = "Confirm", onConfirm }) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    if (button.dataset.confirm === "true") {
      void onConfirm();
      return;
    }
    button.dataset.confirm = "true";
    button.textContent = confirmLabel;
  });
  return button;
}

function archivedItem({ item, type, onRestore, onOpen }) {
  const row = document.createElement("li");
  row.className = "settings-archive-row";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = itemTitle(item);
  const meta = document.createElement("small");
  meta.textContent = `${type} archived ${formatTime(item.archivedAt)}`;
  copy.append(title, meta);
  const restore = document.createElement("button");
  restore.type = "button";
  restore.textContent = "Restore";
  restore.addEventListener("click", () => void onRestore(item.id));
  if (type === "Chat") {
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open";
    open.addEventListener("click", () => void onOpen(item.id));
    row.append(copy, restore, open);
  } else {
    row.append(copy, restore);
  }
  return row;
}

function projectSelector({ projects, value, onChange }) {
  const select = document.createElement("select");
  select.className = "settings-work-project-select";
  select.setAttribute("aria-label", "Chat project assignment");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No project";
  select.append(none);
  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    select.append(option);
  }
  select.value = value || "";
  select.addEventListener("change", () => void onChange(select.value));
  return select;
}

function activeChatRow({ session, projects, onArchive, onDelete, onMove, onOpen }) {
  const row = document.createElement("li");
  row.className = "settings-work-row";
  row.dataset.type = "chat";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = itemTitle(session);
  const meta = document.createElement("small");
  meta.textContent = `Chat · ${projectName(projects, session.projectId)} · updated ${formatTime(session.updatedAt || session.createdAt)}`;
  copy.append(title, meta);
  const move = projectSelector({
    projects,
    value: session.projectId,
    onChange: (projectId) => onMove(session.id, projectId)
  });
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open";
  open.addEventListener("click", () => void onOpen(session.id));
  const archive = document.createElement("button");
  archive.type = "button";
  archive.textContent = "Archive";
  archive.addEventListener("click", () => void onArchive(session.id));
  const del = confirmableButton({
    label: "Delete",
    confirmLabel: "Confirm delete",
    onConfirm: () => onDelete(session.id)
  });
  row.append(copy, move, open, archive, del);
  return row;
}

function activeProjectRow({ project, sessions, onArchive, onDelete, onPin, onRename }) {
  const row = document.createElement("li");
  row.className = "settings-work-row";
  row.dataset.type = "project";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = itemTitle(project);
  const count = sessions.filter((session) => session.projectId === project.id).length;
  const meta = document.createElement("small");
  meta.textContent = `Project · ${count} chat${count === 1 ? "" : "s"} · ${project.pinned ? "pinned" : "not pinned"} · updated ${formatTime(project.updatedAt || project.createdAt)}`;
  copy.append(title, meta);
  const renameForm = document.createElement("form");
  renameForm.className = "settings-work-rename-form";
  const renameInput = document.createElement("input");
  renameInput.name = "projectRename";
  renameInput.value = project.name || "";
  renameInput.setAttribute("aria-label", `Rename ${project.name || "project"}`);
  const rename = document.createElement("button");
  rename.type = "submit";
  rename.textContent = "Rename";
  renameForm.append(renameInput, rename);
  renameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void onRename(project.id, renameInput.value.trim());
  });
  const pin = document.createElement("button");
  pin.type = "button";
  pin.textContent = project.pinned ? "Unpin" : "Pin";
  pin.addEventListener("click", () => void onPin(project.id, !project.pinned));
  const archive = document.createElement("button");
  archive.type = "button";
  archive.textContent = "Archive";
  archive.addEventListener("click", () => void onArchive(project.id));
  const del = confirmableButton({
    label: "Delete",
    confirmLabel: "Confirm delete",
    onConfirm: () => onDelete(project.id)
  });
  row.append(copy, renameForm, pin, archive, del);
  return row;
}

function artifactManagementPanel({ bridgeRequest, getBridgeRequest }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const section = document.createElement("section");
  section.className = "settings-note settings-work-artifacts";
  let artifacts = [];
  let artifactQuery = "";
  const heading = document.createElement("strong");
  heading.textContent = "Artifact Management";
  const body = document.createElement("p");
  body.textContent = "Search and preview recent intake artifacts, copy evidence paths, or create Living Archive review requests without leaving Settings.";
  const status = document.createElement("p");
  status.className = "settings-status";
  const actions = document.createElement("div");
  actions.className = "settings-work-artifact-actions";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Filter artifacts";
  search.setAttribute("aria-label", "Filter intake artifacts");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Load artifacts";
  const list = document.createElement("ol");
  list.className = "settings-archive-list";
  const preview = document.createElement("article");
  preview.className = "settings-work-artifact-preview";
  preview.hidden = true;
  actions.append(search, refresh);
  section.append(heading, body, actions, status, list, preview);

  const copyArtifactPath = async (path) => {
    try {
      await navigator.clipboard?.writeText?.(path);
      setStatus(status, `Copied artifact path: ${path}`, "success");
    } catch {
      setStatus(status, `Artifact path: ${path}`, "warning");
    }
  };

  const requestReview = async (artifact) => {
    setStatus(status, `Creating review request for ${artifact.path}...`);
    try {
      const result = await bridge()("/archive/review/request", {
        method: "POST",
        body: {
          path: artifact.path,
          reason: "Review this intake artifact from Settings for possible Living Archive ingestion, contradictions, entities, and durable wiki updates."
        }
      });
      setStatus(status, `Review request created: ${result.path}.`, "success");
    } catch (error) {
      setStatus(status, safeErrorMessage(error), "error");
    }
  };

  const previewArtifact = async (artifact) => {
    preview.hidden = false;
    preview.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = artifact.title || "Artifact preview";
    const loading = document.createElement("p");
    loading.textContent = `Loading ${artifact.path}...`;
    preview.append(title, loading);
    setStatus(status, `Loading preview for ${artifact.path}...`);
    try {
      const result = await bridge()("/archive/intake/read", {
        method: "POST",
        body: { path: artifact.path }
      });
      const meta = document.createElement("small");
      meta.textContent = `${result.kind || artifact.kind || "intake"} · ${result.path || artifact.path}`;
      const content = document.createElement("pre");
      content.textContent = result.content || result.excerpt || "No preview content returned.";
      preview.replaceChildren(title, meta, content);
      setStatus(status, `Preview loaded: ${result.path || artifact.path}.`, "success");
    } catch (error) {
      preview.hidden = true;
      preview.replaceChildren();
      setStatus(status, safeErrorMessage(error), "error");
    }
  };

  const artifactRow = (artifact) => {
    const row = document.createElement("li");
    row.className = "settings-archive-row";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = artifact.title || "Untitled artifact";
    const meta = document.createElement("small");
    meta.textContent = `${artifact.kind || "intake"} · ${artifact.path || "unknown path"}`;
    copy.append(title, meta);
    const pathButton = document.createElement("button");
    pathButton.type = "button";
    pathButton.textContent = "Copy path";
    pathButton.addEventListener("click", () => void copyArtifactPath(artifact.path));
    const review = document.createElement("button");
    review.type = "button";
    review.textContent = "Request review";
    review.addEventListener("click", () => void requestReview(artifact));
    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.textContent = "Preview";
    previewButton.addEventListener("click", () => void previewArtifact(artifact));
    row.append(copy, previewButton, pathButton, review);
    return row;
  };

  const renderArtifacts = () => {
    list.replaceChildren();
    const query = artifactQuery.toLowerCase();
    const visible = artifacts.filter((artifact) => [
      artifact.title,
      artifact.kind,
      artifact.path,
      artifact.excerpt
    ].filter(Boolean).join(" ").toLowerCase().includes(query));
    if (!visible.length) {
      const empty = document.createElement("li");
      empty.className = "settings-work-empty";
      empty.textContent = artifacts.length ? "No artifacts match this filter." : "No intake artifacts loaded yet.";
      list.append(empty);
      return;
    }
    list.append(...visible.map(artifactRow));
  };

  const loadArtifacts = async () => {
    refresh.disabled = true;
    preview.hidden = true;
    preview.replaceChildren();
    setStatus(status, "Loading intake artifacts...");
    try {
      const result = await bridge()("/archive/intake/list", {
        method: "POST",
        body: { limit: 8 }
      });
      artifacts = Array.isArray(result.entries) ? result.entries : [];
      if (!artifacts.length) {
        renderArtifacts();
        setStatus(status, "No intake artifacts found yet.", "warning");
        return;
      }
      renderArtifacts();
      setStatus(status, `${artifacts.length} artifact(s) available from ${result.root}.`, "success");
    } catch (error) {
      setStatus(status, safeErrorMessage(error), "error");
    } finally {
      refresh.disabled = false;
    }
  };

  search.addEventListener("input", () => {
    artifactQuery = search.value.trim();
    renderArtifacts();
  });
  refresh.addEventListener("click", () => void loadArtifacts());
  void loadArtifacts();
  return section;
}

function matchesQuery(item, query, projects = []) {
  if (!query) return true;
  const haystack = [
    itemTitle(item),
    item.id,
    item.projectId ? projectName(projects, item.projectId) : ""
  ].join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export function renderWorkSection(container, { bridgeRequest, getBridgeRequest, chatSessionStore, onOpenSession, onRestore }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  if (!chatSessionStore) {
    container.replaceChildren(
      settingsHeader({
        eyebrow: "Chats and projects",
        title: "Saved Work",
        body: "Manage archived chats, projects, and artifacts from one place."
      }),
      noteCard({
        title: "Work store unavailable",
        body: "The chat/project store is not connected in this runtime.",
        tone: "warning"
      })
    );
    return;
  }

  let query = "";
  const panel = document.createElement("section");
  panel.className = "settings-work-manager";
  const status = document.createElement("p");
  status.className = "settings-status";

  const renderBody = () => {
    const sessions = chatSessionStore.getSessions?.() ?? [];
    const projects = chatSessionStore.getProjects?.() ?? [];
    const activeChats = sessions.filter((session) => !session.archivedAt && matchesQuery(session, query, projects));
    const activeProjects = projects.filter((project) => !project.archivedAt && matchesQuery(project, query));
    const archivedChats = sessions.filter((session) => session.archivedAt && matchesQuery(session, query, projects));
    const archivedProjects = projects.filter((project) => project.archivedAt && matchesQuery(project, query));

    const metrics = document.createElement("div");
    metrics.className = "settings-health-grid";
    metrics.append(
      metricCard({ label: "Active chats", value: String(activeChats.length), detail: "visible conversations" }),
      metricCard({ label: "Projects", value: String(activeProjects.length), detail: "active work containers" }),
      metricCard({ label: "Archived", value: String(archivedChats.length + archivedProjects.length), detail: "restorable work objects" })
    );

    const tools = document.createElement("form");
    tools.className = "settings-work-tools";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search chats and projects";
    search.value = query;
    search.setAttribute("aria-label", "Search chats and projects");
    search.addEventListener("input", () => {
      query = search.value.trim();
      renderBody();
      search.focus();
    });
    const projectNameInput = document.createElement("input");
    projectNameInput.name = "projectName";
    projectNameInput.placeholder = "New project name";
    projectNameInput.setAttribute("aria-label", "New project name");
    const createProject = document.createElement("button");
    createProject.type = "submit";
    createProject.textContent = "Create project";
    tools.append(search, projectNameInput, createProject);
    tools.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = projectNameInput.value.trim();
      if (name.length < 2) {
        setStatus(status, "Project name needs at least 2 characters.", "warning");
        return;
      }
      await chatSessionStore.createProject?.(name);
      setStatus(status, `Created project: ${name}`, "success");
      renderBody();
    });

    const activeList = document.createElement("ol");
    activeList.className = "settings-work-list";
    const rerender = () => {
      onRestore?.();
      renderBody();
    };
    const archiveChat = async (id) => {
      await chatSessionStore.setSessionArchived?.(id, true);
      setStatus(status, "Chat archived.", "success");
      rerender();
    };
    const deleteChat = async (id) => {
      await chatSessionStore.deleteSession?.(id);
      setStatus(status, "Chat deleted.", "success");
      rerender();
    };
    const moveChat = async (id, projectId) => {
      await chatSessionStore.setSessionProject?.(id, projectId);
      setStatus(status, projectId ? "Chat moved into project." : "Chat moved out of project.", "success");
      rerender();
    };
    const openChat = async (id) => {
      await onOpenSession?.(id);
    };
    const archiveProject = async (id) => {
      await chatSessionStore.setProjectArchived?.(id, true);
      setStatus(status, "Project archived.", "success");
      rerender();
    };
    const renameProject = async (id, name) => {
      if (name.length < 2) {
        setStatus(status, "Project name needs at least 2 characters.", "warning");
        return;
      }
      await chatSessionStore.renameProject?.(id, name);
      setStatus(status, `Project renamed: ${name}`, "success");
      rerender();
    };
    const setProjectPinned = async (id, pinned) => {
      await chatSessionStore.setProjectPinned?.(id, pinned);
      setStatus(status, pinned ? "Project pinned." : "Project unpinned.", "success");
      rerender();
    };
    const deleteProject = async (id) => {
      await chatSessionStore.deleteProject?.(id);
      setStatus(status, "Project deleted and chats moved out.", "success");
      rerender();
    };

    activeProjects.forEach((project) => {
      activeList.append(activeProjectRow({ project, sessions, onArchive: archiveProject, onDelete: deleteProject, onPin: setProjectPinned, onRename: renameProject }));
    });
    activeChats.forEach((session) => {
      activeList.append(activeChatRow({ session, projects: activeProjects, onArchive: archiveChat, onDelete: deleteChat, onMove: moveChat, onOpen: openChat }));
    });
    if (!activeList.children.length) {
      const empty = document.createElement("li");
      empty.className = "settings-work-empty";
      empty.textContent = query ? "No active chats or projects match this search." : "No active chats or projects yet.";
      activeList.append(empty);
    }

    const archive = document.createElement("section");
    archive.className = "settings-note settings-archive";
    const archiveTitle = document.createElement("strong");
    archiveTitle.textContent = "Archived chats and projects";
    const archiveBody = document.createElement("p");
    archiveBody.textContent = archivedChats.length || archivedProjects.length
      ? "Restore archived work when you need it back in the sidebar."
      : "No archived chats or projects match this view.";
    const archiveList = document.createElement("ol");
    archiveList.className = "settings-archive-list";
    const restoreChat = async (id) => {
      await chatSessionStore.setSessionArchived?.(id, false);
      setStatus(status, "Chat restored.", "success");
      rerender();
    };
    const restoreProject = async (id) => {
      await chatSessionStore.setProjectArchived?.(id, false);
      setStatus(status, "Project restored.", "success");
      rerender();
    };
    const openArchivedChat = async (id) => {
      await chatSessionStore.setSessionArchived?.(id, false);
      await onOpenSession?.(id);
      rerender();
    };
    for (const project of archivedProjects) {
      archiveList.append(archivedItem({ item: project, type: "Project", onRestore: restoreProject, onOpen: onOpenSession }));
    }
    for (const chat of archivedChats) {
      archiveList.append(archivedItem({ item: chat, type: "Chat", onRestore: restoreChat, onOpen: openArchivedChat }));
    }
    archive.append(archiveTitle, archiveBody, archiveList);

    panel.replaceChildren(
      metrics,
      tools,
      status,
      noteCard({
        title: "Active work",
        body: "Move chats between projects, open active chats, archive completed work, or delete work after confirmation."
      }),
      activeList,
      archive,
      artifactManagementPanel({ bridgeRequest, getBridgeRequest })
    );
  };

  container.replaceChildren(
    settingsHeader({
      eyebrow: "Chats, projects, artifacts",
      title: "Saved Work",
      body: "Manage chats and project containers without overcrowding the main workspace. Artifacts stay visible in the Artifacts workspace while deeper export controls are added."
    }),
    panel
  );
  renderBody();
}
