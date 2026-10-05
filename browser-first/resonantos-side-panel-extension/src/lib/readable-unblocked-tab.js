// #410: compose the scheme-only readability check with the site-permission
// store. A tab whose site the user set to "blocked" in Settings is still
// http(s), so it passes isControllableTabUrl and would appear in the @tab
// typeahead and resolve into a mention — only to fail later at capture time.
// Filtering here keeps blocked sites out of the addressable set entirely.
//
// The blocked-site set is supplied by a getter (not awaited here) so this
// predicate stays synchronous for use inside `Array.prototype.filter`; the
// caller keeps the set fresh from the site-permission store.
export function createReadableUnblockedTab({
  isReadableBrowserTab = () => false,
  siteKeyForUrl = () => "",
  getBlockedSiteKeys = () => new Set()
} = {}) {
  return (tab) => {
    if (!isReadableBrowserTab(tab)) return false;
    const key = siteKeyForUrl(tab?.url ?? "");
    if (!key) return true; // unparseable host can't be blocked (blocking needs a key)
    return !getBlockedSiteKeys().has(key);
  };
}

// Derive the set of blocked site keys from a raw site-permissions map
// ({ [siteKey]: mode }) as stored by createSitePermissionStore.
export function blockedSiteKeysFromPermissions(permissions) {
  return new Set(
    Object.entries(permissions ?? {})
      .filter(([, mode]) => mode === "blocked")
      .map(([key]) => key)
  );
}
