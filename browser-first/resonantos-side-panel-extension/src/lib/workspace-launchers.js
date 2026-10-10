const WORKSPACE_COMMAND = 'open-resonantos-workspace';
export function installWorkspaceLaunchers({ chromeApi, openWorkspace }) {
  const open = tab => Promise.resolve().then(() =>
    openWorkspace({ windowId: tab?.windowId })).catch(() => undefined);
  const installMenu = async () => {
    if (!chromeApi.contextMenus) return;
    await chromeApi.contextMenus.remove(WORKSPACE_COMMAND).catch(() => undefined);
    await new Promise(resolve => chromeApi.contextMenus.create({
      id: WORKSPACE_COMMAND, title: 'Open ResonantOS workspace', contexts: ['action']
    }, () => { void chromeApi.runtime.lastError; resolve(); }));
  };
  chromeApi.runtime.onInstalled.addListener(installMenu);
  chromeApi.runtime.onStartup.addListener(installMenu);
  chromeApi.commands.onCommand.addListener((command, tab) => {
    if (command === WORKSPACE_COMMAND) return open(tab);
  });
  chromeApi.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === WORKSPACE_COMMAND) return open(tab);
  });
}
