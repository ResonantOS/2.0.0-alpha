#!/usr/bin/env node
// Explicit live proof only: the deterministic runner discovers *.test.mjs.
// Requires an already-running PoC bridge and this worktree's generated config.
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const out = process.env.RESONANTOS_EMBED_LIVE_OUT;
if (!out) throw new Error('RESONANTOS_EMBED_LIVE_OUT is required');
await mkdir(out, { recursive: true });
const extensionPath = path.resolve(import.meta.dirname, '../resonantos-side-panel-extension');
const profile = await mkdtemp(path.join(os.tmpdir(), 'resonantos-embed-live-'));
const started = Date.now();
const summary = { pass: false, messageTypes: [], timingsMs: {}, stage: 'launch' };
let context;
let page;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 420, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
    ...(process.env.RESONANTOS_LIVE_CHROME_PATH ? { executablePath: process.env.RESONANTOS_LIVE_CHROME_PATH } : {}),
  });
  page = await context.newPage();
  // Only retain protocol type labels in the report, never messages or cookies.
  await page.addInitScript(() => {
    window.__embedProofTypes = new Set();
    window.addEventListener('message', event => {
      const frame = document.querySelector('#embed-root iframe');
      if (!frame || event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) return;
      const allowed = ['augmentor-ready', 'augmentor-result', 'augmentor-status', 'augmentor-event', 'augmentor-settings', 'augmentor-hide', 'augmentor-link'];
      if (allowed.includes(event.data?.type)) window.__embedProofTypes.add(event.data.type);
      // Diagnostic trail: protocol fields only (no text, URLs or identifiers).
      window.__embedProofTrail ??= [];
      const d = event.data ?? {};
      if (d.type === 'augmentor-event') window.__embedProofTrail.push(`event:${d.event}${d.data?.reason ? `:${d.data.reason}` : ''}`);
      if (d.type === 'augmentor-result') window.__embedProofTrail.push(`result:ok=${d.ok}${d.code ? `:code=${d.code}` : ''}${d.result ? `:sent=${d.result.sent}` : ''}`);
      if (d.type === 'augmentor-status') window.__embedProofTrail.push(`status:online=${d.online}:busy=${d.busy}`);
      if (window.__embedProofPromptSent && event.data?.type === 'augmentor-event' && event.data.event === 'turn.finished') window.__embedProofFinished = true;
    });
  });
  summary.stage = 'ready';
  const readyStarted = Date.now();
  const url = 'chrome-extension://cdpdmmalhmokbfcfgogoepnjplaakgnl/src/side-panel.html?agentView=embed';
  // Extension cold start can briefly leave its URL unavailable.
  while (true) {
    try { await page.goto(url, { timeout: 10_000 }); break; }
    catch {
      if (Date.now() - readyStarted >= 90_000) throw new Error('Extension did not open');
      await page.waitForTimeout(250);
    }
  }
  await page.waitForFunction(() => window.__resonantosEmbed?.ready === true, null, { timeout: Math.max(1, 90_000 - (Date.now() - readyStarted)) });
  summary.timingsMs.ready = Date.now() - readyStarted;
  summary.stage = 'turn';
  const turnStarted = Date.now();
  await page.evaluate(requestId => {
    window.__embedProofPromptSent = true;
    window.__resonantosEmbed.send({ type: 'augmentor-prompt', requestId, text: 'Reply with exactly: RESONANT-EMBED-OK', send: true, fresh: true });
  }, randomUUID());
  await page.waitForFunction(() => window.__embedProofFinished === true, null, { timeout: 180_000 });
  summary.timingsMs.turn = Date.now() - turnStarted;
  summary.stage = 'reply';
  const inner = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame() && new URL(frame.url()).pathname.startsWith('/embed/'));
  if (!inner) throw new Error('Embedded panel frame not found');
  await inner.getByText('RESONANT-EMBED-OK', { exact: false }).first().waitFor({ timeout: 10_000 });
  const text = await inner.locator('body').innerText();
  if (!text.includes('RESONANT-EMBED-OK')) throw new Error('Expected reply missing');
  summary.stage = 'screenshot';
  await page.screenshot({ path: path.join(out, 'embed-panel.png') });
  summary.pass = true;
  summary.stage = 'complete';
} catch {
  // Playwright errors may contain URLs/tickets; report only the fixed stage.
  summary.error = `Embed live proof failed at ${summary.stage}`;
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(out, 'embed-panel-fail.png') }).catch(() => {});
    const inner = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame());
    // The panel's visible text is model and UI output, not a credential.
    summary.panelTextTail = inner ? (await inner.locator('body').innerText().catch(() => '')).slice(-1200) : 'inner frame not found';
  }
} finally {
  if (page && !page.isClosed()) {
    summary.messageTypes = await page.evaluate(() => [...(window.__embedProofTypes ?? [])]).catch(() => []);
    summary.trail = await page.evaluate(() => (window.__embedProofTrail ?? []).slice(-40)).catch(() => []);
  }
  summary.timingsMs.total = Date.now() - started;
  try { await context?.close(); }
  finally {
    await rm(profile, { recursive: true, force: true });
    await writeFile(path.join(out, 'embed-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
}
console.log(JSON.stringify(summary));
