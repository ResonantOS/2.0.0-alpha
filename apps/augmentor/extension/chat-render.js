// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * Augmentor (powered by DSH) — shared chat renderer (GUI-parity edition).
 *
 * Renders the DSH session.event stream the same way the central Web GUI does:
 *   - user messages with markdown
 *   - "Think" collapsibles with a preview line
 *   - assistant markdown (streaming, throttled re-render)
 *   - compact tool rows: [Name] [description | file path], "Failed" badge,
 *     click to expand full arguments + output
 *   - session title in the header, model chip from request/context
 *   - StatsLine: turns · steps · llm s · tools s · ttft · tok/s · Σ tokens
 *
 * Events rendered: user/message, assistant/chunk, assistant/message,
 * tool/call, tool/result, turn/start, turn/end, step/start, step/end,
 * session/title, request/context, request/header.
 */

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function md(text) {
  // Escape first: no raw-HTML injection from model/tool output; markdown
  // (headings, bold, code, lists, links) still renders via marked.
  return sanitizeLinks(window.marked.parse(escapeHtml(text ?? ''), { gfm: true }))
}

// S4 (audit): escaping neutralizes raw HTML, but MARKDOWN link syntax
// survives — `[x](javascript:…)` reaches the DOM as a live
// <a href="javascript:…">. Today only the MV3 default CSP blocks that;
// this is the second layer (a CSP relaxation or a future rendering context
// must not turn model output into script). After escapeHtml, the only
// remaining obfuscation is GFM's URL whitespace-stripping (java\tscript:)
// plus the URL-spec control-character trim — so check the href after
// decoding our four entities and stripping C0 controls.
const SAFE_HREF_RE = /^(?:https?|mailto|tel|ftp|ssh|sftp):/i
function cleanHref(raw) {
  let s = raw
  for (const [ent, ch] of [['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"']]) {
    s = s.split(ent).join(ch)
  }
  return s.replace(/[\u0000-\u0020]/g, '')
}
function sanitizeLinks(html) {
  return html.replace(/<a\s+href=(["'])(.*?)\1>/gi, (m, q, raw) => {
    const href = cleanHref(raw)
    if (href.startsWith('//')) return m // protocol-relative: resolves against chrome-extension:// — inert
    if (SAFE_HREF_RE.test(href)) return m
    // Unsafe scheme (javascript:, data:, vbscript:, bare-relative tricks):
    // keep the visible text, kill the target.
    return m.replace(q + raw + q, q + '#' + q)
  })
}

function blockText(content) {
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .map((b) =>
      b?.type === 'text'
        ? b.text
        : b?.type === 'reasoning'
          ? ''
          : b?.type === 'tool-result'
            ? blockText(b.content)
            : '',
    )
    .filter(Boolean)
    .join('\n')
}

function prettyArgs(raw) {
  if (typeof raw !== 'string') return JSON.stringify(raw ?? null, null, 2)
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function parseArgs(raw) {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * GUI-parity clipboard write (ui-primitives clipboard.ts): async Clipboard
 * API first, execCommand fallback for hosts without it. Returns true only
 * when the host accepted the write — a refused write must not claim success.
 */
async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }
  if (typeof document.execCommand !== 'function') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

// GUI icon set (ui-primitives icons): 16 px outline copy / check.
const COPY_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z" fill="currentColor"/></svg>'
const CHECK_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z" fill="currentColor"/></svg>'

/**
 * One copy action (GUI MessageIconActions parity): writes plain text to the
 * clipboard and, on an accepted write, swaps the icon to a check for 1 s.
 * Re-clicks while the write is pending or the feedback window is open are
 * ignored; a refused write claims no success.
 */
function makeCopyButton(text) {
  const btn = el('button', 'msgaction')
  btn.type = 'button'
  btn.title = 'Copy'
  btn.setAttribute('aria-label', 'Copy')
  btn.innerHTML = COPY_ICON
  let pending = false
  let timer = null
  btn.addEventListener('click', () => {
    if (pending || btn.classList.contains('copied')) return
    pending = true
    void writeClipboard(text).then((ok) => {
      pending = false
      if (!ok) return
      btn.classList.add('copied')
      btn.innerHTML = CHECK_ICON
      btn.title = 'Copied'
      btn.setAttribute('aria-label', 'Copied')
      timer = setTimeout(() => {
        timer = null
        btn.classList.remove('copied')
        btn.innerHTML = COPY_ICON
        btn.title = 'Copy'
        btn.setAttribute('aria-label', 'Copy')
      }, 1000)
    })
  })
  return btn
}

/** GUI-style tool row label: file path for file tools, description for bash. */
function toolLabel(name, args) {
  if (args?.file_path) return String(args.file_path)
  if (args?.description) return String(args.description)
  if (args?.command) return String(args.command).split('\n')[0].slice(0, 80)
  if (args?.url) return String(args.url)
  return ''
}

function displayName(name) {
  const n = String(name ?? 'tool')
  return n[0].toUpperCase() + n.slice(1)
}

/** Compact token count (GUI StatsLine): 517 / 12.2K / 517K / 1.2M. */
function formatTokens(n) {
  const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Compact duration (GUI StatsLine): 45.2s under a minute, 2m42s from there on. */
function formatDuration(ms) {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/**
 * GUI composer model label: strip the quantization suffix and mark local
 * routes — Qwen3.8-27B-UD-Q6_K_XL + local-qwen → "Qwen3.8-27B (local)".
 */
function displayModel(model, provider) {
  let m = String(model ?? '')
  m = m.replace(/-(?:UD-)?Q\d+[A-Z0-9_]*$/, '')
  if (/local/i.test(String(provider ?? ''))) m += ' (local)'
  return m
}

export function createChatUI(els) {
  const $log = els.log
  const $title = els.title
  const $model = els.model
  const $stats = els.stats
  const $dot = els.dot
  const $status = els.status
  const $input = els.input
  const $send = els.send
  const $top = els.top

  let assistantEl = null // block container: Think(s) + one .md text container
  let textEl = null
  let assistantRaw = ''
  let assistantTimer = null // frameOr() handle
  let reasoningEl = null
  let reasoningRaw = ''
  let reasoningTimer = null // frameOr() handle
  let maxSeq = -1
  // true until the first log replay after a page load or clear() — that replay
  // is history we want to land at the tail of; every later call is either a
  // live event or the 2 s poll and must not fight the user's scroll position.
  let firstLog = true

  // GUI parity: streaming chunks publish at animation-frame priority. rAF
  // runs at most once per frame; the ms fallback guards against rAF stalling
  // (hidden/occluded panel, headless) so a streaming reply never goes silent
  // for more than a quarter second.
  function frameOr(ms, fn) {
    const h = { raf: 0, to: 0, done: false }
    const run = () => {
      if (h.done) return
      h.done = true
      cancelAnimationFrame(h.raf)
      clearTimeout(h.to)
      fn()
    }
    h.raf = requestAnimationFrame(run)
    h.to = setTimeout(run, ms)
    return h
  }
  function cancelFrame(h) {
    if (!h) return
    h.done = true
    cancelAnimationFrame(h.raf)
    clearTimeout(h.to)
  }

  let provider = ''
  const stats = {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftSum: 0,
    ttftN: 0,
    decodeMsSum: 0,
    decodeTokSum: 0,
    inTok: 0,
    outTok: 0,
    cacheTok: 0,
  }
  const stepStart = new Map() // stepKey -> {t, firstChunkT}
  const callStart = new Map() // callId -> t

  function stepKey(turn, step) {
    return `${turn}:${step}`
  }

  // Stick-to-bottom: follow the live tail only while the user is at the
  // bottom (within 80px). Scrolling up pauses following; scrolling back to the
  // bottom resumes it. force (send / fresh history / error) always jumps.
  let pinned = true
  const atBottom = () => $log.scrollHeight - $log.scrollTop - $log.clientHeight < 80
  const syncTopBtn = () => $top?.classList.toggle('show', !atBottom())
  $log.addEventListener('scroll', () => {
    pinned = atBottom()
    syncTopBtn()
  })
  $top?.addEventListener('click', () => $log.scrollTo({ top: 0, behavior: 'smooth' }))
  function scroll(force = false) {
    if (force) pinned = true
    if (force || pinned) $log.scrollTop = $log.scrollHeight
  }

  function ensureAssistantBlock() {
    if (!assistantEl) {
      assistantEl = el('div', 'msg assistant')
      $log.appendChild(assistantEl)
    }
    return assistantEl
  }

  function ensureTextEl() {
    if (!textEl) {
      textEl = el('div', 'md')
      ensureAssistantBlock().appendChild(textEl)
    }
    return textEl
  }

  function renderAssistantNow() {
    if (!textEl) {
      // 0.1.23: history replay has no streamed chunks (the pipe strips
      // assistant/chunk), so nothing else creates the text element —
      // materialize it here whenever there is finalized text to paint.
      // Without this, opened sessions showed only thinking + tool rows and
      // the assistant's prose silently vanished.
      if (!assistantRaw) return
      ensureTextEl()
    }
    textEl.innerHTML = md(assistantRaw)
    // Caret on the live tail while this step is streaming (GUI parity:
    // MarkdownText shows a caret on the streaming block).
    if (assistantRaw) textEl.classList.add('streaming')
  }

  function renderAssistant() {
    if (assistantTimer) return
    assistantTimer = frameOr(250, () => {
      assistantTimer = null
      renderAssistantNow()
      scroll()
    })
  }

  function renderReasoningNow() {
    if (!reasoningEl) return
    const pre = reasoningEl.querySelector('pre')
    if (pre) pre.textContent = reasoningRaw
    const summary = reasoningEl.querySelector('summary')
    const firstLine = reasoningRaw.split('\n')[0].trim()
    if (summary) {
      const preview = firstLine.length > 90 ? firstLine.slice(0, 90) + '…' : firstLine
      summary.innerHTML = ''
      summary.append(el('span', 'think-label', 'Think'))
      if (preview) summary.append(el('span', 'think-preview', preview))
    }
  }

  function renderReasoning() {
    if (reasoningTimer) return
    reasoningTimer = frameOr(250, () => {
      reasoningTimer = null
      renderReasoningNow()
      scroll()
    })
  }

  function flushAssistant() {
    cancelFrame(assistantTimer)
    cancelFrame(reasoningTimer)
    assistantTimer = null
    reasoningTimer = null
    renderReasoningNow()
    renderAssistantNow()
    // After the settle render, the block is no longer streaming.
    if (textEl) textEl.classList.remove('streaming')
    if (assistantEl) {
      const hasThink = !!assistantEl.querySelector('.think')
      if (!hasThink && !(assistantRaw && assistantRaw.trim())) assistantEl.remove()
    }
    assistantEl = null
    textEl = null
    assistantRaw = ''
    reasoningEl = null
    reasoningRaw = ''
  }

  function newStep() {
    flushAssistant()
  }

  function makeThinkBlock() {
    if (reasoningEl) return reasoningEl
    const d = document.createElement('details')
    d.className = 'think'
    const summary = document.createElement('summary')
    d.appendChild(summary)
    d.appendChild(el('pre'))
    const block = ensureAssistantBlock()
    if (textEl) block.insertBefore(d, textEl)
    else block.appendChild(d)
    reasoningEl = d
    return d
  }

  function makeToolRow(name, args, callId) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'toolrow'
    row.append(el('span', 'toolname', displayName(name)))
    const label = toolLabel(name, args)
    if (label) row.append(el('span', 'toollabel', label))
    const body = document.createElement('div')
    body.className = 'toolbody'
    const argsPre = el('pre', 'args', prettyArgs(args))
    const outWrap = el('div', 'outwrap')
    const outLabel = el('div', 'outlabel', 'output')
    outWrap.append(outLabel, el('pre', 'out', ''))
    body.append(el('div', 'outlabel', 'arguments'), argsPre, outWrap)
    row.appendChild(body)
    row.addEventListener('click', () => row.classList.toggle('open'))
    $log.appendChild(row)
    return { row, outWrap }
  }

  function renderEvent(entry) {
    const ev = entry.event
    if (!ev || !ev.type) return
    const data = ev.data ?? {}
    const t = entry.t ?? Date.now()

    switch (ev.type) {
      case 'session/title': {
        if (data.title && $title) $title.textContent = data.title
        break
      }
      case 'request/context': {
        provider = String(data.provider ?? '')
        if (data.model && $model) $model.textContent = displayModel(data.model, provider)
        break
      }
      case 'request/header': {
        const model = data.header?.config?.model
        if (model && $model) $model.textContent = String(model)
        break
      }
      case 'turn/start': {
        stats.turns = Math.max(stats.turns, data.turn)
        break
      }
      case 'step/start': {
        stats.steps++
        stepStart.set(stepKey(data.turn, data.step), { t, firstChunkT: null })
        newStep()
        break
      }
      case 'user/message': {
        // DSH records injected context as user/message too. Its source is
        // extensible: workspace instructions use 'agent-instructions', while
        // runtime snapshots use 'plugin'. Only human sources belong in the
        // chat transcript. Keep legacy messages that predate source metadata.
        // Filter provenance, never the text the user may be asking about.
        if (data.source?.kind && data.source.kind !== 'user') break
        flushAssistant()
        const text = blockText(data.content)
        const m = el('div', 'msg user')
        m.append(el('span', 'who', 'You'))
        const stack = el('div', 'userbody')
        const body = el('div', 'md')
        body.innerHTML = md(text)
        stack.appendChild(body)
        // GUI parity: user messages carry a copy action for the raw text.
        const actions = el('div', 'msgactions')
        actions.appendChild(makeCopyButton(text))
        stack.appendChild(actions)
        m.appendChild(stack)
        $log.appendChild(m)
        // The user just sent a prompt (or history is replaying): land at the
        // tail so the reply is visible.
        scroll(true)
        break
      }
      case 'assistant/chunk': {
        const c = data.chunk
        if (c.type === 'text-delta') {
          ensureTextEl()
          assistantRaw += c.text
          renderAssistant()
        } else if (c.type === 'reasoning-delta') {
          makeThinkBlock()
          reasoningRaw += c.text
          renderReasoning()
        } else if (c.type === 'usage' && c.usage) {
          // mid-stream usage (some providers); final assistant/message wins
        }
        const key = [...stepStart.keys()].pop()
        const rec = key && stepStart.get(key)
        if (rec && rec.firstChunkT == null && (c.type === 'text-delta' || c.type === 'reasoning-delta')) {
          rec.firstChunkT = t
          stats.ttftSum += t - rec.t
          stats.ttftN++
        }
        break
      }
      case 'assistant/message': {
        // Finalize streaming blocks.
        const msg = data.message
        if (msg) {
          const text = (msg.content ?? [])
            .filter((b) => b?.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
          if (text) {
            // Final message is authoritative; adopt it whenever the streamed
            // text is absent or differs (covers providers without chunks).
            if (assistantRaw.trim() !== text.trim()) assistantRaw = text
            // 0.1.23: create the text element up front on history replay (no
            // streamed text-delta will) so the reasoning block lands BEFORE
            // the prose and the copy action after it.
            ensureTextEl()
            // GUI parity: the turn tail exposes a copy action for the
            // finalized message's prose (assistantText: text blocks joined).
            const copyText = (msg.content ?? [])
              .filter((b) => b?.type === 'text')
              .map((b) => b.text)
              .join('')
            const actions = el('div', 'msgactions')
            actions.appendChild(makeCopyButton(copyText))
            ensureAssistantBlock().appendChild(actions)
          }
          const reasoning = (msg.content ?? [])
            .filter((b) => b?.type === 'reasoning')
            .map((b) => b.text)
            .join('\n')
          if (reasoning) {
            if (!reasoningEl) makeThinkBlock()
            if (!reasoningRaw) reasoningRaw = reasoning
            renderReasoning()
          }
          flushAssistant()
        }
        const u = data.usage
        if (u) {
          stats.inTok += u.inputTokens ?? 0
          stats.outTok += u.outputTokens ?? 0
          stats.cacheTok += u.cacheReadTokens ?? 0
          const key = [...stepStart.keys()].pop()
          const rec = key && stepStart.get(key)
          if (rec && rec.firstChunkT && (u.outputTokens ?? 0) > 0) {
            stats.decodeMsSum += Math.max(1, t - rec.firstChunkT)
            stats.decodeTokSum += u.outputTokens ?? 0
          }
          if (rec) stats.llmMs += Math.max(0, t - rec.t)
        }
        break
      }
      case 'tool/call': {
        const args = parseArgs(data.arguments)
        callStart.set(data.callId, t)
        newStep()
        makeToolRow(data.name, args, data.callId)
        break
      }
      case 'tool/result': {
        const callId = data.message?.source?.callId
        if (callId && callStart.has(callId)) {
          stats.toolMs += Math.max(0, t - callStart.get(callId))
          callStart.delete(callId)
        }
        const isError = !!(data.message?.isError)
        const text = blockText(data.message?.content)
        // Attach output to the most recent tool row in this step.
        const rows = $log.querySelectorAll('.toolrow')
        const row = rows[rows.length - 1]
        if (row) {
          const out = row.querySelector('pre.out')
          if (out) out.textContent = text || '(empty)'
          if (isError) {
            row.classList.add('failed')
            row.prepend(el('span', 'failed-badge', 'Failed'))
          }
        } else {
          const d = el('div', 'toolresult' + (isError ? ' err' : ''))
          d.appendChild(el('pre', 'out', text || '(empty)'))
          $log.appendChild(d)
        }
        break
      }
      case 'step/end': {
        stepStart.delete(stepKey(data.turn, data.step))
        break
      }
      case 'turn/end': {
        const failure = data.reason?.kind === 'error' ? data.reason.error?.message : null
        if (failure) {
          flushAssistant()
          const row = el('div', 'toolresult err')
          row.appendChild(el('pre', 'out', failure))
          $log.appendChild(row)
        }
        break
      }
      default:
        break // agent/*, subagent/*, … not rendered
    }
    updateStats()
    scroll()
  }

  /** GUI StatsLine: pipe-separated groups; a group with no data drops out whole. */
  function updateStats() {
    if (!$stats) return
    const groups = []
    if (stats.steps > 0) {
      groups.push(`${stats.turns} turns · ${stats.steps} steps`)
      const durations = []
      if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`)
      if (stats.toolMs > 0) durations.push(`Tool call ${formatDuration(stats.toolMs)}`)
      if (durations.length > 0) groups.push(durations.join(' · '))
      const speeds = []
      if (stats.ttftN > 0) speeds.push(`TTFT avg ${formatDuration(stats.ttftSum / stats.ttftN)}`)
      if (stats.decodeMsSum > 0)
        speeds.push(`${Math.round(stats.decodeTokSum / (stats.decodeMsSum / 1_000))} tok/s`)
      if (speeds.length > 0) groups.push(speeds.join(' · '))
    }
    const billedIn = stats.inTok + stats.cacheTok
    if (billedIn > 0 || stats.outTok > 0) {
      if (billedIn > 0) groups.push(`Cache hit ${Math.round((stats.cacheTok / billedIn) * 100)}%`)
      groups.push(`Input ${formatTokens(billedIn)} tok · Output ${formatTokens(stats.outTok)} tok`)
    }
    const line = groups.join(' | ')
    $stats.textContent = line
    $stats.title = line
  }

  function updateChrome() {
    const { phase, error, running } = ui.state
    if ($dot) $dot.dataset.phase = phase
    if ($status) {
      $status.textContent =
        phase === 'ready'
          ? 'connected'
          : phase === 'connecting'
            ? 'connecting…'
            : phase === 'error'
              // No Connect button: the SW retries on a backoff, so an error
              // state is transient — say what is happening, not what to click.
              ? `reconnecting… (${error ?? 'unknown error'})`
              : running
                ? 'working…'
                : 'disconnected'
    }
    if ($send) $send.disabled = phase !== 'ready' || running
  }

  function applyLog(log) {
    const first = firstLog
    firstLog = false
    for (const entry of log) {
      if (entry.kind === 'event' && entry.event?.seq != null) {
        if (entry.event.seq <= maxSeq) continue
        maxSeq = entry.event.seq
        renderEvent(entry)
      }
    }
    updateChrome()
    // Only the fresh-history replay forces the bottom; live events and poll
    // refreshes follow only while the user is pinned at the bottom.
    scroll(first)
  }

  const ui = {
    state: { phase: 'disconnected', error: null, running: false },
    // Highest event seq rendered so far (-1 = none). The panel sends it as
    // sinceSeq so the SW's 2 s poll reply carries only genuinely new events.
    get lastSeq() {
      return maxSeq
    },
    setState(state) {
      ui.state = { ...ui.state, ...state }
      updateChrome()
    },
    applyLog,
    sendFail(text) {
      $log.appendChild(el('div', 'toolresult err', `send failed: ${text}`))
      scroll(true)
    },
    clear() {
      $log.innerHTML = ''
      flushAssistant()
      textEl = null
      maxSeq = -1
      firstLog = true
      pinned = true
      syncTopBtn()
      stats.turns = stats.steps = stats.llmMs = stats.toolMs = 0
      stats.ttftSum = stats.ttftN = stats.decodeMsSum = stats.decodeTokSum = 0
      stats.inTok = stats.outTok = stats.cacheTok = 0
      stepStart.clear()
      callStart.clear()
      if ($title) $title.textContent = 'Augmentor'
      updateStats()
      updateChrome()
    },
  }
  return ui
}
