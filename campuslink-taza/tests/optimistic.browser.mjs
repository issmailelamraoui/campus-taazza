import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { browserOptions } from './browser-utils.mjs';

// This suite runs only through run-browser.mjs, against its disposable schema.
const origin = process.env.CAMPUS_BROWSER_ORIGIN;
assert.ok(origin && new URL(origin).port === '5174', 'Use the disposable browser runner.');
const browser = await chromium.launch(browserOptions());
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  localStorage.setItem('campus-language', 'fr');
  localStorage.setItem('campus-theme', 'dark');
  localStorage.setItem('campus-navigation-expanded', 'false');
  localStorage.setItem('campus-faculty-panel-expanded', 'false');
  const EventStream = window.EventSource;
  window.__optimisticStreams = [];
  window.EventSource = class extends EventStream {
    constructor(...args) {
      super(...args);
      window.__optimisticStreams.push(this);
    }
  };
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const report = message => console.log(`PASS ${message}`);
const activeGates = new Set();
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Gate a real request either before the server sees it, or after the server
// commits it but before the acknowledgement reaches the browser.
async function gate(path, method, { count = 1, after = false } = {}) {
  const entries = [], waiting = new Map();
  let reserved = 0;
  const pattern = `${origin}/api${path}`;
  const handler = async route => {
    if (route.request().method() !== method || reserved >= count) return route.continue();
    const index = reserved++;
    const release = deferred(), done = deferred();
    const request = route.request();
    const entry = {
      request,
      payload: request.postData() ? request.postDataJSON() : null,
      release: result => release.resolve(result || 'pass'),
      done: done.promise,
    };
    entries[index] = entry;
    try {
      let response;
      if (after) {
        response = await route.fetch();
        entry.response = await response.json();
        entry.status = response.status();
      }
      entry.ready = true;
      waiting.get(index)?.resolve(entry);
      const result = await release.promise;
      if (result === 'fail') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Échec temporaire injecté par le test.' }) });
        done.resolve({ status: 503 });
      } else {
        response ||= await route.fetch();
        entry.response ||= await response.json();
        entry.status ||= response.status();
        await route.fulfill({ response });
        done.resolve({ status: entry.status, body: entry.response });
      }
    } catch (error) {
      waiting.get(index)?.reject(error);
      done.reject(error);
    }
  };
  await page.route(pattern, handler);
  const result = {
    entries,
    entered(index = 0) {
      if (entries[index]?.ready) return Promise.resolve(entries[index]);
      if (!waiting.has(index)) waiting.set(index, deferred());
      return Promise.race([
        waiting.get(index).promise,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method} ${path} #${index + 1}`)), 30000);
          waiting.get(index).promise.finally(() => clearTimeout(timer)).catch(() => {});
        }),
      ]);
    },
    async close() {
      await Promise.all(entries.map(entry => entry.done));
      await page.unroute(pattern, handler);
      activeGates.delete(result);
    },
  };
  activeGates.add(result);
  return result;
}

async function bootstrap() {
  const response = await context.request.get(`${origin}/api/bootstrap`);
  assert.ok(response.ok(), `Bootstrap returned ${response.status()}`);
  return response.json();
}

async function send(content) {
  await page.locator('.chat-composer textarea').fill(content);
  await page.locator('.composer-send').click();
}

const byText = content => page.locator('.chat-message').filter({ has: page.locator('.message-text').filter({ hasText: content }) });
const row = id => page.locator(`#message-${id}`);
const saveButton = id => row(id).locator('.message-meta button[aria-label="Enregistrer"]');
async function menuAction(id, label) {
  await row(id).getByRole('button', { name: 'Actions du message', exact: true }).click();
  await row(id).locator('.message-menu').getByRole('button', { name: label, exact: true }).click();
}

async function externalMessage(content) {
  const response = await context.request.post(`${origin}/api/messages`, { data: { channel: 'general', content, client_id: randomUUID() } });
  assert.ok(response.ok(), `External fixture message returned ${response.status()}`);
  return response.json();
}

async function chat() {
  await page.goto(`${origin}/app/chat/general`);
  await page.locator('.chat-message').first().waitFor();
  await page.waitForFunction(() => window.__optimisticStreams.some(stream => stream.readyState === 1));
}

try {
  const login = await context.request.post(`${origin}/api/login`, { data: { username: 'admin', password: 'Admin2026!' } });
  assert.ok(login.ok());
  await chat();

  // A stale refresh must project both local drafts while neither POST has
  // reached the server, and the composer must stay available for a second send.
  const stale = await gate('/bootstrap', 'GET', { after: true });
  await externalMessage('Optimistic fixture refresh trigger.');
  const snapshot = await stale.entered();
  const batch = await gate('/messages', 'POST', { count: 2 });
  const firstText = 'Optimistic browser: first delayed message.';
  const secondText = 'Optimistic browser: second independent message.';
  await send(firstText);
  const first = await batch.entered(0);
  await expect(page.locator('.chat-composer textarea')).toHaveValue('');
  await expect(byText(firstText)).toHaveAttribute('data-status', 'pending');
  await expect(byText(firstText).locator('.message-hover-actions')).toHaveCount(0);
  await send(secondText);
  const second = await batch.entered(1);
  await expect(byText(secondText)).toHaveAttribute('data-status', 'pending');
  assert.notEqual(first.payload.client_id, second.payload.client_id);
  snapshot.release();
  await snapshot.done;
  await expect(byText(firstText)).toHaveAttribute('data-status', 'pending');
  await expect(byText(secondText)).toHaveAttribute('data-status', 'pending');
  first.release(); second.release();
  assert.ok((await first.done).status < 300);
  assert.ok((await second.done).status < 300);
  await batch.close(); await stale.close();
  await expect(byText(firstText)).toHaveCount(1);
  await expect(byText(firstText)).toHaveAttribute('data-status', 'sent');
  await expect(byText(secondText)).toHaveCount(1);
  await expect(byText(secondText)).toHaveAttribute('data-status', 'sent');
  report('composer clears immediately; multiple pending sends survive a stale bootstrap');

  // SSE can publish the stored UUID before its held POST acknowledgement.
  const earlyAck = await gate('/messages', 'POST', { after: true });
  const earlyText = 'Optimistic browser: SSE before POST acknowledgement.';
  await send(earlyText);
  const early = await earlyAck.entered();
  assert.ok(early.status < 300);
  await expect(byText(earlyText)).toHaveAttribute('data-status', 'sent');
  await expect(byText(earlyText)).toHaveCount(1);
  assert.equal(await byText(earlyText).getAttribute('data-client-id'), early.payload.client_id);
  early.release(); await early.done; await earlyAck.close();
  await expect(byText(earlyText)).toHaveCount(1);
  report('SSE reconciliation before acknowledgement produces one real message');

  const failingSend = await gate('/messages', 'POST');
  const retryText = 'Optimistic browser: retry preserves the client UUID.';
  await send(retryText);
  const failed = await failingSend.entered();
  const clientId = failed.payload.client_id;
  assert.match(clientId, /^[a-f0-9-]{36}$/i);
  failed.release('fail'); await failed.done; await failingSend.close();
  await expect(byText(retryText)).toHaveAttribute('data-status', 'failed');
  await expect(page.locator('.chat-composer textarea')).toHaveValue('');
  const retry = await gate('/messages', 'POST');
  await byText(retryText).getByRole('button', { name: 'Réessayer', exact: true }).click();
  const retryRequest = await retry.entered();
  assert.equal(retryRequest.payload.client_id, clientId);
  await expect(byText(retryText)).toHaveAttribute('data-status', 'pending');
  retryRequest.release(); await retryRequest.done; await retry.close();
  await expect(byText(retryText)).toHaveAttribute('data-status', 'sent');
  await expect(byText(retryText)).toHaveCount(1);
  const storedRetry = (await bootstrap()).messages.filter(message => message.client_id === clientId);
  assert.equal(storedRetry.length, 1);
  report('failed send remains visible; retry uses its original UUID and stores one row');

  const discardedSend = await gate('/messages', 'POST');
  const discardedText = 'Optimistic browser: discard failed draft.';
  await send(discardedText);
  const discarded = await discardedSend.entered();
  discarded.release('fail'); await discarded.done; await discardedSend.close();
  await expect(byText(discardedText)).toHaveAttribute('data-status', 'failed');
  await byText(discardedText).getByRole('button', { name: 'Retirer ce message', exact: true }).click();
  await expect(byText(discardedText)).toHaveCount(0);
  assert.equal((await bootstrap()).messages.some(message => message.client_id === discarded.payload.client_id), false);
  report('failed draft can be discarded without a server message');

  const baseline = await bootstrap();
  const source = baseline.messages.find(message => message.id === 3);
  assert.ok(source && !source.pinned);
  const pin = await gate('/messages/3/pin', 'POST');
  await menuAction(3, 'Épingler dans les annonces');
  const pinRequest = await pin.entered();
  await expect(row(3)).toHaveClass(/pinned-message/);
  await page.locator('.chat-header').getByRole('link', { name: 'Messages épinglés', exact: true }).click();
  await page.waitForURL('**/app/announcements');
  const announcement = page.locator('.announcement-card').filter({ hasText: source.content });
  await expect(announcement).toHaveCount(1);
  pinRequest.release();
  const pinResult = await pinRequest.done; await pin.close();
  assert.ok(pinResult.body.pinned);
  await expect(announcement).toHaveCount(1);
  await expect(announcement).toHaveAttribute('id', `announcement-${pinResult.body.announcement.id}`);
  await announcement.locator('.announcement-footer a').click();
  await row(3).waitFor();
  report('pin and announcement card appear immediately and reconcile to one stored announcement');

  const unpin = await gate('/messages/3/pin', 'POST');
  await menuAction(3, 'Retirer des annonces');
  const unpinRequest = await unpin.entered();
  await expect(row(3)).not.toHaveClass(/pinned-message/);
  await page.locator('.chat-header').getByRole('link', { name: 'Messages épinglés', exact: true }).click();
  await page.waitForURL('**/app/announcements');
  await expect(announcement).toHaveCount(0);
  unpinRequest.release('fail'); await unpinRequest.done; await unpin.close();
  await expect(announcement).toHaveCount(1);
  await announcement.locator('.announcement-footer a').click();
  await expect(row(3)).toHaveClass(/pinned-message/);
  report('failed unpin restores the chat marker and announcement');

  const oldCount = Number(await row(3).locator('.reaction.like span').textContent());
  const reaction = await gate('/messages/3/reaction', 'POST');
  await row(3).locator('.reaction.like').click();
  const reactionRequest = await reaction.entered();
  await expect(row(3).locator('.reaction.like')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(3).locator('.reaction.like span')).toHaveText(String(oldCount + 1));
  reactionRequest.release('fail'); await reactionRequest.done; await reaction.close();
  await expect(row(3).locator('.reaction.like')).toHaveAttribute('aria-pressed', 'false');
  await expect(row(3).locator('.reaction.like span')).toHaveText(String(oldCount));
  const reactionSuccess = await gate('/messages/3/reaction', 'POST');
  await row(3).locator('.reaction.like').click();
  const successfulReaction = await reactionSuccess.entered();
  await expect(row(3).locator('.reaction.like span')).toHaveText(String(oldCount + 1));
  successfulReaction.release(); await successfulReaction.done; await reactionSuccess.close();
  await expect(row(3).locator('.reaction.like')).toHaveAttribute('aria-pressed', 'true');
  report('reaction counts and aria state update immediately; failure restores their previous values');

  const save = await gate('/saved', 'POST');
  await saveButton(3).click();
  const saveRequest = await save.entered();
  await expect(saveButton(3)).toHaveClass(/is-saved/);
  saveRequest.release(); await saveRequest.done; await save.close();
  await expect(saveButton(3)).toHaveClass(/is-saved/);
  const failedUnsave = await gate('/saved', 'POST');
  await saveButton(3).click();
  const unsaveRequest = await failedUnsave.entered();
  await expect(saveButton(3)).not.toHaveClass(/is-saved/);
  await row(4).locator('.reaction.heart').click();
  await expect(row(4).locator('.reaction.heart')).toHaveAttribute('aria-pressed', 'true');
  unsaveRequest.release('fail'); await unsaveRequest.done; await failedUnsave.close();
  await expect(saveButton(3)).toHaveClass(/is-saved/);
  await expect(row(4).locator('.reaction.heart')).toHaveAttribute('aria-pressed', 'true');
  report('bookmark changes immediately; its rollback preserves another message’s successful reaction');

  const retryMessage = (await bootstrap()).messages.find(message => message.client_id === clientId);
  const deleteFailure = await gate(`/messages/${retryMessage.id}`, 'DELETE');
  await menuAction(retryMessage.id, 'Supprimer le message');
  const deleteFailedRequest = await deleteFailure.entered();
  await expect(row(retryMessage.id)).toHaveCount(0);
  deleteFailedRequest.release('fail'); await deleteFailedRequest.done; await deleteFailure.close();
  await expect(row(retryMessage.id)).toHaveCount(1);
  const deleteSuccess = await gate(`/messages/${retryMessage.id}`, 'DELETE');
  await menuAction(retryMessage.id, 'Supprimer le message');
  const deleteRequest = await deleteSuccess.entered();
  await expect(row(retryMessage.id)).toHaveCount(0);
  deleteRequest.release(); await deleteRequest.done; await deleteSuccess.close();
  assert.equal((await bootstrap()).messages.some(message => message.id === retryMessage.id), false);
  await expect(row(retryMessage.id)).toHaveCount(0);
  report('delete removes the row immediately; failure restores it and success persists removal');

  assert.deepEqual(errors, [], 'No browser runtime errors');
  report('optimistic browser suite has no runtime errors');
} catch (error) {
  await page.screenshot({ path: '/tmp/campuslink-optimistic-browser-failure.png' }).catch(() => {});
  throw error;
} finally {
  for (const pending of activeGates) for (const entry of pending.entries) entry.release('fail');
  await context.close();
  await browser.close();
}
