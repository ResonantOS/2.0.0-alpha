#!/usr/bin/env node
// Manual real-harness proof; excluded from deterministic *.test.mjs discovery.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
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
const summary = { pass: false, checks: {}, messageTypes: [], timingsMs: {}, stage: 'fixture' };
const fixtureTitle = `Resonant Fixture ${randomUUID()}`;
const fixtureServer = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><html><head><title>${fixtureTitle}</title></head><body><h1>Local page sharing fixture</h1><p>Read the document title.</p></body></html>`);
});
let context, page;
const observedTypes = new Set();
async function statusOnline() {
  await page.waitForFunction(() => {
    const node = document.querySelector('#resonantos-bar [data-control=status]');
    return ['online', 'busy'].includes(node?.dataset.state);
  }, null, { timeout: 90000 });
}
async function verifyLayout(width) {
  await page.setViewportSize({ width, height: 900 });
  const metrics = await page.evaluate(() => {
    const bar = document.querySelector('#resonantos-bar');
    const root = document.querySelector('#embed-root');
    const frame = root.querySelector('iframe');
    const b = bar.getBoundingClientRect(), f = frame.getBoundingClientRect();
    return { barHeight: b.height, top: b.top, bottom: b.bottom, frameTop: f.top,
      frameBottom: f.bottom, height: innerHeight, width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      sibling: bar.nextElementSibling === root };
  });
  assert.ok(metrics.barHeight > 0 && metrics.barHeight <= 36);
  assert.equal(metrics.top, 0);
  assert.equal(metrics.sibling, true);
  assert.ok(Math.abs(metrics.frameTop - metrics.bottom) <= 1);
  assert.ok(Math.abs(metrics.frameBottom - metrics.height) <= 1);
  assert.ok(metrics.scrollWidth <= metrics.width);
}
async function chooseAssistant(value) {
  await page.locator('#resonantos-bar [data-control=assistant]').click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.locator(`#resonantos-bar [data-mode=${value}]`).click()
  ]);
  assert.equal(await page.evaluate(async () =>
    (await chrome.storage.local.get('resonantos.agentView'))['resonantos.agentView']), value);
  assert.equal(new URL(page.url()).searchParams.get('agentView'), value);
}
try {
  fixtureServer.listen(0, '127.0.0.1');
  await once(fixtureServer, 'listening');
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fixture`;
  summary.stage = 'launch';
  context = await chromium.launchPersistentContext(profile, {
    headless: false, viewport: { width: 420, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      '--no-first-run', '--no-default-browser-check'],
    ...(process.env.RESONANTOS_LIVE_CHROME_PATH ? { executablePath: process.env.RESONANTOS_LIVE_CHROME_PATH } : {})
  });
  // Close only pages in this new, test-owned profile; never attach to a personal profile.
  const initialPages = context.pages();
  const fixturePage = await context.newPage();
  await fixturePage.goto(fixtureUrl);
  for (const initialPage of initialPages) await initialPage.close();
  page = await context.newPage();
  await page.addInitScript(() => {
    window.__embedProofTypes = new Set();
    window.__embedProofFinished = false;
    window.addEventListener('message', event => {
      const frame = document.querySelector('#embed-root iframe');
      if (!frame || event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) return;
      const data = event.data;
      const allowed = ['augmentor-ready', 'augmentor-result', 'augmentor-status', 'augmentor-event',
        'augmentor-settings', 'augmentor-hide', 'augmentor-link'];
      if (allowed.includes(data?.type)) window.__embedProofTypes.add(data.type);
      if (window.__embedProofPromptSent && data?.type === 'augmentor-event' && data.event === 'turn.finished') {
        window.__embedProofFinished = true;
      }
    });
  });
  summary.stage = 'ready';
  const readyStarted = Date.now();
  const url = 'chrome-extension://cdpdmmalhmokbfcfgogoepnjplaakgnl/src/side-panel.html?agentView=embed';
  while (true) {
    try { await page.goto(url, { timeout: 10000 }); break; }
    catch {
      if (Date.now() - readyStarted >= 90000) throw new Error('Extension did not open');
      await page.waitForTimeout(250);
    }
  }
  await page.waitForFunction(() => window.__resonantosEmbed?.ready === true, null, { timeout: 90000 });
  summary.timingsMs.ready = Date.now() - readyStarted;
  await statusOnline(); summary.checks.online = true;
  summary.stage = 'layout';
  await verifyLayout(420); summary.checks.layout420 = true;
  await verifyLayout(320); summary.checks.layout320 = true;
  await page.setViewportSize({ width: 420, height: 900 });
  summary.stage = 'workspace';
  const workspacePromise = context.waitForEvent('page');
  await page.locator('#resonantos-bar [data-control=workspace]').click();
  const workspace = await workspacePromise;
  await workspace.waitForURL('**/src/main-workspace.html');
  await page.waitForFunction(() =>
    document.querySelector('#resonantos-bar [data-control=workspace]')?.getAttribute('aria-pressed') === 'true');
  summary.checks.workspace = true;
  await page.bringToFront();
  summary.stage = 'fixture-context';
  // Verify the production resolver has only one readable HTTP(S) candidate.
  const readable = await page.evaluate(async () =>
    (await chrome.tabs.query({ currentWindow: true })).filter(tab => /^https?:\/\//i.test(tab.url ?? '')).map(tab => tab.url));
  assert.deepEqual(readable, [fixtureUrl]);
  await page.evaluate(() => {
    window.__barProofContexts = [];
    const state = window.__resonantosEmbed;
    const original = state.send;
    state.send = message => {
      const accepted = original(message);
      if (message?.type === 'augmentor-context' && accepted) {
        window.__barProofContexts.push(message.context);
      }
      return accepted;
    };
  });
  await page.locator('#resonantos-bar [data-control=page]').click();
  await page.locator('#resonantos-bar [role=status]').filter({ hasText: 'Page shared' }).waitFor();
  const shared = await page.evaluate(() => window.__barProofContexts);
  assert.deepEqual(shared, [{ source: 'resonantos', page: { title: fixtureTitle, url: fixtureUrl } }]);
  summary.checks.fixtureContext = true;
  const inner = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame()
    && new URL(frame.url()).pathname.startsWith('/embed/'));
  assert.ok(inner, 'Embedded panel frame missing');
  // A title already displayed in a context badge must not count as a model reply.
  const exactTitleBefore = await inner.getByText(fixtureTitle, { exact: true }).count();
  summary.stage = 'fixture-turn';
  const turnStarted = Date.now();
  const accepted = await page.evaluate(requestId => {
    window.__embedProofPromptSent = true;
    window.__embedProofFinished = false;
    return window.__resonantosEmbed.send({ type: 'augmentor-prompt', requestId,
      text: 'What is the title of the page shared by ResonantOS? Reply with exactly that title and no other text.',
      send: true, fresh: true });
  }, randomUUID());
  assert.equal(accepted, true);
  await page.waitForFunction(() => window.__embedProofFinished === true, null, { timeout: 180000 });
  const replyDeadline = Date.now() + 10000;
  while (await inner.getByText(fixtureTitle, { exact: true }).count() <= exactTitleBefore) {
    if (Date.now() >= replyDeadline) throw new Error('Fixture title reply missing');
    await page.waitForTimeout(100);
  }
  summary.timingsMs.turn = Date.now() - turnStarted;
  summary.checks.fixtureReply = true;
  await statusOnline();
  await page.screenshot({ path: path.join(out, 'bar-embed.png') });
  for (const type of await page.evaluate(() => [...window.__embedProofTypes])) observedTypes.add(type);
  summary.stage = 'normal';
  await chooseAssistant('normal');
  await page.locator('#normal-chat-root #command-input').waitFor({ state: 'visible' });
  await page.locator('#resonantos-bar [data-control=assistant]').waitFor();
  assert.deepEqual(await page.locator('#resonantos-bar [data-control]').evaluateAll(nodes =>
    nodes.map(node => node.dataset.control)), ['assistant']);
  assert.equal(await page.locator('#embed-root').count(), 0);
  summary.checks.normal = true;
  await page.screenshot({ path: path.join(out, 'bar-normal.png') });
  summary.stage = 'back-to-embed';
  await chooseAssistant('embed');
  await page.waitForFunction(() => window.__resonantosEmbed?.ready === true, null, { timeout: 90000 });
  await statusOnline(); await verifyLayout(420);
  summary.checks.backToEmbed = true;
  assert.deepEqual(summary.checks, {
    layout420: true, layout320: true, online: true, workspace: true,
    fixtureContext: true, fixtureReply: true, normal: true, backToEmbed: true
  });
  summary.pass = true; summary.stage = 'complete';
} catch {
  summary.error = `Embed live proof failed at ${summary.stage}`;
  process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'bar-fail.png') }).catch(() => {});
} finally {
  if (page && !page.isClosed()) {
    for (const type of await page.evaluate(() => [...(window.__embedProofTypes ?? [])]).catch(() => [])) observedTypes.add(type);
  }
  summary.messageTypes = [...observedTypes].sort();
  summary.timingsMs.total = Date.now() - started;
  try { await context?.close(); }
  finally {
    fixtureServer.closeAllConnections();
    if (fixtureServer.listening) await new Promise(resolve => fixtureServer.close(resolve));
    await rm(profile, { recursive: true, force: true });
    await writeFile(path.join(out, 'embed-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
}
console.log(JSON.stringify(summary));
