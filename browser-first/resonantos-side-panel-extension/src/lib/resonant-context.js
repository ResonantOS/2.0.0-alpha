/* Resonant Context SDK v1.0.0 — 2026-05-17T03:53:47Z */

/**
 * Resonant Context SDK — Viewport Observer
 * Tracks visible sections, dwell time, and active overlays.
 * Domain-agnostic: all element selectors come from the plugin config.
 *
 * @version 1.0.0
 */
(function (exports) {
  'use strict';

  /**
   * @param {Object} config
   * @param {Array}  config.sections     — [{selector, label, priority}]
   * @param {Array}  config.overlaySelectors — CSS selectors for modals/overlays
   * @param {number} config.threshold    — IntersectionObserver threshold (0–1, default 0.5)
   * @param {number} config.maxTextChars — max chars to capture from visible text
   */
  function ViewportObserver(config) {
    this._sections = config.sections || [];
    this._overlaySelectors = config.overlaySelectors || [
      '.modal.open', '.modal[style*="display: block"]', '.modal[style*="display:block"]',
      '.modal-bg[style*="display: block"]', '.modal-bg[style*="display:block"]',
      '[role="dialog"]:not([style*="display: none"])',
      '.overlay.active', '.drawer.open'
    ];
    this._threshold = config.threshold || 0.5;
    this._maxTextChars = config.maxTextChars || 500;

    // State: sectionId → {visible, enteredAt, totalDwellMs}
    this._state = {};
    this._observer = null;
    this._elementMap = new Map(); // element → section config

    this._init();
  }

  ViewportObserver.prototype._init = function () {
    var self = this;

    // Initialize state for each section
    this._sections.forEach(function (sec) {
      self._state[sec.selector] = {
        visible: false,
        enteredAt: null,
        totalDwellMs: 0,
        label: sec.label,
        priority: sec.priority || 5
      };
    });

    // Create IntersectionObserver
    if (typeof IntersectionObserver !== 'undefined') {
      this._observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var sec = self._elementMap.get(entry.target);
          if (!sec) return;
          var st = self._state[sec.selector];
          if (!st) return;

          if (entry.isIntersecting && entry.intersectionRatio >= self._threshold) {
            if (!st.visible) {
              st.visible = true;
              st.enteredAt = Date.now();
            }
            st.pctVisible = Math.round(entry.intersectionRatio * 100);
          } else {
            if (st.visible && st.enteredAt) {
              st.totalDwellMs += Date.now() - st.enteredAt;
              st.enteredAt = null;
            }
            st.visible = false;
            st.pctVisible = 0;
          }
        });
      }, { threshold: [0, 0.25, 0.5, 0.75, 1.0] });

      // Observe elements
      this._sections.forEach(function (sec) {
        var el = document.querySelector(sec.selector);
        if (el) {
          self._elementMap.set(el, sec);
          self._observer.observe(el);
        }
      });
    }
  };

  /**
   * Returns currently visible sections sorted by priority (descending).
   * @returns {Array<{id, label, dwellMs, pctVisible, priority}>}
   */
  ViewportObserver.prototype.getVisibleSections = function () {
    var now = Date.now();
    var results = [];

    for (var selector in this._state) {
      var st = this._state[selector];
      var dwellMs = st.totalDwellMs;
      if (st.visible && st.enteredAt) {
        dwellMs += now - st.enteredAt;
      }
      if (st.visible || dwellMs > 1000) {
        results.push({
          id: selector,
          label: st.label,
          dwellMs: dwellMs,
          pctVisible: st.pctVisible || 0,
          priority: st.priority,
          currentlyVisible: st.visible
        });
      }
    }

    results.sort(function (a, b) { return b.priority - a.priority; });
    return results;
  };

  /**
   * Detects and returns the topmost active overlay/modal.
   * @returns {{id, type, content}|null}
   */
  ViewportObserver.prototype.getActiveOverlay = function () {
    var maxChars = this._maxTextChars;

    for (var i = 0; i < this._overlaySelectors.length; i++) {
      var sel = this._overlaySelectors[i];
      var el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        var content = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (content.length > maxChars) content = content.substring(0, maxChars) + '…';

        return {
          id: el.id || el.className.split(' ')[0] || 'overlay',
          type: el.getAttribute('role') === 'dialog' ? 'dialog'
            : el.classList.contains('modal') || el.classList.contains('modal-bg') ? 'modal'
              : 'overlay',
          content: content
        };
      }
    }
    return null;
  };

  /**
   * Gets visible text from a specific selector, truncated.
   * @param {string} selector
   * @returns {string}
   */
  ViewportObserver.prototype.getVisibleText = function (selector) {
    var el = document.querySelector(selector);
    if (!el) return '';
    var text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > this._maxTextChars) text = text.substring(0, this._maxTextChars) + '…';
    return text;
  };

  /**
   * Cleanup.
   */
  ViewportObserver.prototype.destroy = function () {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    this._elementMap.clear();
    this._state = {};
  };

  exports.ViewportObserver = ViewportObserver;

})(typeof window !== 'undefined' ? (window._ResonantContext = window._ResonantContext || {}) : module.exports);

/**
 * Resonant Context SDK — Forms Tracker
 * Snapshots form/input state without keystroke logging.
 * Domain-agnostic: selectors come from plugin config.
 *
 * @version 1.0.0
 */
(function (exports) {
  'use strict';

  var ALWAYS_IGNORE = 'input[type="password"], [data-rc-ignore]';

  /**
   * @param {Object} config
   * @param {Array}  config.forms          — [{selector, name, priority, fields?}]
   * @param {string} config.ignoreSelector — additional selectors to never capture
   */
  function FormsTracker(config) {
    this._forms = config.forms || [];
    this._ignoreSelector = config.ignoreSelector
      ? ALWAYS_IGNORE + ', ' + config.ignoreSelector
      : ALWAYS_IGNORE;

    // Track touched fields: selector → boolean
    this._touched = {};
    this._listener = null;

    this._init();
  }

  FormsTracker.prototype._init = function () {
    var self = this;

    // Track blur events to mark fields as "touched"
    this._listener = function (e) {
      var target = e.target;
      if (!target || !target.matches) return;
      if (target.matches('input, select, textarea') && !target.matches(self._ignoreSelector)) {
        var key = _fieldKey(target);
        if (key) self._touched[key] = true;
      }
    };

    document.addEventListener('blur', this._listener, true);
  };

  /**
   * Get state of a specific tracked form.
   * @param {string} formSelector
   * @returns {{id, name, fields: Array<{name, value, touched}>, completeness}|null}
   */
  FormsTracker.prototype.getFormState = function (formSelector) {
    var config = null;
    for (var i = 0; i < this._forms.length; i++) {
      if (this._forms[i].selector === formSelector) { config = this._forms[i]; break; }
    }
    if (!config) return null;
    return this._extractForm(config);
  };

  /**
   * Get state of ALL tracked forms.
   * @returns {Array<{id, name, fields, completeness, priority}>}
   */
  FormsTracker.prototype.getAllFormStates = function () {
    var self = this;
    var results = [];
    this._forms.forEach(function (cfg) {
      var state = self._extractForm(cfg);
      if (state) results.push(state);
    });
    results.sort(function (a, b) { return b.priority - a.priority; });
    return results;
  };

  /**
   * Internal: extract a single form's state.
   */
  FormsTracker.prototype._extractForm = function (cfg) {
    var self = this;
    var container = document.querySelector(cfg.selector);

    // If the form selector points to a specific input (not a container), handle it
    var inputs;
    if (container && (container.tagName === 'INPUT' || container.tagName === 'SELECT' || container.tagName === 'TEXTAREA')) {
      inputs = [container];
    } else if (container) {
      inputs = container.querySelectorAll('input, select, textarea');
    } else {
      // Try collecting individual field selectors
      if (cfg.fields && cfg.fields.length) {
        inputs = [];
        cfg.fields.forEach(function (f) {
          var el = document.querySelector(f.selector || f);
          if (el) inputs.push(el);
        });
      } else {
        return null;
      }
    }

    if (!inputs || inputs.length === 0) return null;

    var fields = [];
    var filled = 0;
    var total = 0;

    var inputArr = Array.prototype.slice.call(inputs);
    inputArr.forEach(function (el) {
      if (el.matches(self._ignoreSelector)) return;
      if (el.type === 'hidden') return;

      var name = el.name || el.id || el.placeholder || '(unnamed)';
      var value = _getFieldValue(el);
      var key = _fieldKey(el);
      var touched = !!self._touched[key];

      total++;
      if (value && value.length > 0) filled++;

      fields.push({
        name: name,
        value: value,
        touched: touched
      });
    });

    return {
      id: cfg.selector,
      name: cfg.name || cfg.selector,
      fields: fields,
      completeness: total > 0 ? Math.round((filled / total) * 100) / 100 : 0,
      priority: cfg.priority || 5
    };
  };

  /**
   * Cleanup.
   */
  FormsTracker.prototype.destroy = function () {
    if (this._listener) {
      document.removeEventListener('blur', this._listener, true);
      this._listener = null;
    }
    this._touched = {};
  };

  // ── Helpers ─────────────────────────────────────────────────────────────

  function _fieldKey(el) {
    return el.id || el.name || (el.getAttribute('data-rc-name')) || null;
  }

  function _fieldSafety(el) {
    try {
      if (typeof window !== 'undefined' && window.ResonantOSContentFieldSafety?.classifyEditableField) {
        return window.ResonantOSContentFieldSafety.classifyEditableField(el);
      }
    } catch (e) { /* fall back to local heuristic */ }
    var type = String(el?.getAttribute?.('type') || el?.type || '').toLowerCase();
    var haystack = [
      type,
      el?.name,
      el?.id,
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('placeholder'),
      el?.getAttribute?.('autocomplete')
    ].filter(Boolean).join(' ').toLowerCase();
    if (type === 'password' || /\b(password|passcode|secret|token|api[-_\s]?key|otp|2fa|mfa|seed|private\s*key)\b/.test(haystack)) {
      return { kind: 'credential' };
    }
    if (/\b(card|credit|debit|cvc|cvv|iban|routing|account\s*number|payment|wallet|billing|checkout)\b/.test(haystack)) {
      return { kind: 'payment' };
    }
    if (/\b(email|phone|address|name|username|login|signin|sign[-\s]?in)\b/.test(haystack)) {
      return { kind: 'personal-contact' };
    }
    if (type === 'search' || /\b(search|query|find|filter|lookup)\b/.test(haystack)) {
      return { kind: 'search-query' };
    }
    return { kind: 'generic-text' };
  }

  function _sanitizeFreeText(value, max) {
    var text = String(value || '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    text = text
      .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
      .replace(/\b(?:sk|sk-ant|sk-or-v1|xai|gsk|AIza|AKIA|gh[pousr]_|github_pat_|hf_|xox[baprs]-|pk_live_|rk_live_|SG\.)[A-Za-z0-9._\-+/=]{10,}\b/gi, '[redacted]')
      .replace(/\b(?:api[_-]?key|token|password|secret|authorization|bearer)\s*[:=]\s*['"]?[^'"\s]+/gi, '[redacted]')
      .replace(/\b(?:\d[ -]?){13,19}\b/g, function (candidate) {
        var digits = candidate.replace(/\D/g, '');
        return digits.length >= 13 && digits.length <= 19 ? '[redacted]' : candidate;
      });
    return text.slice(0, max || 180);
  }

  function _getFieldValue(el) {
    var raw = '';
    if (el.tagName === 'SELECT') {
      var opt = el.options[el.selectedIndex];
      raw = opt ? opt.text : '';
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      return el.checked ? 'checked' : '';
    } else {
      raw = (el.value || '').trim();
    }
    if (!raw) return '';
    var safety = _fieldSafety(el);
    var kind = safety?.kind || 'field';
    if (kind !== 'search-query') {
      return '[redacted:' + kind + ']';
    }
    return _sanitizeFreeText(raw, 180);
  }

  exports.FormsTracker = FormsTracker;

})(typeof window !== 'undefined' ? (window._ResonantContext = window._ResonantContext || {}) : module.exports);

/**
 * Resonant Context SDK — Session Tracker
 * Records navigation history, click trail, and page timing.
 * Domain-agnostic: click selectors come from plugin config.
 *
 * @version 1.0.0
 */
(function (exports) {
  'use strict';

  var MAX_HISTORY = 20;
  var MAX_CLICKS = 30;
  var STORAGE_KEY = 'rc_session';

  /**
   * @param {Object} config
   * @param {string} config.clickSelectors  — CSS selector for clicks to track
   * @param {number} config.maxHistory      — max navigation entries (default 20)
   * @param {number} config.maxClicks       — max click trail entries (default 30)
   * @param {boolean} config.persistSession — survive page navigations via sessionStorage
   */
  function SessionTracker(config) {
    this._clickSelectors = config.clickSelectors || 'a, button, [onclick], [role="button"]';
    this._maxHistory = config.maxHistory || MAX_HISTORY;
    this._maxClicks = config.maxClicks || MAX_CLICKS;
    this._persistSession = config.persistSession !== false;

    // State
    this._history = [];      // [{path, title, enteredAt, dwellMs}]
    this._clickTrail = [];   // [{selector, text, ts}]
    this._pageEnteredAt = Date.now();
    this._entryPoint = document.referrer || '(direct)';
    this._clickListener = null;

    this._init();
  }

  SessionTracker.prototype._init = function () {
    var self = this;

    // Restore from sessionStorage if persisting
    if (this._persistSession) {
      try {
        var stored = sessionStorage.getItem(STORAGE_KEY);
        if (stored) {
          var data = JSON.parse(stored);
          this._history = data.history || [];
          this._clickTrail = data.clickTrail || [];
          this._entryPoint = data.entryPoint || this._entryPoint;
        }
      } catch (e) { /* ignore */ }
    }

    // Record current page in history
    this._recordCurrentPage();

    // Track clicks via delegation
    this._clickListener = function (e) {
      var target = e.target;
      if (!target) return;

      // Walk up to find matching element
      var matched = target.closest(self._clickSelectors);
      if (!matched) return;

      var text = (matched.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 80) text = text.substring(0, 77) + '…';

      var selector = _buildSelector(matched);

      self._clickTrail.push({
        selector: selector,
        text: text,
        ts: Date.now()
      });

      // Trim
      if (self._clickTrail.length > self._maxClicks) {
        self._clickTrail = self._clickTrail.slice(-self._maxClicks);
      }

      self._persist();
    };

    document.addEventListener('click', this._clickListener, true);

    // Persist on beforeunload
    if (this._persistSession) {
      window.addEventListener('beforeunload', function () {
        self._updateCurrentPageDwell();
        self._persist();
      });
    }
  };

  SessionTracker.prototype._recordCurrentPage = function () {
    var current = {
      path: _safePath(window.location.pathname + window.location.search),
      title: document.title || '',
      enteredAt: Date.now(),
      dwellMs: 0
    };

    // Update dwell on previous page if exists
    if (this._history.length > 0) {
      var prev = this._history[this._history.length - 1];
      if (prev.path === current.path) {
        // Same page reload — don't add duplicate
        return;
      }
    }

    this._history.push(current);

    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-this._maxHistory);
    }

    this._pageEnteredAt = current.enteredAt;
    this._persist();
  };

  SessionTracker.prototype._updateCurrentPageDwell = function () {
    if (this._history.length > 0) {
      var last = this._history[this._history.length - 1];
      last.dwellMs = Date.now() - (last.enteredAt || this._pageEnteredAt);
    }
  };

  SessionTracker.prototype._persist = function () {
    if (!this._persistSession) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        history: this._history,
        clickTrail: this._clickTrail,
        entryPoint: this._entryPoint
      }));
    } catch (e) { /* quota exceeded — ignore */ }
  };

  /**
   * @returns {Array<{path, title, enteredAt, dwellMs}>}
   */
  SessionTracker.prototype.getHistory = function () {
    this._updateCurrentPageDwell();
    return this._history.slice();
  };

  /**
   * @returns {Array<{selector, text, ts}>}
   */
  SessionTracker.prototype.getClickTrail = function () {
    return this._clickTrail.slice(-15); // Last 15 for payload budget
  };

  /**
   * @returns {{path, title, timeOnPageMs}}
   */
  SessionTracker.prototype.getCurrentPage = function () {
    return {
      path: _safePath(window.location.pathname + window.location.search),
      title: document.title || '',
      timeOnPageMs: Date.now() - this._pageEnteredAt
    };
  };

  /**
   * @returns {string}
   */
  SessionTracker.prototype.getEntryPoint = function () {
    return this._entryPoint;
  };

  /**
   * Cleanup.
   */
  SessionTracker.prototype.destroy = function () {
    if (this._clickListener) {
      document.removeEventListener('click', this._clickListener, true);
      this._clickListener = null;
    }
  };

  // ── Helpers ─────────────────────────────────────────────────────────────

  function _buildSelector(el) {
    if (el.id) return '#' + el.id;
    var tag = el.tagName.toLowerCase();
    var cls = el.className ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : '';
    return tag + cls;
  }

  function _safePath(value) {
    return (String(value || '').split(/[?#]/)[0] || '/').slice(0, 300);
  }

  exports.SessionTracker = SessionTracker;

})(typeof window !== 'undefined' ? (window._ResonantContext = window._ResonantContext || {}) : module.exports);

/**
 * Resonant Context SDK — Context Collector (Orchestrator)
 * Merges all core modules + domain plugin into a standardized context payload.
 * This is the public API surface.
 *
 * @version 1.0.0
 *
 * Usage:
 *   var ctx = ResonantContext.init({ plugin: MatchSirePlugin });
 *   var payload = ctx.getContext();
 *   // Send payload with chat message to backend
 */
(function (root) {
  'use strict';

  var RC = root._ResonantContext || {};

  var SCHEMA_VERSION = '1.0';
  var DEFAULT_MAX_CHARS = 4000;

  /**
   * @param {Object} config
   * @param {Object} config.plugin          — domain plugin configuration object
   * @param {number} config.maxPayloadChars — max JSON payload size (default 4000)
   * @param {boolean} config.debug          — enable console logging
   */
  function ContextCollector(config) {
    this._plugin = config.plugin || {};
    this._maxChars = config.maxPayloadChars || DEFAULT_MAX_CHARS;
    this._debug = config.debug || false;

    // Determine current page config from plugin
    this._pageConfig = this._resolvePageConfig();

    // Initialize core modules with page-specific config
    var sections = [];
    var forms = [];
    var overlaySelectors = [];

    if (this._pageConfig) {
      sections = this._pageConfig.sections || [];
      forms = this._pageConfig.forms || [];
      overlaySelectors = this._pageConfig.overlaySelectors || [];
    }

    // Merge global overlay selectors from plugin
    if (this._plugin.overlaySelectors) {
      overlaySelectors = overlaySelectors.concat(this._plugin.overlaySelectors);
    }

    this._viewport = new RC.ViewportObserver({
      sections: sections,
      overlaySelectors: overlaySelectors.length ? overlaySelectors : undefined,
      threshold: this._plugin.viewportThreshold || 0.5,
      maxTextChars: this._plugin.maxTextChars || 500
    });

    this._forms = new RC.FormsTracker({
      forms: forms,
      ignoreSelector: this._plugin.ignoreSelectors || ''
    });

    this._session = new RC.SessionTracker({
      clickSelectors: this._plugin.clickSelectors || 'a, button, [onclick], [role="button"]',
      maxHistory: this._plugin.maxHistory || 20,
      maxClicks: this._plugin.maxClicks || 30,
      persistSession: this._plugin.persistSession !== false
    });

    if (this._debug) console.log('[RC] Initialized with plugin:', this._plugin.domain || 'generic');
  }

  /**
   * Resolve which page config from the plugin applies to the current URL.
   * @returns {Object|null}
   */
  ContextCollector.prototype._resolvePageConfig = function () {
    if (!this._plugin.pages) return null;
    var path = window.location.pathname;

    for (var pageId in this._plugin.pages) {
      var page = this._plugin.pages[pageId];
      if (page.match && page.match(path)) {
        if (this._debug) console.log('[RC] Matched page config:', pageId);
        return page;
      }
    }

    if (this._debug) console.log('[RC] No page config matched for:', path);
    return null;
  };

  /**
   * Collect full context payload.
   * @returns {Object} — standardized context payload
   */
  ContextCollector.prototype.getContext = function () {
    var payload = {
      v: SCHEMA_VERSION,
      domain: this._plugin.domain || 'generic',
      ts: new Date().toISOString(),
      page: this._session.getCurrentPage(),
      viewport: {
        visibleSections: this._viewport.getVisibleSections(),
        activeOverlay: this._viewport.getActiveOverlay()
      },
      forms: this._forms.getAllFormStates(),
      session: {
        navigation: this._session.getHistory(),
        clickTrail: this._session.getClickTrail(),
        entryPoint: this._session.getEntryPoint()
      },
      domain_data: {},
      summary: ''
    };

    // Run domain extractors
    if (this._pageConfig && this._pageConfig.extractors) {
      var self = this;
      this._pageConfig.extractors.forEach(function (ext) {
        try {
          payload.domain_data[ext.name] = ext.fn();
        } catch (e) {
          if (self._debug) console.warn('[RC] Extractor failed:', ext.name, e);
          payload.domain_data[ext.name] = null;
        }
      });
    }

    // Run global extractors
    if (this._plugin.globalExtractors) {
      var self2 = this;
      this._plugin.globalExtractors.forEach(function (ext) {
        try {
          payload.domain_data[ext.name] = ext.fn();
        } catch (e) {
          if (self2._debug) console.warn('[RC] Global extractor failed:', ext.name, e);
        }
      });
    }

    // Generate summary via plugin formatter
    if (this._plugin.formatContext) {
      try {
        payload.summary = this._plugin.formatContext(payload);
      } catch (e) {
        if (this._debug) console.warn('[RC] formatContext failed:', e);
        payload.summary = this._defaultSummary(payload);
      }
    } else {
      payload.summary = this._defaultSummary(payload);
    }

    // Enforce payload budget
    payload = this._truncatePayload(payload);

    if (this._debug) {
      console.log('[RC] Context payload (' + JSON.stringify(payload).length + ' chars):', payload);
    }

    return payload;
  };

  /**
   * Collect context with message-intent awareness.
   * If the user's message mentions something visible, boost that section's priority.
   * @param {string} userMessage
   * @returns {Object}
   */
  ContextCollector.prototype.getContextForMessage = function (userMessage) {
    var payload = this.getContext();

    // Simple keyword boosting: if user mentions something that matches domain data, keep it
    if (userMessage && this._plugin.messageKeywords) {
      var msg = userMessage.toLowerCase();
      var boosts = this._plugin.messageKeywords;
      for (var keyword in boosts) {
        if (msg.indexOf(keyword) !== -1) {
          var dataKey = boosts[keyword];
          // Ensure this domain_data key survives truncation
          if (payload.domain_data[dataKey]) {
            payload.domain_data['_boosted_' + dataKey] = true;
          }
        }
      }
    }

    return payload;
  };

  /**
   * Default summary generator when plugin doesn't provide one.
   */
  ContextCollector.prototype._defaultSummary = function (payload) {
    var parts = [];

    parts.push('Page: ' + payload.page.path);

    if (payload.viewport.activeOverlay) {
      parts.push('Active overlay: ' + payload.viewport.activeOverlay.id);
    }

    var visible = payload.viewport.visibleSections.filter(function (s) { return s.currentlyVisible; });
    if (visible.length) {
      parts.push('Viewing: ' + visible.map(function (s) { return s.label; }).join(', '));
    }

    var filledForms = payload.forms.filter(function (f) { return f.completeness > 0; });
    if (filledForms.length) {
      parts.push('Forms active: ' + filledForms.map(function (f) { return f.name; }).join(', '));
    }

    return parts.join('. ');
  };

  /**
   * Enforce payload size budget by removing lowest-priority data.
   * Priority order from plugin or default: activeOverlay > extractors > forms > visibleSections > clickTrail > navigation
   */
  ContextCollector.prototype._truncatePayload = function (payload) {
    var serialized = JSON.stringify(payload);
    if (serialized.length <= this._maxChars) return payload;

    // Progressive truncation: remove lowest-priority items first
    var order = this._plugin.truncationOrder || [
      'clickTrail', 'navigation', 'visibleSections', 'forms', 'domain_data'
    ];

    for (var i = 0; i < order.length; i++) {
      serialized = JSON.stringify(payload);
      if (serialized.length <= this._maxChars) break;

      var key = order[i];
      switch (key) {
        case 'clickTrail':
          payload.session.clickTrail = payload.session.clickTrail.slice(-5);
          break;
        case 'navigation':
          payload.session.navigation = payload.session.navigation.slice(-3);
          break;
        case 'visibleSections':
          payload.viewport.visibleSections = payload.viewport.visibleSections.slice(0, 3);
          break;
        case 'forms':
          // Keep only forms with data
          payload.forms = payload.forms.filter(function (f) { return f.completeness > 0; });
          break;
        case 'domain_data':
          // Remove null domain data entries
          for (var dk in payload.domain_data) {
            if (payload.domain_data[dk] === null) delete payload.domain_data[dk];
          }
          break;
      }
    }

    // Final safety: truncate summary if still over budget
    serialized = JSON.stringify(payload);
    if (serialized.length > this._maxChars) {
      var overBy = serialized.length - this._maxChars;
      if (payload.summary.length > overBy + 50) {
        payload.summary = payload.summary.substring(0, payload.summary.length - overBy - 10) + '…';
      }
    }

    return payload;
  };

  /**
   * Cleanup all observers and listeners.
   */
  ContextCollector.prototype.destroy = function () {
    this._viewport.destroy();
    this._forms.destroy();
    this._session.destroy();
  };

  // ── Public API ─────────────────────────────────────────────────────────

  root.ResonantContext = {
    version: SCHEMA_VERSION,

    /**
     * Initialize the SDK with a domain plugin.
     * @param {Object} config
     * @returns {ContextCollector}
     */
    init: function (config) {
      return new ContextCollector(config || {});
    }
  };

})(typeof window !== 'undefined' ? window : global);
