import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { browserOptions } from './browser-utils.mjs';

// Every API and EventSource is explicitly mocked: this suite never uses a real
// profile, database, identity provider, or chat stream.
const origin = process.env.CAMPUS_BROWSER_ORIGIN || 'http://127.0.0.1:5173';
const browser = await chromium.launch(browserOptions());
const unknownApis = [], errors = [];
const report = message => console.log(`PASS ${message}`);
const messageRow = (page, text) => page.locator('.chat-message').filter({ has: page.locator('.message-text').filter({ hasText: text }) });

function fixtureData() {
  const user = { id: 93001, username: 'live-chat-fixture', name: 'Étudiant test', language: 'fr', role: 'student', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 6, account_status: 'approved', preferences: {} };
  const author = { ...user, id: 93002, username: 'other-fixture', name: 'Yassine' };
  const faculty = { id: 'fsa', code: 'FSA', name: 'Faculté des Sciences Appliquées', arabic: 'كلية العلوم التطبيقية', color: '#24764c', members: 2, online: 2, chat_online: 2 };
  const data = {
    user, faculty, faculties: [faculty], filieres: [{ id: 'data_science', name: 'Filière Sciences de Données', faculty_id: 'fsa' }], modules: [],
    channels: [{ id: 'general', name: 'Chat général' }], members: [user, author], messages: [],
    resources: [], notifications: [], events: [], announcements: [], saved: [], history: [],
  };
  let nextId = 10;
  const add = (content, extra = {}) => {
    const message = { id: nextId++, content, channel: 'general', semester: null, filiere_id: null, faculty_id: 'fsa', author, created_at: new Date(Date.now() + nextId * 1000).toISOString(), pinned: false, reply_to: null, reactions: {}, my_reactions: [], ...extra };
    data.messages.push(message);
    return message;
  };
  add('Message initial.');
  return { data, add };
}

async function fixture({ mobile = true, channel = 'general', history = 1 } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 950 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
  const { data, add } = fixtureData();
  for (let index = 1; index < history; index++) add(`Historique du chat ${index}.`);
  const posts = [], snapshots = [];
  let bootstraps = 0, active = 0, maximumActive = 0, hold = false, failBootstrap = false, rejectAuth = false;
  await context.addInitScript(() => {
    localStorage.setItem('campus-language', 'fr');
    localStorage.setItem('campus-theme', 'dark');
    localStorage.setItem('campus-navigation-expanded', 'false');
    localStorage.setItem('campus-faculty-panel-expanded', 'false');
    window.__liveChatStreams = [];
    window.EventSource = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      CONNECTING = 0; OPEN = 1; CLOSED = 2;
      constructor(url) { super(); this.url = url; this.readyState = 1; window.__liveChatStreams.push(this); }
      close() { this.readyState = 2; }
    };
  });
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/api/session') return route.fulfill({ json: { user: data.user } });
    if (pathname === '/api/bootstrap') {
      bootstraps++; active++; maximumActive = Math.max(maximumActive, active);
      const snapshot = structuredClone(data);
      const entry = { request, snapshot, done: false, aborted: false };
      snapshots.push(entry);
      try {
        if (hold) { hold = false; await new Promise(resolve => { entry.release = resolve; }); }
        if(entry.aborted)return;
        if (rejectAuth) return await route.fulfill({ status: 401, json: { error: 'Votre session a expiré.' } });
        if (failBootstrap) return await route.fulfill({ status: 503, json: { error: 'Indisponibilité temporaire du test.' } });
        await route.fulfill({ json: snapshot });
      } finally { active--; entry.done = true; }
      return;
    }
    if (pathname === '/api/profile') return route.fulfill({ json: { user: data.user } });
    if (pathname === '/api/messages' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      const entry = { payload };
      posts.push(entry);
      const response = await new Promise(resolve => {
        entry.succeed = () => {
          const message = data.messages.find(item => item.client_id === payload.client_id) || add(payload.content, { ...payload, author: data.user });
          resolve({ status: 201, json: { message } });
        };
        entry.fail = () => resolve({ status: 503, json: { error: 'Échec temporaire du test.' } });
      });
      return route.fulfill(response);
    }
    unknownApis.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 501, json: { error: 'Unexpected API in live chat fixture.' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed',request=>{
    const entry=snapshots.find(item=>item.request===request);
    if(entry?.release){entry.aborted=true;entry.release();}
  });
  await page.clock.install();
  await page.goto(`${origin}/app/chat/${channel}`);
  await page.locator('.chat-composer').waitFor();
  await delay(200);
  await page.clock.pauseAt(new Date(Date.now() + 100));
  maximumActive = active;
  return {
    context, page, data, add, posts, snapshots,
    get bootstraps() { return bootstraps; }, get active() { return active; }, get maximumActive() { return maximumActive; },
    holdNextBootstrap() { hold = true; }, failRefresh(value) { failBootstrap = value; }, expireSession() { rejectAuth = true; },
    async tick(milliseconds = 250) {
      // The clock controls browser timers, while mocked HTTP responses still
      // travel asynchronously through Playwright. Let them settle between ticks.
      while(milliseconds>0){const step=Math.min(milliseconds,1000);await page.clock.runFor(step);await delay(25);milliseconds-=step;}
      await delay(75);
    },
    async stream(type, payload = '{}') {
      await page.evaluate(({ type, payload }) => {
        const stream = window.__liveChatStreams.at(-1);
        stream.readyState = type === 'error' ? 0 : 1;
        stream.dispatchEvent(type === 'update' ? new MessageEvent('update', { data: payload }) : new Event(type));
      }, { type, payload });
    },
  };
}

async function assertLive(fixture, text) {
  await expect(messageRow(fixture.page, text)).toHaveCount(1);
  assert.equal(new URL(fixture.page.url()).pathname.startsWith('/app/chat/'), true, 'Incoming messages require no route exit or reload.');
}

try {
  const incoming = await fixture({ history: 24 });
  await incoming.page.locator('.chat-composer textarea').fill('Brouillon conservé pendant les messages entrants.');
  incoming.add('Message reçu immédiatement via le flux.');
  await incoming.stream('update'); await incoming.tick();
  await assertLive(incoming, 'Message reçu immédiatement via le flux.');
  await expect(incoming.page.locator('.chat-composer textarea')).toHaveValue('Brouillon conservé pendant les messages entrants.');
  await incoming.tick(100);
  assert.ok(await incoming.page.locator('.chat-scroll').evaluate(element => element.scrollHeight > element.clientHeight), 'The fixture has a real scrollable message history.');
  assert.ok(await incoming.page.locator('.chat-scroll').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 5), 'Incoming messages appear at the end of the open chat.');
  await incoming.context.close();
  report('an incoming message updates the open phone chat without navigation and preserves the composer draft');

  const reconnect = await fixture();
  await reconnect.stream('error');
  reconnect.add('Message manqué pendant la déconnexion.');
  await reconnect.stream('open'); await reconnect.tick();
  await assertLive(reconnect, 'Message manqué pendant la déconnexion.');
  await reconnect.context.close();
  report('opening or reconnecting the stream reconciles messages missed while disconnected');

  const fallback = await fixture();
  await fallback.stream('error');
  fallback.add('Message reçu malgré le flux interrompu.');
  await fallback.tick(31000);
  await assertLive(fallback, 'Message reçu malgré le flux interrompu.');
  fallback.add('Message dont l’événement a été perdu.');
  await fallback.stream('open'); await fallback.tick();
  // A healthy connection also needs occasional reconciliation because mobile
  // proxies can retain an open socket while silently losing application events.
  fallback.add('Message perdu sur un flux apparemment ouvert.');
  await fallback.tick(31000);
  await assertLive(fallback, 'Message perdu sur un flux apparemment ouvert.');
  await fallback.context.close();
  report('an interrupted or silently stale stream has bounded background reconciliation');

  for (const trigger of ['visible', 'focus', 'online']) {
    const resume = await fixture();
    const text = `Message reçu après ${trigger}.`;
    resume.add(text);
    await resume.page.evaluate(trigger => {
      if (trigger === 'visible') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      } else window.dispatchEvent(new Event(trigger));
    }, trigger);
    await resume.tick(); await assertLive(resume, text);
    await resume.context.close();
  }
  report('phone visibility, window focus, and network recovery catch up without leaving the chat');

  const burst = await fixture({ mobile: false });
  burst.add('Message pendant des événements continus.');
  for (let index = 0; index < 20; index++) {
    await burst.stream('update'); await burst.tick(75);
  }
  await assertLive(burst, 'Message pendant des événements continus.');
  await burst.context.close();
  report('a sustained update burst cannot keep postponing the open desktop chat refresh');

  const serial = await fixture();
  serial.holdNextBootstrap();
  serial.add('Instantané initial retenu.');
  const before = serial.bootstraps;
  await serial.stream('update'); await serial.tick();
  await expect.poll(() => serial.bootstraps).toBeGreaterThan(before);
  const held = serial.snapshots.findLast(entry => entry.release && !entry.done);
  assert.ok(held, 'The first refresh is deliberately held in transit.');
  serial.add('Message arrivé pendant un rafraîchissement lent.');
  await serial.stream('update'); await serial.tick();
  assert.equal(serial.maximumActive, 1, 'Refreshes coalesce instead of running overlapping bootstrap requests.');
  held.release(); await delay(150); await serial.tick();
  await assertLive(serial, 'Message arrivé pendant un rafraîchissement lent.');
  await serial.context.close();
  report('slow refreshes coalesce into a subsequent snapshot instead of discarding every in-flight result');

  const stalled = await fixture();
  stalled.holdNextBootstrap();
  await stalled.stream('update');await stalled.tick();
  const abandoned=stalled.snapshots.findLast(entry=>entry.release&&!entry.done);
  assert.ok(abandoned,'A stalled network response is held beyond the refresh deadline.');
  stalled.add('Message reçu après expiration du rafraîchissement bloqué.');
  await stalled.tick(21000);
  await expect.poll(()=>abandoned.aborted).toBe(true);
  await assertLive(stalled,'Message reçu après expiration du rafraîchissement bloqué.');
  await expect(stalled.page.locator('.chat-composer')).toBeVisible();
  await stalled.context.close();
  report('a stalled request times out and releases the live queue without clearing existing chat data');

  const paused=await fixture();
  const beforePause=paused.bootstraps;
  await paused.page.evaluate(()=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await paused.tick(11000);
  assert.equal(paused.bootstraps,beforePause,'Hidden phones do not poll for snapshots.');
  await paused.page.evaluate(()=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
    Object.defineProperty(navigator,'onLine',{configurable:true,value:false});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await paused.tick(11000);
  assert.equal(paused.bootstraps,beforePause,'Offline phones do not poll for snapshots.');
  paused.add('Message reçu au retour du réseau.');
  await paused.page.evaluate(()=>{
    Object.defineProperty(navigator,'onLine',{configurable:true,value:true});
    window.dispatchEvent(new Event('online'));
  });
  await paused.tick();await assertLive(paused,'Message reçu au retour du réseau.');
  await paused.context.close();
  report('periodic recovery pauses while hidden or offline and catches up when connectivity returns');

  const major = await fixture({ channel: 'filiere' });
  major.add('Nouveau message de S5.', { channel: 'filiere', semester: 5, filiere_id: 'data_science' });
  major.add('Nouveau message de S6.', { channel: 'filiere', semester: 6, filiere_id: 'data_science' });
  major.add('Message de S4 hors du groupe affiché.', { channel: 'filiere', semester: 4, filiere_id: 'data_science' });
  major.add('Message d’une autre filière.', { channel: 'filiere', semester: 5, filiere_id: 'physics' });
  await major.stream('update'); await major.tick();
  await assertLive(major, 'Nouveau message de S5.'); await assertLive(major, 'Nouveau message de S6.');
  await expect(messageRow(major.page, 'Message de S4 hors du groupe affiché.')).toHaveCount(0);
  await expect(messageRow(major.page, 'Message d’une autre filière.')).toHaveCount(0);
  await major.page.locator('.chat-group-selector').selectOption('3');
  await expect(messageRow(major.page, 'Message de S4 hors du groupe affiché.')).toHaveCount(1);
  await expect(messageRow(major.page, 'Nouveau message de S5.')).toHaveCount(0);
  await expect(messageRow(major.page, 'Message d’une autre filière.')).toHaveCount(0);
  await major.context.close();
  report('live major chat updates preserve paired academic years and exclude other majors');

  const optimistic = await fixture();
  const text = 'Mon message en attente reste visible.';
  await optimistic.page.locator('.chat-composer textarea').fill(text);
  await optimistic.page.locator('.composer-send').tap();
  await expect(messageRow(optimistic.page, text)).toHaveAttribute('data-status', 'pending');
  await expect.poll(() => optimistic.posts.length).toBe(1);
  optimistic.add('Message reçu pendant mon envoi.');
  await optimistic.stream('open'); await optimistic.tick();
  await assertLive(optimistic, 'Message reçu pendant mon envoi.');
  await expect(messageRow(optimistic.page, text)).toHaveAttribute('data-status', 'pending');
  optimistic.posts[0].fail();
  await expect(messageRow(optimistic.page, text)).toHaveAttribute('data-status', 'failed');
  await optimistic.tick();
  await optimistic.tick(31000);
  await expect(messageRow(optimistic.page, text)).toHaveAttribute('data-status', 'failed');
  await messageRow(optimistic.page, text).getByRole('button', { name: 'Réessayer', exact: true }).tap();
  await expect.poll(() => optimistic.posts.length).toBe(2);
  assert.equal(optimistic.posts[0].payload.client_id, optimistic.posts[1].payload.client_id);
  optimistic.posts[1].succeed();
  await expect(messageRow(optimistic.page, text)).toHaveAttribute('data-status', 'sent');
  await optimistic.tick();
  await expect(messageRow(optimistic.page, text)).toHaveCount(1);
  await optimistic.context.close();
  report('live refresh and recovery preserve pending and failed drafts; retries reconcile once with the same client ID');

  const permissions = await fixture();
  permissions.data.user.chat_blocked = true;
  await permissions.stream('update'); await permissions.tick();
  await expect(permissions.page.locator('.chat-blocked-page')).toBeVisible();
  assert.equal(await permissions.page.evaluate(() => window.__liveChatStreams.every(stream => stream.readyState === 2)), true, 'Blocking chat closes every live connection.');
  await permissions.context.close();
  report('a refresh that removes chat access closes the connection and enforces the existing blocked screen');

  const expired = await fixture();
  expired.expireSession();
  await expired.stream('update'); await expired.tick();
  await expect(expired.page).toHaveURL(/\/login$/);
  assert.equal(await expired.page.evaluate(() => window.__liveChatStreams.every(stream => stream.readyState === 2)), true);
  const afterExpiry = expired.bootstraps;
  await expired.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expired.tick(31000);
  assert.equal(expired.bootstraps, afterExpiry, 'Recovery handlers and periodic refresh stop after session expiry.');
  await expired.context.close();
  report('session expiry clears the chat, closes its stream, and removes background recovery listeners');

  assert.deepEqual(unknownApis, [], 'No API request escaped the explicit mocks.');
  assert.deepEqual(errors, [], 'Live synchronization produced no runtime errors.');
} finally {
  await browser.close();
}
