import test from 'node:test';
import assert from 'node:assert/strict';
import { embedBarVisible, embedStatusLabel, pageContextMessage, pendingApprovalCount,
  agentViewUrl } from '../resonantos-side-panel-extension/src/lib/embed-bar-model.js';

test('visibility and relay status are explicit', () => {
  assert.equal(embedBarVisible('embed', false), true);
  assert.equal(embedBarVisible('normal', false), false);
  assert.equal(embedBarVisible('normal', true), true);
  assert.equal(embedStatusLabel(null), 'Offline');
  assert.equal(embedStatusLabel({ online: false, busy: true }), 'Offline');
  assert.equal(embedStatusLabel({ online: true, busy: false }), 'Online · idle');
  assert.equal(embedStatusLabel({ online: true, busy: true }), 'Busy');
});

test('context is sanitized and bounded by serialized UTF-8 bytes', () => {
  const message = pageContextMessage({ title: 'Authorization: Bearer private12345',
    url: 'https://user:pass@example.test/article?token=private#secret' });
  assert.deepEqual(message, { type: 'augmentor-context', context: {
    source: 'resonantos', page: { title: 'Authorization: Bearer [redacted]',
      url: 'https://example.test/article' }
  } });
  assert.equal(pageContextMessage({ url: 'chrome-extension://abc/src/side-panel.html' }), null);
  const bounded = pageContextMessage({ title: '🦉'.repeat(12000), url: 'https://example.test/' });
  assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= 16000);
  assert.equal(pageContextMessage({ title: 'Big URL', url: `https://example.test/${'x'.repeat(17000)}` }), null);
});

test('approval count uses the existing queue and never masks unreadable history', () => {
  assert.equal(pendingApprovalCount({ historyState: 'error', jobs: [] }), null);
  assert.equal(pendingApprovalCount({ historyState: 'ready', jobs: [
    { id: 'a', status: 'approval', pendingApproval: { reason: 'Review', step: { type: 'click' } } },
    { id: 'b', status: 'completed' }, { id: 'c', status: 'approval' }
  ] }), 1);
});

test('selection replaces an explicit query and preserves unrelated URL state', () => {
  const explicit = new URL(agentViewUrl('https://test.invalid/p?agentView=embed&x=1#anchor', 'normal'));
  assert.equal(explicit.searchParams.get('agentView'), 'normal');
  assert.equal(explicit.searchParams.get('x'), '1');
  assert.equal(explicit.hash, '#anchor');
  assert.equal(agentViewUrl('https://test.invalid/p', 'embed'), 'https://test.invalid/p');
  assert.throws(() => agentViewUrl('https://test.invalid/p', 'other'), /Invalid assistant/);
});
