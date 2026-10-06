// #410: compose the scheme-only readability check with the site-permission
// store. A tab whose site the user set to "blocked" in Settings is still
// http(s), so it passes isControllableTabUrl and would appear in the @tab
// typeahead and resolve into a mention — only to fail later at capture time.
// Filtering here keeps blocked sites out of the addressable set entirely.
//
// The blocked-site set is supplied by a getter (not awaited here) so this
// predicate stays synchronous for use inside `Array.prototype.filter`; the
// caller keeps the set fresh from the site-permission store.
//
// The blocked set is filled asynchronously from storage, so it starts empty.
// `isPermissionsLoaded` lets the predicate FAIL CLOSED during that window: until
// the first load resolves, any keyable (blockable) site is treated as blocked,
// so a blocked site is never listed before its permission is known. It defaults
// to () => true so existing callers that keep the set eagerly fresh are
// unaffected.
export function createReadableUnblockedTab({
  isReadableBrowserTab = () => false,
  siteKeyForUrl = () => "",
  getBlockedSiteKeys = () => new Set(),
  isPermissionsLoaded = () => true
} = {}) {
  return (tab) => {
    if (!isReadableBrowserTab(tab)) return false;
    const key = siteKeyForUrl(tab?.url ?? "");
    if (!key) return true; // unparseable host can't be blocked (blocking needs a key)
    // Not yet known → treat as blocked (a keyable site could be blocked once the
    // snapshot loads). This closes the "starts open" gap where blocked sites
    // appeared until the first asynchronous load completed.
    if (!isPermissionsLoaded()) return false;
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
