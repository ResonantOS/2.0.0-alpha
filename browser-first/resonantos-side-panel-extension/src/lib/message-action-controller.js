export function fileLooksTextLike(file) {
  return /^(text\/|application\/(json|xml|javascript|typescript))/i.test(file.type) ||
    /\.(md|txt|json|csv|ts|tsx|js|jsx|css|html|xml|yaml|yml)$/i.test(file.name);
}

export function createMessageActionController({
  addMessage,
  bridgeRequest,
  // Optional getter for late-bound bridge client. The rebind chain
  // sets the module-level `bridgeRequest` *after* this controller is
  // constructed, so passing a value here captures a stale `null`.
  getBridgeRequest,
  chatSessionStore,
  commandInput,
  composerController,
  fileInput,
  flashCopied,
  getLastSnapshot,
  getRegenerationMode,
  getRespondToCommand,
  navigator,
  renderAttachments,
  renderMessages,
  setStatus
}) {
  // Resolve at call time. The rebind chain sets the module-level
  // `bridgeRequest` *after* this controller is constructed, so a
  // captured value can be a stale `null`. The getter wins when set.
  // We accept the same args as bridgeRequest and forward them so call
  // sites can do `await bridgeRequestCurrent(path, options)` directly.
  const bridgeRequestCurrent = (...args) => {
    const fn = typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest;
    return fn(...args);
  };
  const selectedRegenerationMode = () => getRegenerationMode?.() === "overwrite" ? "overwrite" : "branch";
  async function clearAttachments() {
    await chatSessionStore.clearAttachments();
    renderAttachments();
  }

  async function copyMessage(id) {
    const message = chatSessionStore.findMessage(id);
    if (!message) return;
    const copied = await navigator.clipboard?.writeText?.(message.content).then(() => true).catch(() => false);
    if (!copied) {
      const ownerDocument = commandInput?.ownerDocument ?? globalThis.document;
      const previousActiveElement = ownerDocument?.activeElement;
      const scratch = ownerDocument?.createElement?.("textarea");
      if (scratch) {
        scratch.value = message.content;
        scratch.setAttribute("readonly", "");
        scratch.style.position = "fixed";
        scratch.style.opacity = "0";
        ownerDocument.body.append(scratch);
        scratch.select();
        ownerDocument.execCommand?.("copy");
        scratch.remove();
        previousActiveElement?.focus?.();
      }
    }
    flashCopied(id);
    setStatus("Copied");
  }

  async function forkFromMessage(id) {
    const fork = await chatSessionStore.forkFromMessage(id);
    if (!fork) return;
    renderMessages();
    setStatus("Forked");
  }

  async function deleteMessage(id) {
    await chatSessionStore.deleteMessage(id);
    renderMessages();
    setStatus("Deleted");
  }

  function editMessage(id) {
    const message = chatSessionStore.findMessage(id);
    if (!message || message.role !== "user") return;
    commandInput.value = message.content;
    composerController.resetUndoStack(message.content);
    commandInput.focus();
    setStatus("Editing");
  }

  async function saveMessageToArchive(id) {
    const message = chatSessionStore.findMessage(id);
    if (!message) return;
    setStatus("Saving");
    try {
      const result = await bridgeRequestCurrent("/archive/intake", {
        method: "POST",
        body: {
          title: `Augmentor message ${new Date(message.createdAt).toLocaleString()}`,
          content: message.content,
          sourceMessageId: message.id,
          url: getLastSnapshot()?.url ?? null
        }
      });
      await addMessage("system", `Saved to Living Archive intake: ${result.path}`);
      setStatus("Ready");
    } catch (error) {
      setStatus("Archive failed");
      await addMessage("system", error instanceof Error ? error.message : String(error));
    }
  }

  async function showMessageStats(id) {
    const message = chatSessionStore.findMessage(id);
    if (!message?.usage) {
      await addMessage("system", "No generation telemetry is available for this message.");
      return;
    }
    await addMessage("system", `Generation stats:\n${JSON.stringify(message.usage, null, 2)}`);
  }

  async function regenerateFromMessage(id) {
    const prepared = await chatSessionStore.prepareRegenerationFromMessage(id, {
      mode: selectedRegenerationMode()
    });
    if (!prepared?.userMessage) {
      await addMessage("system", "No previous user message is available for regeneration.");
      return;
    }
    renderMessages();
    setStatus(prepared.mode === "overwrite" ? "Regenerating" : "Regenerating branch");
    await getRespondToCommand()(prepared.userMessage.content);
  }

  async function attachFiles(fileList) {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    const nextAttachments = [];
    for (const [index, file] of files.entries()) {
      let content = "";
      if (fileLooksTextLike(file) && file.size <= 64 * 1024) {
        content = (await file.text()).slice(0, 12000);
      }
      nextAttachments.push({
        id: `${file.name}-${file.size}-${Date.now()}-${index}`,
        name: file.name,
        size: file.size,
        type: file.type,
        summary: `${Math.round(file.size / 1024)} KB${content ? " · embedded text" : " · metadata only"}`,
        content
      });
    }
    await chatSessionStore.addAttachments(nextAttachments);
    if (fileInput) {
      fileInput.value = "";
    }
    renderAttachments();
    setStatus("Attached");
  }

  return {
    attachFiles,
    clearAttachments,
    copyMessage,
    deleteMessage,
    editMessage,
    forkFromMessage,
    regenerateFromMessage,
    saveMessageToArchive,
    showMessageStats
  };
}
