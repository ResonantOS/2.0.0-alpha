// Augmentor shortcut controller (issue #241)
// Pure / testable. Detects Alt+A (open + focus) and Alt+S (page summary) keypresses
// from a top-frame KeyboardEvent, classifies conflict states, and inspects a
// stored summary context for staleness against the current tab identity.
//
// Key identification uses `event.code` (KeyA / KeyS) rather than `event.key`.
// `event.code` reports the physical key independent of OS modifier mapping
// or input layout (US/UK/EU/Dvorak all produce KeyA when the user presses
// the QWERTY-A position). On macOS, Option+A produces `event.key === "å"`,
// not `"a"`, so a key-based match would silently fail on macOS.
//
// Does NOT mutate the DOM. The caller (content.js keydown handler) decides what
// to render. Keeping this pure lets the unit test cover all five ACs without a
// JSDOM-and-Chrome sandbox.
//
// Conflict classification:
//   - exact       : bare Alt+(A|S) on a non-editable target
//   - editing     : the focused target is an editable input/textarea/contenteditable
//   - composed    : the event is still composing (IME in progress)
//   - combined    : event had metaKey/ctrlKey/shiftKey modifier also pressed,
//                   except the documented Alt+Shift+A side-panel command
//   - restricted  : the page is one we never dispatch from (chrome://, about:, etc.)
//   - none        : not a recognized shortcut for Augmentor

(() => {
  if (globalThis.ResonantOSAugmentorShortcutController) return;

  const FALLBACK_RESTRICTED_SCHEMES = Object.freeze(["chrome:", "about:", "edge:", "devtools:"]);
  const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

  const isEditableTarget = (target) => {
    if (!target || typeof target !== "object") return false;
    if (EDITABLE_TAGS.has(target.tagName)) {
      // do not steal Alt+A / Alt+S from real form fields
      return target.isContentEditable !== true;
    }
    return target.isContentEditable === true;
  };

  const isRestrictedScheme = (href) => {
    if (typeof href !== "string") return false;
    const lowered = href.trim().toLowerCase();
    if (!lowered) return false;
    const gateSchemes = globalThis.ResonantOSInlineActionSurfaceGate?.INLINE_RESTRICTED_SCHEMES;
    const restrictedSchemes = Array.isArray(gateSchemes) ? gateSchemes : FALLBACK_RESTRICTED_SCHEMES;
    return restrictedSchemes.some((prefix) => lowered.startsWith(String(prefix).toLowerCase()));
  };

  const hasAuxiliaryModifiers = (event) => Boolean(
    event && (event.metaKey || event.ctrlKey || event.shiftKey)
  );

  const isDocumentedSidePanelCommand = (event) => Boolean(
    event && event.altKey === true && event.shiftKey === true &&
      event.ctrlKey !== true && event.metaKey !== true && event.code === "KeyA"
  );

  // Map event.code to the canonical key identity. KeyboardEvent.code values
  // are layout-independent (QWERTY-A is always "KeyA" regardless of OS
  // modifier mapping or input layout). Returns "" for unknown / missing codes.
  const codeToAction = (event) => {
    if (!event || typeof event.code !== "string") return "";
    if (event.code === "KeyA") return "alt-a";
    if (event.code === "KeyS") return "alt-s";
    return "";
  };

  /**
   * @param {KeyboardEvent|{code?:string, key?:string, altKey?:boolean, metaKey?:boolean, ctrlKey?:boolean, shiftKey?:boolean, isComposing?:boolean, target?:object}} event
   * @param {{locationHref?:string}} [context]
   * @returns {{action:"alt-a"|"alt-s"|"none", conflict:"none"|"editing"|"composed"|"combined"|"restricted"}}
   */
  const classifyShortcut = (event, context = {}) => {
    if (!event || typeof event !== "object") return { action: "none", conflict: "none" };
    if (!event.altKey || event.altKey !== true) return { action: "none", conflict: "none" };
    const action = codeToAction(event);
    if (!action) return { action: "none", conflict: "none" };
    if (isDocumentedSidePanelCommand(event)) return { action: "none", conflict: "none" };
    if (event.isComposing === true) return { action: "none", conflict: "composed" };
    if (hasAuxiliaryModifiers(event)) return { action: "none", conflict: "combined" };
    if (isRestrictedScheme(context.locationHref ?? "")) return { action: "none", conflict: "restricted" };
    if (isEditableTarget(event.target)) return { action: "none", conflict: "editing" };
    return { action, conflict: "none" };
  };

  /**
   * Returns true when the stored summary context was produced for a different
   * tab identity (URL or title) than the current page. Used by content.js to
   * expire stale Alt+S summaries when the user navigates within the tab.
   *
   * @param {{url?:string, title?:string}|null|undefined} stored
   * @param {{url:string, title:string}} current
   */
  const isSummaryContextStale = (stored, current) => {
    if (!stored || typeof stored !== "object") return true;
    if (typeof stored.url !== "string") return true;
    if (typeof current?.url !== "string") return true;
    if (stored.url !== current.url) return true;
    if ((stored.title ?? "") !== (current.title ?? "")) return true;
    return false;
  };

  /**
   * Generates a new monotonic token for an Alt+S request. Caller compares
   * against the in-flight token before applying a result; a mismatch means the
   * request has been superseded by a more recent Alt+S or a page navigation.
   */
  const createRequestToken = (() => {
    let counter = 0;
    return () => {
      counter += 1;
      return `augmentor-alt-s-${counter}`;
    };
  })();

  globalThis.ResonantOSAugmentorShortcutController = Object.freeze({
    RESTRICTED_SCHEMES: FALLBACK_RESTRICTED_SCHEMES,
    classifyShortcut,
    createRequestToken,
    isSummaryContextStale
  });
})();
