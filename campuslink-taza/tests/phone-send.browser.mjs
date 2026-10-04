import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { browserOptions } from './browser-utils.mjs';

// Every API is mocked, including the event stream. This independent suite must
// use non-localhost HTTP to reproduce a phone opening the computer's LAN URL.
const address = Object.values(networkInterfaces()).flat().find(entry => entry.family === 'IPv4' && !entry.internal)?.address;
const origin = process.env.CAMPUS_PHONE_ORIGIN || process.env.CAMPUS_BROWSER_ORIGIN || `http://${address}:5173`;
const parsed = new URL(origin);
assert.equal(parsed.protocol, 'http:', 'Use the insecure HTTP LAN origin for this regression.');
assert.ok(!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'localhost hides the phone-only Web Crypto regression.');
const browser = await chromium.launch(browserOptions());
const errors = [];
const unknownApis = [];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const report = message => console.log(`PASS ${message}`);
const messageRow = (page, text) => page.locator('.chat-message').filter({ has: page.locator('.message-text').filter({ hasText: text }) });

function fixtures(language = 'fr', readOnly = false) {
  const user = { id: 91001, username: 'phone-send-fixture', name: 'Étudiant test', language, role: 'student', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 6, account_status: 'approved', preferences: {} };
  const author = { ...user, id: 91002, username: 'other-fixture', name: 'Yassine' };
  const faculty = { id: 'fsa', code: 'FSA', name: 'Faculté des Sciences Appliquées', arabic: 'كلية العلوم التطبيقية', color: '#24764c', members: 2, online: 2, chat_online: 2 };
  const makeMessage = (id, content, channel = 'general', semester = null, filiere_id = null) => ({ id, content, channel, semester, filiere_id, faculty_id: 'fsa', author, created_at: new Date(Date.now() - 100000 + id * 1000).toISOString(), pinned: false, reply_to: null, reactions: {}, my_reactions: [] });
  return {
    user, faculty, faculties: [faculty], filieres: [{ id: 'data_science', name: 'Filière Sciences de Données', faculty_id: 'fsa' }], modules: [],
    channels: [{ id: 'general', name: 'Chat général', read_only: readOnly }], members: [user, author],
    messages: [makeMessage(1, 'Message général pour répondre.'), makeMessage(2, 'Message du semestre cinq.', 'filiere', 5, 'data_science'), makeMessage(3, 'Message du semestre six.', 'filiere', 6, 'data_science'), makeMessage(4, 'Message d’une autre filière.', 'filiere', 5, 'physics'), makeMessage(5, 'Message du semestre un.', 'filiere', 1, 'data_science'), makeMessage(6, 'Message du semestre deux.', 'filiere', 2, 'data_science'), makeMessage(7, 'Message du semestre trois.', 'filiere', 3, 'data_science'), makeMessage(8, 'Message du semestre quatre.', 'filiere', 4, 'data_science')],
    resources: [], notifications: [], events: [], announcements: [], saved: [], history: [],
  };
}

async function mockPhone({ width = 390, height = 844, language = 'fr', theme = 'dark', readOnly = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const data = fixtures(language, readOnly);
  const posts = [];
  let nextId = 100;
  let bootstraps = 0;
  await context.addInitScript(({ language, theme }) => {
    localStorage.setItem('campus-language', language);
    localStorage.setItem('campus-theme', theme);
    localStorage.setItem('campus-navigation-expanded', 'false');
    localStorage.setItem('campus-faculty-panel-expanded', 'false');
    window.EventSource = class extends EventTarget {
      constructor() { super(); this.readyState = 1; window.__phoneStream = this; }
      close() { this.readyState = 2; }
    };
  }, { language, theme });
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/session') return route.fulfill({ json: { user: data.user } });
    if (pathname === '/api/bootstrap') { bootstraps++; return route.fulfill({ json: data }); }
    if (pathname === '/api/events/stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (pathname === '/api/profile') return route.fulfill({ json: { user: data.user } });
    if (pathname === '/api/messages' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      let release;
      const held = new Promise(resolve => { release = resolve; });
      const entry = {
        payload, completed: false,
        commit() {
          this.message ||= data.messages.find(message => message.client_id === payload.client_id) || { id: nextId++, ...payload, faculty_id: data.user.faculty_id, filiere_id: payload.channel === 'filiere' ? data.user.filiere_id : null, semester: payload.semester || null, author: data.user, created_at: new Date().toISOString(), pinned: false, reactions: {}, my_reactions: [] };
          if (!data.messages.some(message => message.id === this.message.id)) data.messages.push(this.message);
          return this.message;
        },
        succeed() { release({ status: 201, json: { message: this.commit() } }); },
        fail() { release({ status: 503, json: { error: 'Échec temporaire injecté par le test.' } }); },
      };
      posts.push(entry);
      await route.fulfill(await held); entry.completed = true; return;
    }
    unknownApis.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 501, json: { error: 'Unexpected API in phone fixture.' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/app/chat/general');
  await page.locator('.chat-composer').waitFor();
  assert.equal(await page.evaluate(() => isSecureContext), false);
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
  assert.equal(await page.evaluate(() => typeof crypto.getRandomValues), 'function');
  return { context, page, data, posts, get bootstraps() { return bootstraps; } };
}

async function nextPost(fixture, index) {
  await expect.poll(() => fixture.posts.length).toBeGreaterThan(index);
  return fixture.posts[index];
}
async function tapSend(fixture, text) {
  await fixture.page.locator('.chat-composer textarea').fill(text);
  await fixture.page.locator('.composer-send').tap();
  await expect(fixture.page.locator('.chat-composer textarea')).toHaveValue('');
  await expect(messageRow(fixture.page, text)).toHaveAttribute('data-status', 'pending');
}
async function refreshViaStream(fixture) {
  const previous = fixture.bootstraps;
  await fixture.page.evaluate(() => window.__phoneStream.dispatchEvent(new MessageEvent('update', { data: '{}' })));
  await expect.poll(() => fixture.bootstraps).toBeGreaterThan(previous);
}
async function reachableSend(page) {
  const target = await page.locator('.composer-send').evaluate(button => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, hit: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)), overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.ok(target.width >= 44 && target.height >= 44, 'Send remains a 44px touch target.');
  assert.ok(target.left >= 0 && target.right <= target.viewportWidth && target.top >= 0 && target.bottom <= target.viewportHeight, 'Send fits inside the visible viewport.');
  assert.equal(target.hit, true, 'No overlay intercepts the send tap.');
  assert.equal(target.overflow, false, 'Composer causes no horizontal overflow.');
}

try {
  const fixture = await mockPhone();
  await reachableSend(fixture.page);
  const firstText = 'Téléphone : premier message instantané.';
  const secondText = 'Téléphone : deuxième message sans attendre.';
  await tapSend(fixture, firstText);
  const first = await nextPost(fixture, 0);
  assert.match(first.payload.client_id, uuidPattern);
  assert.equal(first.completed, false);
  await tapSend(fixture, secondText);
  const second = await nextPost(fixture, 1);
  assert.match(second.payload.client_id, uuidPattern);
  assert.notEqual(first.payload.client_id, second.payload.client_id);
  await refreshViaStream(fixture);
  await expect(messageRow(fixture.page, firstText)).toHaveAttribute('data-status', 'pending');
  await expect(messageRow(fixture.page, secondText)).toHaveAttribute('data-status', 'pending');
  first.commit();
  await refreshViaStream(fixture);
  await expect(messageRow(fixture.page, firstText)).toHaveAttribute('data-status', 'sent');
  assert.equal(first.completed, false, 'SSE can confirm a stored UUID before its held response.');
  first.succeed(); second.succeed();
  await expect(messageRow(fixture.page, firstText)).toHaveCount(1);
  await expect(messageRow(fixture.page, firstText)).toHaveAttribute('data-status', 'sent');
  await expect(messageRow(fixture.page, secondText)).toHaveCount(1);
  await expect(messageRow(fixture.page, secondText)).toHaveAttribute('data-status', 'sent');
  report('HTTP LAN touch send appears immediately; concurrent drafts survive refresh and reconcile once');

  const retryText = 'Téléphone : message à réessayer après une erreur.';
  await tapSend(fixture, retryText);
  const failed = await nextPost(fixture, 2); failed.fail();
  await expect(messageRow(fixture.page, retryText)).toHaveAttribute('data-status', 'failed');
  await expect(fixture.page.locator('.toast.error')).toContainText('Échec temporaire injecté par le test.');
  await messageRow(fixture.page, retryText).getByRole('button', { name: 'Réessayer', exact: true }).tap();
  const retried = await nextPost(fixture, 3);
  assert.equal(retried.payload.client_id, failed.payload.client_id);
  await expect(messageRow(fixture.page, retryText)).toHaveAttribute('data-status', 'pending');
  retried.succeed();
  await expect(messageRow(fixture.page, retryText)).toHaveAttribute('data-status', 'sent');
  await expect(messageRow(fixture.page, retryText)).toHaveCount(1);
  await fixture.context.close();
  report('HTTP LAN error toast works; failed draft stays visible and retry preserves its UUID');

  const major = await mockPhone({ width: 360, height: 640, language: 'ar', theme: 'light' });
  await major.page.goto(origin + '/app/chat/filiere');
  await expect(major.page.locator('.chat-group-selector')).toHaveValue('5');
  await expect(messageRow(major.page, 'Message du semestre cinq.')).toHaveCount(1);
  await expect(messageRow(major.page, 'Message du semestre six.')).toHaveCount(1);
  await expect(messageRow(major.page, 'Message d’une autre filière.')).toHaveCount(0);
  for (const [semester, first, second] of [['1', 'un', 'deux'], ['3', 'trois', 'quatre'], ['5', 'cinq', 'six']]) {
    await major.page.locator('.chat-group-selector').selectOption(semester);
    await expect(messageRow(major.page, `Message du semestre ${first}.`)).toHaveCount(1);
    await expect(messageRow(major.page, `Message du semestre ${second}.`)).toHaveCount(1);
    assert.equal(await major.page.locator('.chat-message').count(), 2);
  }
  await major.page.locator('#message-2 .message-reply-action').tap();
  await expect(major.page.locator('.composer-reply')).toBeVisible();
  await reachableSend(major.page);
  await tapSend(major, 'رد سريع من الهاتف إلى زميل في نفس المسلك.');
  const reply = await nextPost(major, 0);
  assert.equal(reply.payload.channel, 'filiere');
  assert.equal(reply.payload.semester, 5);
  assert.equal(reply.payload.reply_to, 2);
  assert.match(reply.payload.client_id, uuidPattern);
  await expect(major.page.locator('.composer-reply')).toHaveCount(0);
  reply.succeed();
  await expect(messageRow(major.page, reply.payload.content)).toHaveAttribute('data-status', 'sent');
  await major.context.close();
  report('phone major chats retain paired semesters and reply sends optimistically with the correct scope');

  const readOnly = await mockPhone({ width: 320, height: 460, readOnly: true });
  await expect(readOnly.page.locator('.chat-composer textarea')).toBeDisabled();
  await expect(readOnly.page.locator('.composer-send')).toBeDisabled();
  await readOnly.page.locator('.chat-composer').evaluate(form => form.requestSubmit());
  assert.equal(readOnly.posts.length, 0);
  await readOnly.context.close();
  report('read-only student chats keep sending disabled');

  let combinations = 0;
  for (const [width, height] of [[320, 460], [390, 844], [768, 1024]]) {
    for (const language of ['fr', 'ar']) {
      for (const theme of ['dark', 'light']) {
        const layout = await mockPhone({ width, height, language, theme });
        await layout.page.locator('.chat-composer textarea').fill('Message avec clavier ouvert.');
        if (width === 390) await layout.page.setViewportSize({ width, height: 390 });
        await reachableSend(layout.page);
        await layout.page.locator('.composer-send').tap();
        const post = await nextPost(layout, 0);
        await expect(messageRow(layout.page, post.payload.content)).toHaveAttribute('data-status', 'pending');
        assert.equal(post.completed, false);
        post.succeed();
        await expect(messageRow(layout.page, post.payload.content)).toHaveAttribute('data-status', 'sent');
        await layout.context.close(); combinations++;
      }
    }
  }
  report(`${combinations} small phone/tablet, RTL/LTR, light/dark touch layouts have a reachable send button`);
  assert.deepEqual(unknownApis, [], 'No API request escapes the explicit mock fixture.');
  assert.deepEqual(errors, [], 'No client-side exception interrupts sending or error feedback.');
} finally {
  await browser.close();
}
