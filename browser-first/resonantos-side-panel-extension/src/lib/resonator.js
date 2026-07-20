/**
 * Resonator visual guide layer.
 *
 * Restored from the retired browser-first branch with idempotent loading and
 * explicit timer cleanup. It only draws transient visual overlays.
 */
(function (root) {
  "use strict";

  if (root.Resonator?.__resonantOSResonatorVersion) return;

  const DATA_ATTR = "data-resonator";
  const STYLE_ID = "resonator-styles";
  const COLOR_GREEN = "#14F195";
  const COLOR_PURPLE = "#9945FF";
  const timers = new Set();
  const clickDisposers = new Set();

  function addTimer(callback, ms) {
    const timer = root.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, ms);
    timers.add(timer);
    return timer;
  }

  function clearTimers() {
    timers.forEach((timer) => root.clearTimeout(timer));
    timers.clear();
    clickDisposers.forEach((dispose) => dispose());
    clickDisposers.clear();
  }

  function injectStyles(doc = root.document) {
    if (!doc?.head) return;
    const existing = doc.getElementById(STYLE_ID);
    if (existing?.getAttribute("data-resonantos-owned") === "true") return;
    if (existing) existing.remove();
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute("data-resonantos-owned", "true");
    style.textContent = `
      @keyframes resonator-pulse {
        0% { box-shadow: 0 0 0 0 rgba(20,241,149,0.75); }
        70% { box-shadow: 0 0 0 14px rgba(20,241,149,0); }
        100% { box-shadow: 0 0 0 0 rgba(20,241,149,0); }
      }
      @keyframes resonator-pulse-purple {
        0% { box-shadow: 0 0 0 0 rgba(153,69,255,0.75); }
        70% { box-shadow: 0 0 0 14px rgba(153,69,255,0); }
        100% { box-shadow: 0 0 0 0 rgba(153,69,255,0); }
      }
      @keyframes resonator-bob {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-7px); }
      }
      @keyframes resonator-fadein {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes resonator-step-pop {
        0% { transform: scale(0.4); opacity: 0; }
        80% { transform: scale(1.15); }
        100% { transform: scale(1); opacity: 1; }
      }
    `;
    doc.head.appendChild(style);
  }

  function findElement(selector, text, doc = root.document) {
    if (!doc?.querySelector) return null;
    if (selector) {
      try {
        const element = doc.querySelector(selector);
        if (element) return element;
      } catch {
        // Bad selector: fall through to visible text lookup.
      }
    }
    if (!text) return null;
    const needle = String(text).toLowerCase().trim();
    if (!needle) return null;
    const candidates = "button, a, [role='button'], input, select, textarea, h1, h2, h3, h4, h5, label, span, div, p, li, summary";
    return Array.from(doc.querySelectorAll(candidates)).find((element) => {
      const visible = (
        element.textContent ||
        element.value ||
        element.getAttribute("aria-label") ||
        element.getAttribute("placeholder") ||
        ""
      ).toLowerCase().trim();
      return visible && (visible.includes(needle) || needle.includes(visible));
    }) ?? null;
  }

  function restoreHighlight(target) {
    if (target?.getAttribute?.(DATA_ATTR) !== "highlight") return;
    const saved = target._resonatorStyle;
    target.removeAttribute(DATA_ATTR);
    if (saved !== undefined) target.setAttribute("style", saved);
    delete target._resonatorStyle;
  }

  function clear() {
    const doc = root.document;
    clearTimers();
    doc?.querySelectorAll?.(`[${DATA_ATTR}]`).forEach((element) => {
      if (element.getAttribute(DATA_ATTR) === "highlight") {
        restoreHighlight(element);
      } else {
        element.remove();
      }
    });
    doc?.querySelectorAll?.("#resonator-svg").forEach((element) => element.remove());
  }

  function highlight({ selector, text, color = COLOR_GREEN, duration = 3000 } = {}) {
    injectStyles();
    const target = findElement(selector, text || selector);
    if (!target) {
      return { ok: false, error: `Resonator: no element matched selector="${selector || ""}" text="${text || ""}"` };
    }

    target._resonatorStyle = target.getAttribute("style") || "";
    target.setAttribute(DATA_ATTR, "highlight");
    const pulse = color.toLowerCase() === COLOR_PURPLE.toLowerCase() ? "resonator-pulse-purple" : "resonator-pulse";
    target.style.outline = `3px solid ${color}`;
    target.style.outlineOffset = "2px";
    target.style.borderRadius = "4px";
    target.style.animation = `${pulse} 1.5s ease-in-out infinite`;
    target.style.position = target.style.position || "relative";
    target.style.zIndex = "999990";
    target.scrollIntoView?.({ block: "center", behavior: "smooth" });
    addTimer(() => restoreHighlight(target), Number(duration) > 0 ? Number(duration) : 3000);
    return { ok: true };
  }

  function arrow({ selector, text, label, duration = 5000 } = {}) {
    injectStyles();
    const doc = root.document;
    const target = findElement(selector, text || selector, doc);
    if (!target || !doc?.body) return { ok: false, error: "Resonator: no element found for arrow" };
    target.scrollIntoView?.({ block: "center", behavior: "smooth" });
    addTimer(() => {
      const rect = target.getBoundingClientRect();
      const wrapper = doc.createElement("div");
      wrapper.setAttribute(DATA_ATTR, "arrow");
      wrapper.style.cssText = [
        "position:absolute",
        `left:${Math.round(rect.left + root.scrollX + rect.width / 2 - 20)}px`,
        `top:${Math.round(rect.top + root.scrollY - 70)}px`,
        "z-index:999999",
        "pointer-events:none",
        "text-align:center",
        "animation:resonator-bob 1s ease-in-out infinite, resonator-fadein 0.3s ease",
        "filter:drop-shadow(0 0 8px rgba(20,241,149,0.8))",
      ].join(";");
      if (label) {
        const labelNode = doc.createElement("div");
        labelNode.textContent = label;
        labelNode.style.cssText = "font-family:sans-serif;font-size:12px;font-weight:700;color:#000;background:#14F195;border-radius:4px;padding:2px 10px;margin-bottom:4px;white-space:nowrap;display:inline-block";
        wrapper.appendChild(labelNode);
      }
      const arrowNode = doc.createElement("div");
      arrowNode.textContent = "v";
      arrowNode.style.cssText = "font-size:30px;color:#14F195;line-height:1;";
      wrapper.appendChild(arrowNode);
      doc.body.appendChild(wrapper);
      const removeTimer = addTimer(() => wrapper.remove(), Number(duration) > 0 ? Number(duration) : 5000);
      const dismiss = () => {
        root.clearTimeout(removeTimer);
        timers.delete(removeTimer);
        wrapper.remove();
        doc.removeEventListener("click", dismiss);
        clickDisposers.delete(dispose);
      };
      const dispose = () => doc.removeEventListener("click", dismiss);
      clickDisposers.add(dispose);
      addTimer(() => doc.addEventListener("click", dismiss), 300);
    }, 420);
    return { ok: true };
  }

  function spotlight({ selector, text, label } = {}) {
    injectStyles();
    const doc = root.document;
    const target = findElement(selector, text || selector, doc);
    if (!target || !doc?.body) return { ok: false, error: "Resonator: no element found for spotlight" };
    target.scrollIntoView?.({ block: "center", behavior: "smooth" });
    addTimer(() => {
      const rect = target.getBoundingClientRect();
      const pad = 14;
      const backdrop = doc.createElement("div");
      backdrop.setAttribute(DATA_ATTR, "spotlight");
      backdrop.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:999997;cursor:pointer;animation:resonator-fadein 0.3s ease";
      const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.id = "resonator-svg";
      svg.setAttribute(DATA_ATTR, "spotlight");
      svg.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999998;animation:resonator-fadein 0.3s ease";
      const mask = doc.createElementNS("http://www.w3.org/2000/svg", "mask");
      mask.id = "resonator-mask";
      const bg = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      bg.setAttribute("width", "100%");
      bg.setAttribute("height", "100%");
      bg.setAttribute("fill", "white");
      const hole = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      hole.setAttribute("x", String(rect.left - pad));
      hole.setAttribute("y", String(rect.top - pad));
      hole.setAttribute("width", String(rect.width + pad * 2));
      hole.setAttribute("height", String(rect.height + pad * 2));
      hole.setAttribute("rx", "6");
      hole.setAttribute("fill", "black");
      mask.append(bg, hole);
      const defs = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
      defs.appendChild(mask);
      svg.appendChild(defs);
      const dim = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      dim.setAttribute("width", "100%");
      dim.setAttribute("height", "100%");
      dim.setAttribute("fill", "rgba(0,0,0,0.72)");
      dim.setAttribute("mask", "url(#resonator-mask)");
      svg.appendChild(dim);
      const glow = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      glow.setAttribute("x", String(rect.left - pad));
      glow.setAttribute("y", String(rect.top - pad));
      glow.setAttribute("width", String(rect.width + pad * 2));
      glow.setAttribute("height", String(rect.height + pad * 2));
      glow.setAttribute("rx", "6");
      glow.setAttribute("fill", "none");
      glow.setAttribute("stroke", COLOR_GREEN);
      glow.setAttribute("stroke-width", "2.5");
      svg.appendChild(glow);
      doc.body.append(backdrop, svg);
      if (label) {
        const labelNode = doc.createElement("div");
        labelNode.textContent = label;
        labelNode.setAttribute(DATA_ATTR, "spotlight");
        labelNode.style.cssText = `position:fixed;left:${rect.left - pad}px;top:${Math.max(6, rect.top - pad - 38)}px;background:#14F195;color:#000;font-family:sans-serif;font-weight:700;font-size:13px;padding:4px 12px;border-radius:4px;z-index:999999;pointer-events:none;animation:resonator-fadein 0.3s ease`;
        doc.body.appendChild(labelNode);
      }
      backdrop.addEventListener("click", clear, { once: true });
    }, 420);
    return { ok: true };
  }

  function step({ steps } = {}) {
    injectStyles();
    const doc = root.document;
    if (!Array.isArray(steps) || !steps.length || !doc?.body) return { ok: false, error: "Resonator: no steps provided" };
    let placed = 0;
    steps.forEach((item, index) => {
      const target = findElement(item.selector, item.text || item.selector, doc);
      if (!target) return;
      placed += 1;
      target.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      addTimer(() => {
        const rect = target.getBoundingClientRect();
        const badge = doc.createElement("div");
        badge.setAttribute(DATA_ATTR, "step");
        badge.style.cssText = [
          "position:absolute",
          `left:${Math.round(rect.left + root.scrollX - 18)}px`,
          `top:${Math.round(rect.top + root.scrollY - 18)}px`,
          "z-index:999999",
          "width:30px;height:30px;border-radius:50%",
          `background:${COLOR_PURPLE}`,
          "color:#fff;font-family:sans-serif;font-weight:900;font-size:14px",
          "display:flex;align-items:center;justify-content:center",
          "box-shadow:0 0 0 3px rgba(153,69,255,0.35)",
          `animation:resonator-step-pop 0.4s ease ${index * 0.18}s both`,
        ].join(";");
        badge.textContent = String(index + 1);
        if (item.label) badge.title = item.label;
        doc.body.appendChild(badge);
      }, index * 180);
    });
    return { ok: placed > 0, placed, total: steps.length };
  }

  const api = Object.freeze({
    __resonantOSResonatorVersion: "1.0.0",
    arrow,
    clear,
    highlight,
    spotlight,
    step,
  });

  root.Resonator = api;
  injectStyles();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
