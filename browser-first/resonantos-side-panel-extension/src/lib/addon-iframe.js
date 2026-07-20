// Generic addon iframe renderer.
//
// Renders an addon's HTML inside the extension's newtab by:
//   1. Fetching the addon's index page through the bridge proxy
//      (`{bridgeUrl}{proxyPath}`) — the bridge forwards to the addon's
//      actual http://127.0.0.1:<port>/ server.
//   2. Rewriting the HTML so subresources (CSS, JS, images, fetch() calls,
//      XHRs) all point back through the bridge proxy.
//   3. Injecting a <base> tag and a small script that overrides window.fetch
//      and XMLHttpRequest to also route through the bridge proxy. This is
//      the "magic" that makes the addon work inside a chrome-extension://
//      iframe without the addon author knowing about it.
//   4. Wrapping the rewritten HTML in a <iframe sandbox="..." srcdoc="...">.
//      The iframe is in the extension's secure context, so Chrome's mixed-
//      content rule never fires — even though the proxied content comes
//      from a plaintext http:// origin on the bridge host.
//
// The component is addon-agnostic: it works for Hermes, OpenCode, OpenClaw,
// or any future addon that the bridge is configured to proxy. The only
// addon-specific knowledge is:
//   - `proxyPath` (e.g. "/hermes-dashboard/"): the bridge-side prefix
//   - `apiBasePath` (optional, default "/api"): the addon's API path prefix;
//     if the addon uses different sub-paths, callers can pass a custom
//     rewrite rule. The default covers Hermes and most JSON APIs.
//
// Why srcdoc and not src? Chrome's mixed-content rule blocks http:// URLs
// inside a chrome-extension:// (secure) page. The proxy URL is also http://,
// so even though the bridge is on the same host as the extension sees it,
// the iframe src URL is non-secure → blocked. srcdoc contains the addon's
// HTML as a literal string, so there's no http:// URL involved at all
// from Chrome's perspective. The addon's <script src="..."> tags are
// rewritten to point back at the bridge proxy (still http://), but those
// load via the iframe's own origin resolution (also secure because the
// parent page is secure), so they work.
//
// Inside the iframe, the addon's JS does `fetch("/api/foo")` — that fetch
// goes to the iframe's own origin (chrome-extension://...). We override
// window.fetch in the injected preamble to forward all same-origin
// requests back through the bridge proxy. The bridge strips the prefix
// and forwards to the addon.

const DEFAULT_API_BASE_PATH = "/api";

function escapeForScript(value) {
  return JSON.stringify(String(value));
}

function rewriteUrl(url, proxyPath, bridgeUrl) {
  // Relative or root-relative URL → proxy URL. Absolute http(s) URL stays
  // alone (the addon may pull from CDNs, fonts, etc. — those work in the
  // iframe because the iframe's parent is secure, the iframe is also
  // secure-by-inheritance, and the iframe sandbox is the only restriction).
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url; // has scheme
  if (url.startsWith("//")) return url; // protocol-relative, leave alone
  // Trim leading slashes and append to proxy path.
  const stripped = url.replace(/^\/+/, "");
  // Use absolute URL (bridge origin) so the iframe can resolve it
  // without needing a <base> tag.
  const origin = bridgeUrl.replace(/\/+$/, "");
  if (!stripped) return `${origin}${proxyPath}`;
  return `${origin}${proxyPath}${stripped}`;
}

function rewriteHtmlAttribute(html, attr, proxyPath, bridgeUrl) {
  // Walk attribute values and rewrite them. Naive regex is fine for HTML
  // we control (the bridge strips a prefix before forwarding, so the
  // addon can return anything — but we want to be safe).
  return html.replace(new RegExp(`(${attr}\\s*=\\s*")([^"]*)(")`, "gi"), (_match, pre, value, post) => {
    return `${pre}${rewriteUrl(value, proxyPath, bridgeUrl)}${post}`;
  });
}

export function buildAddonSrcdoc({
  proxyPath,
  bridgeUrl,
  bridgeToken = "",
  addonLabel = "addon",
  apiBasePath = DEFAULT_API_BASE_PATH,
  upstreamHtml = "",
  extraPreamble = "",
}) {
  // Subresource rewrite: <link href>, <script src>, <img src>, <a href>,
  // <form action>. Naive but covers 99% of server-rendered HTML.
  let html = upstreamHtml;
  for (const attr of ["href", "src", "action", "data", "formaction", "poster"]) {
    html = rewriteHtmlAttribute(html, attr, proxyPath, bridgeUrl);
  }
  // Inline style/url(...) references: rewrite once for safety.
  html = html.replace(/url\((['"]?)(\/[^)'"]+)\1\)/gi, (_match, q, url) => {
    return `url(${q}${rewriteUrl(url, proxyPath, bridgeUrl)}${q})`;
  });
  // The srcdoc iframe inherits the parent page's CSP. MV3 forbids
  // external hosts in the parent page's script-src (only 'self',
  // 'wasm-unsafe-eval', and 'unsafe-eval' are allowed), so the
  // addon's <script src="https://bridge/..."> would be blocked.
  //
  // We inject a <meta http-equiv="Content-Security-Policy"> inside
  // the srcdoc to override the inherited policy and allow scripts
  // from the bridge origin. This meta CSP is the standard way to
  // scope a nested browsing context's CSP tighter (or in our case,
  // looser for trusted addon origins).
  const origin = bridgeUrl.replace(/\/+$/, "").replace(/"/g, "&quot;");
  const metaCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' ${origin} 'unsafe-inline' 'unsafe-eval' data: blob:; img-src 'self' ${origin} data: blob:; connect-src 'self' ${origin}; script-src 'self' ${origin} 'unsafe-inline' 'unsafe-eval'; style-src 'self' ${origin} 'unsafe-inline'; frame-src 'self' ${origin};">`;
  // Inject a <base> tag so any URLs we miss (e.g. a literal "/foo" string
  // in a JS template) resolve to the bridge proxy. Combined with the
  // window.fetch override, this covers both the rendered HTML and the
  // dynamic JS path.
  const baseTag = `<base href="${origin}${proxyPath}">`;
  // Window.fetch / XHR override. Any same-origin request to the iframe's
  // own chrome-extension:// origin gets re-routed to the bridge proxy.
  // Auth: the bridge-token is sent in the header by the proxy. CORS: the
  // bridge allows the extension's origin. The addon sees a normal response.
  const preamble = `
<script>
(function(){
  var PROXY_PATH = ${escapeForScript(proxyPath)};
  var BRIDGE_URL = ${escapeForScript(bridgeUrl)};
  var BRIDGE_TOKEN = ${escapeForScript(bridgeToken)};
  var API_BASE = ${escapeForScript(apiBasePath)};
  function rewrite(url) {
    if (!url || typeof url !== "string") return url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    if (url.startsWith("//")) return url;
    if (url.indexOf(PROXY_PATH) === 0) return url;
    if (url.startsWith("/")) return BRIDGE_URL.replace(/\\/$/, "") + PROXY_PATH + url.replace(/^\\/+/, "");
    return BRIDGE_URL.replace(/\\/$/, "") + PROXY_PATH + url;
  }
  function withAuth(input, init) {
    init = init || {};
    try {
      var headers = new Headers(init.headers || (input && input.headers) || {});
      if (BRIDGE_TOKEN && !headers.has("X-ResonantOS-Bridge-Token")) {
        headers.set("X-ResonantOS-Bridge-Token", BRIDGE_TOKEN);
      }
      init.headers = headers;
    } catch (e) { /* ignore */ }
    return init;
  }
  var origFetch = window.fetch && window.fetch.bind(window);
  window.fetch = function(input, init) {
    try {
      if (typeof input === "string") {
        return origFetch(rewrite(input), withAuth(null, init));
      } else if (input && typeof input === "object" && "url" in input) {
        var u = input;
        var cloned = new Request(rewrite(u.url), u);
        return origFetch(cloned, withAuth(cloned, init));
      }
    } catch (e) { /* fall through to origFetch */ }
    return origFetch(input, withAuth(null, init));
  };
  var OrigXHR = window.XMLHttpRequest;
  function ProxiedXHR() {
    var xhr = new OrigXHR();
    var origOpen = xhr.open.bind(xhr);
    var origSend = xhr.send.bind(xhr);
    var origSetHeader = xhr.setRequestHeader.bind(xhr);
    var tokenSent = false;
    xhr.open = function(method, url, async, user, pass) {
      return origOpen(method, rewrite(url), async, user, pass);
    };
    xhr.setRequestHeader = function(name, value) {
      if (name && name.toLowerCase() === "x-resonantos-bridge-token") {
        tokenSent = true;
      }
      return origSetHeader(name, value);
    };
    xhr.send = function(body) {
      if (BRIDGE_TOKEN && !tokenSent) {
        try { origSetHeader("X-ResonantOS-Bridge-Token", BRIDGE_TOKEN); } catch (e) { /* ignore */ }
      }
      return origSend(body);
    };
    return xhr;
  }
  ProxiedXHR.prototype = OrigXHR.prototype;
  ProxiedXHR.UNSENT = 0;
  ProxiedXHR.OPENED = 1;
  ProxiedXHR.HEADERS_RECEIVED = 2;
  ProxiedXHR.LOADING = 3;
  ProxiedXHR.DONE = 4;
  window.XMLHttpRequest = ProxiedXHR;
  ${extraPreamble}
})();
</script>
`;
  // Insert the <meta> CSP, <base>, and <script> into the <head>, or at
  // the top of the body if there's no <head>. If the addon doesn't have
  // a <head> or <body>, prepend to the whole document.
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (match) => `${match}${metaCsp}${baseTag}${preamble}`);
  } else if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/<body[^>]*>/i, (match) => `${match}${metaCsp}${baseTag}${preamble}`);
  } else {
    html = `${metaCsp}${baseTag}${preamble}${html}`;
  }
  return html;
}

// Watch an iframe for mount success. Polls the inner document's root
// node for children every second for up to 30s; when children appear
// (i.e. the React/Vue app has rendered), update the status banner.
// If children never appear, surface a CSP/CORS hint instead of leaving
// a silent blank iframe.
//
// `mode` is informational only — used in the error message so Greg
// knows whether the issue is the srcdoc rewrite (srcdoc mode) or the
// cross-origin src load (src mode).
function watchIframeForMount(iframe, status, addonLabel, mode, htmlLength) {
  const startWatch = Date.now();
  const watchTimer = setInterval(() => {
    if (Date.now() - startWatch > 30000) {
      clearInterval(watchTimer);
      return;
    }
    let innerDoc = null;
    try { innerDoc = iframe.contentDocument; } catch { return; }
    if (!innerDoc) return;
    const root = innerDoc.getElementById("root") || innerDoc.body;
    if (root && root.children.length === 0) {
      status.textContent = `${addonLabel} HTML loaded but the app did not mount. Check the browser console for CSP or CORS errors.`;
      status.classList.add("addon-iframe-status--error");
    } else if (root && root.children.length > 0) {
      const lenLabel = htmlLength ? ` (${htmlLength} bytes)` : "";
      status.textContent = `${addonLabel} ready${lenLabel}.`;
      status.classList.add("addon-iframe-status--ready");
      clearInterval(watchTimer);
    }
  }, 1000);
  iframe.addEventListener("load", () => {
    setTimeout(() => {
      try {
        const doc = iframe.contentDocument;
        const root = doc?.getElementById("root") || doc?.body;
        if (root && root.children.length === 0) {
          status.textContent = `${addonLabel} loaded but did not render. Likely a CSP/CORS block on a subresource (mode=${mode}).`;
          status.classList.add("addon-iframe-status--error");
        }
      } catch { /* ignore */ }
    }, 2000);
  }, { once: true });
}

// Generic iframe component. Call this from any addon's workspace
// (hermes, opencode, openclaw, etc.) and it Just Works.
//
// `mode` controls how the iframe is loaded:
//   - "src"    (default): set iframe.src to `{bridgeUrl}{proxyPath}` and
//             let the browser load it directly. The iframe's origin is
//             the bridge's, so the iframe's own CSP and fetch context
//             are independent of the extension page. This is the only
//             mode that works for addons whose bundles come from a
//             different origin (the MV3 extension CSP can't be loosened
//             via meta-CSP in srcdoc, so a cross-origin iframe needs
//             its own origin).
//   - "srcdoc": build a self-contained srcdoc by rewriting the upstream
//             HTML. The iframe inherits the parent page's origin and
//             CSP, which means it can ONLY run addons whose bundles are
//             same-origin to the extension (i.e. extension-local). Used
//             for the OpenCode stack where the JS is loaded from
//             chrome-extension://…/src/lib/… (same origin as parent).
export function createAddonIframe({ addonId, proxyPath, addonLabel, apiBasePath, rawFetch, bridgeUrl, bridgeToken = "", mode = "src" }) {
  let currentRequest = null;
  return function renderAddonIframe({ container }) {
    const wrapper = document.createElement("section");
    wrapper.className = `addon-iframe-wrapper addon-iframe-wrapper--${addonId}`;
    wrapper.setAttribute("aria-label", `${addonLabel} workspace`);
    const status = document.createElement("div");
    status.className = "addon-iframe-status";
    status.textContent = `Loading ${addonLabel}...`;
    const frame = document.createElement("div");
    frame.className = "addon-iframe-frame";
    const iframe = document.createElement("iframe");
    iframe.className = "addon-iframe";
    if (mode !== "src") {
      // srcdoc mode: keep the sandbox. The upstream HTML is untrusted
      // enough to warrant it (it can contain arbitrary JS via the
      // bridge-token-injecting preamble).
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-modals");
    }
    // In src mode, no sandbox: the upstream is a trusted same-host SPA
    // and sandbox="allow-scripts allow-same-origin" was triggering
    // Chrome's "iframe can escape its sandboxing" warning AND, more
    // importantly, was blocking the iframe's parser from requesting
    // cross-origin subresources (the bundle, fonts, images all live on
    // the bridge origin which differs from the extension's origin).
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("title", `${addonLabel} workspace`);
    frame.append(iframe);
    wrapper.append(status, frame);
    container.append(wrapper);
    const load = async () => {
      status.textContent = `Loading ${addonLabel}...`;
      currentRequest?.abort();
      const ac = new AbortController();
      currentRequest = ac;
      try {
        if (mode === "src") {
          // src mode: just point the iframe at the bridge proxy. The
          // upstream's session token is embedded in the HTML, and the
          // upstream's CSP / CORS is in charge. We still probe the
          // proxy first to surface auth/connectivity errors as a status
          // banner — a full HTTP error here means the addon is dead.
          const response = await rawFetch(proxyPath, { signal: ac.signal });
          if (!response.ok) {
            let body = "";
            try { body = await response.text(); } catch { /* ignore */ }
            status.textContent = `${addonLabel} returned HTTP ${response.status}: ${body.slice(0, 200)}`;
            status.classList.add("addon-iframe-status--error");
            return;
          }
          // The probe succeeded — drain the body so the connection can
          // be reused, then set the iframe src.
          try { await response.text(); } catch { /* ignore */ }
          const origin = bridgeUrl.replace(/\/+$/, "");
          iframe.src = `${origin}${proxyPath}`;
          status.textContent = `${addonLabel} loading...`;
          status.classList.add("addon-iframe-status--ready");
          // In src mode, the iframe is cross-origin from the extension
          // page, so we cannot read its DOM to detect mount. We rely on
          // the iframe's `load` event firing — when it does, the
          // document is loaded and any subresource fetches are in flight
          // (we already validated the probe above). The status flips
          // to "ready" optimistically; if the React app fails to mount
          // for a CORS reason, the user will see an empty iframe (we
          // can't detect that from the parent due to cross-origin
          // restrictions on contentDocument). The user can refresh
          // the workspace to re-probe.
          iframe.addEventListener("load", () => {
            status.textContent = `${addonLabel} ready.`;
            status.classList.add("addon-iframe-status--ready");
          }, { once: true });
          // Safety: if the load event doesn't fire within 20s (e.g.
          // CORS preflight fails, network stall, the bridge is down),
          // show an explicit error so the user knows the iframe never
          // completed loading.
          setTimeout(() => {
            // Re-check by reading a tiny iframe attribute (allowed
            // cross-origin) — if `src` is still set but the load
            // event never fired, the document is in trouble.
            try {
              // contentWindow is accessible cross-origin but we can't
              // read its document. We CAN check the iframe's complete
              // state via the DOM:
              if (!iframe.dataset.loaded && iframe.isConnected) {
                const maybeLoaded = iframe.contentWindow?.length !== undefined;
                if (maybeLoaded) {
                  status.textContent = `${addonLabel} ready.`;
                  status.classList.add("addon-iframe-status--ready");
                }
              }
            } catch { /* ignore */ }
          }, 20000);
          return;
        }
        const response = await rawFetch(proxyPath, { signal: ac.signal });
        if (!response.ok) {
          let body = "";
          try { body = await response.text(); } catch { /* ignore */ }
          status.textContent = `${addonLabel} returned HTTP ${response.status}: ${body.slice(0, 200)}`;
          return;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!/text\/html|application\/xhtml/i.test(contentType)) {
          // Not HTML. Render as a download link or raw text.
          const text = await response.text();
          status.textContent = `${addonLabel} returned ${contentType}, ${text.length} bytes — open in a new tab to view.`;
          const link = document.createElement("a");
          link.href = proxyPath;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = `Open ${addonLabel} in a new tab`;
          status.appendChild(document.createElement("br"));
          status.appendChild(link);
          return;
        }
        const html = await response.text();
        const srcdoc = buildAddonSrcdoc({
          proxyPath,
          bridgeUrl,
          bridgeToken,
          addonLabel,
          apiBasePath,
          upstreamHtml: html,
        });
        iframe.srcdoc = srcdoc;
        status.textContent = `${addonLabel} loaded (${html.length} bytes).`;
        status.classList.add("addon-iframe-status--ready");
        watchIframeForMount(iframe, status, addonLabel, "srcdoc", html.length);
      } catch (error) {
        if (error?.name === "AbortError") return;
        status.textContent = `${addonLabel} failed to load: ${error instanceof Error ? error.message : String(error)}`;
        status.classList.add("addon-iframe-status--error");
      }
    };
    return { iframe, status, reload: load };
  };
}
