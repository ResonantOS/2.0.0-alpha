export function createSitePermissionStore({
  storage,
  sitePermissionAuditStorageKey = "augmentorSitePermissionAudit",
  sitePermissionStorageKey,
  now = Date.now
}) {
  const siteKeyForUrl = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };

  const sitePermissions = async () => {
    const result = await storage?.get?.(sitePermissionStorageKey).catch(() => ({}));
    return result?.[sitePermissionStorageKey] ?? {};
  };

  const readSitePermissions = async () => {
    try {
      if (typeof storage?.get !== "function") throw new Error();
      const result = await storage.get(sitePermissionStorageKey);
      return result?.[sitePermissionStorageKey] ?? {};
    } catch {
      const error = new Error("Site permissions could not be read.");
      error.code = "site-permissions-unavailable";
      throw error;
    }
  };

  const sitePermissionAudit = async () => {
    const result = await storage?.get?.(sitePermissionAuditStorageKey).catch(() => ({}));
    return result?.[sitePermissionAuditStorageKey] ?? {};
  };

  const appendAudit = async ({ key, action, mode = "", previousMode = "", reason = "", source = "human" }) => {
    if (!key) return null;
    const audit = await sitePermissionAudit();
    const entry = {
      action,
      at: now(),
      key,
      mode,
      previousMode,
      reason: String(reason || action).slice(0, 240),
      source: String(source || "human").slice(0, 80)
    };
    audit[key] = [entry, ...(audit[key] ?? [])].slice(0, 20);
    await storage?.set?.({ [sitePermissionAuditStorageKey]: audit });
    return entry;
  };

  const permissionForUrl = async (url) => {
    const key = siteKeyForUrl(url);
    const permissions = await readSitePermissions();
    if (!key) return "ask-before-action";
    return permissions[key] ?? "ask-before-action";
  };

  const setSitePermission = async (url, mode, { reason = "Site permission changed", source = "human" } = {}) => {
    const key = siteKeyForUrl(url);
    if (!key) throw new Error("No site is active.");
    const permissions = await readSitePermissions();
    const previousMode = permissions[key] ?? "ask-before-action";
    permissions[key] = mode;
    await storage?.set?.({ [sitePermissionStorageKey]: permissions });
    const audit = await appendAudit({ key, action: "set", mode, previousMode, reason, source });
    return { audit, key, mode, previousMode };
  };

  const resetSitePermission = async (siteKeyOrUrl, { reason = "Site permission reset", source = "human" } = {}) => {
    const key = String(siteKeyOrUrl ?? "").includes("://") ? siteKeyForUrl(siteKeyOrUrl) : String(siteKeyOrUrl ?? "");
    if (!key) return false;
    const permissions = await readSitePermissions();
    const existed = Object.hasOwn(permissions, key);
    const previousMode = permissions[key] ?? "ask-before-action";
    delete permissions[key];
    await storage?.set?.({ [sitePermissionStorageKey]: permissions });
    if (existed) {
      await appendAudit({ key, action: "reset", mode: "ask-before-action", previousMode, reason, source });
    }
    return existed;
  };

  return {
    permissionForUrl,
    readSitePermissions,
    resetSitePermission,
    setSitePermission,
    sitePermissionAudit,
    siteKeyForUrl,
    sitePermissions
  };
}
