export function createSidePanelChatHydration(dependencies) {
  const {
    chatSessionStore,
    hydrateControlPreflight,
    hydrateProviderModelOptions,
    readPersonalizationSettings,
    renderAttachments,
    renderMessages,
    setContextDockExpanded,
    setContextMeter,
    setPersonalizationSettings,
    storage,
    storageKeys,
    updateConnectionLine
  } = dependencies;

  return {
    async hydrateChatSettings() {
      await hydrateProviderModelOptions();
      await chatSessionStore.hydrate();
      setPersonalizationSettings(await readPersonalizationSettings(storage, storageKeys));
      const settings = await storage?.get?.([storageKeys.contextDockExpanded]).catch(() => ({}));
      setContextDockExpanded(Boolean(settings?.[storageKeys.contextDockExpanded]));
      await hydrateControlPreflight();
      renderMessages();
      renderAttachments();
      updateConnectionLine();
      setContextMeter();
    }
  };
}
