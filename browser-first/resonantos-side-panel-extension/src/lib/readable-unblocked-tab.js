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

// #410/#509: own the blocked-site snapshot and its "loaded" flag in one tested
// place. The snapshot takes the site-permission STORE (not a reader function) and
// reaches for its STRICT readSitePermissions by name, so the reader choice lives
// here, not at the call site: the lenient sitePermissions() — which resolves a
// failed read to {} — cannot be substituted in, and the snapshot and its
// siteKeyForUrl come from the same store so they cannot drift apart. The strict
// reader REJECTS on a failed storage read; on any read error refresh() fails
// closed — the loaded flag goes (and stays) false, so the predicate withholds
// every keyable site — then rethrows so the caller's .catch can log/notify. (A
// reader that resolved a failed read to {} would instead set loaded = true with an
// empty blocked set and list every site, including blocked ones, in the @tab
// typeahead and resolver; that readSitePermissions rejects while sitePermissions
// swallows is pinned in site-permission-store.test.mjs.) A store missing either
// method is rejected at construction, so a miswire fails loudly here rather than
// silently failing open.
export function createBlockedSiteSnapshot({
  isReadableBrowserTab = () => false,
  sitePermissionStore
} = {}) {
  if (
    typeof sitePermissionStore?.readSitePermissions !== "function" ||
    typeof sitePermissionStore?.siteKeyForUrl !== "function"
  ) {
    throw new TypeError(
      "createBlockedSiteSnapshot requires a site-permission store exposing readSitePermissions() and siteKeyForUrl()."
    );
  }
  let blockedSiteKeys = new Set();
  let loaded = false;
  const isReadableUnblockedTab = createReadableUnblockedTab({
    isReadableBrowserTab,
    siteKeyForUrl: sitePermissionStore.siteKeyForUrl,
    getBlockedSiteKeys: () => blockedSiteKeys,
    isPermissionsLoaded: () => loaded
  });
  const refresh = async () => {
    try {
      // Strict reader, selected by name: the lenient sitePermissions() cannot be
      // passed in from the call site.
      blockedSiteKeys = blockedSiteKeysFromPermissions(await sitePermissionStore.readSitePermissions());
      loaded = true;
    } catch (error) {
      loaded = false; // fail closed: cannot know what is blocked, so withhold all
      throw error;
    }
  };
  return { isReadableUnblockedTab, refresh };
}

// #410: keep an open @tab typeahead honest across site-permission changes. On
// each change to the permission store, refresh the blocked-site snapshot and
// then close any open popup, so it cannot keep showing a site that was just
// blocked; the next keystroke reopens the list filtered against the fresh set.
// `onChanged` is chrome.storage.onChanged in production (a fake exposing
// addListener in tests). Extracted from side-panel.js so this seam is testable
// against a real typeahead rather than only asserted as source text.
export function wireBlockedSiteTypeahead({
  onChanged,
  storageArea = "local",
  storageKey,
  refreshBlockedSiteKeys,
  typeahead
} = {}) {
  onChanged?.addListener?.((changes, area) => {
    if (area !== storageArea || !changes?.[storageKey]) return;
    // Refresh first, then close: the close is what the user sees immediately,
    // and the refreshed set governs the reopen. A failed read fails closed —
    // the predicate keeps treating keyable sites as blocked — so we swallow the
    // rejection (no unhandled rejection) but still close, so a failed read can't
    // strand a stale popup open.
    void Promise.resolve(refreshBlockedSiteKeys?.())
      .catch(() => undefined)
      .finally(() => typeahead?.close?.());
  });
}
