import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect as browserExpect } from '@playwright/test';

// Every API request is fulfilled locally. In particular, the admission PATCH
// below changes only this fixture; no real notification or student is changed.
// These tests cover the UI's handling of authoritative server receipts. The
// database's first-read/expiry implementation is covered by backend tests.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = 'test-results/notification-read-retention/chromium';
const expect = browserExpect.configure({ timeout: 12000 });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const report = { passed: [], errors: [], screenshots: [], apiWrites: [] };
const HOUR = 60 * 60 * 1000, retention = 72 * HOUR;
const initialTime = Date.parse('2026-10-27T12:00:00.000Z');
const iso = time => new Date(time).toISOString();
const registrationPath = id => `/app/admin?tab=accounts&registration=${id}#registration-${id}`;
const notice = (id, overrides = {}) => ({ id, type: 'announcements', title: `Notification conservée ${id}`,
  body: `Historique de la faculté ${id}`, path: '/app/announcements',
  created_at: iso(initialTime - (400 - id) * HOUR), read: false, read_at: null,
  target_available: false, popup_eligible: false, ...overrides });
await mkdir(output, { recursive: true });

async function fixture({ width = 1440, height = 900, theme = 'dark', notices = [],
  route = '/app/notifications', registration = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900,
    serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(theme => {
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    const streams = [];
    window.EventSource = class extends EventTarget {
      constructor() { super(); streams.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() { const index = streams.indexOf(this); if (index >= 0) streams.splice(index, 1); }
    };
    window.__retentionUpdate = change => streams.forEach(stream => stream.dispatchEvent(
      new MessageEvent('update', { data: JSON.stringify(change || { adminInbox: true }) })));
    window.__retentionStreams = () => streams.length;
  }, theme);
  const user = { id: 2, username: 'notification-retention-fixture', name: 'Retention fixture',
    role: 'global_admin', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1,
    account_status: 'approved', language: 'fr', preferences: {} };
  let student = { id: 51, username: 'retention.student', name: 'Étudiant de test conservé',
    email: 'retention@student.test', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies',
    current_semester: 1, account_status: 'pending', registered_at: iso(initialTime - HOUR) };
  let rows = structuredClone(notices), serverTime = initialTime, snapshots = 0;
  const errors = [], writes = [], receipts = [], expired = new Set();
  function visibleRows() {
    // Synthetic authoritative-server boundary; do not use creation time or
    // destination availability to expire an unread or recently-read item.
    rows = rows.filter(item => {
      if (item.read && item.read_at && Date.parse(item.read_at) + retention <= serverTime) expired.add(item.id);
      return !expired.has(item.id);
    });
    return structuredClone(rows);
  }
  function payload() {
    const notifications = visibleRows();
    return { user, faculty: { id: 'flaa', code: 'FLAA', name: 'Faculté de test' },
      resources: [], messages: [], announcements: [], notifications,
      unread_count: notifications.filter(item => !item.read).length,
      admin_unread_count: notifications.filter(item => !item.read && item.popup_eligible).length,
      discussion_unread_count: 0, discussion_unread_counts: [], has_more: false,
      channels: [], members: [user], saved: [], history: [], events: [], messages_complete: true };
  }
  function markRead(id) {
    rows = rows.map(item => id == null || item.id === id
      ? { ...item, read: true, read_at: item.read_at || iso(serverTime) } : item);
  }
  await context.route('**/*', async route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) {
      errors.push(`Blocked unexpected non-fixture write: ${request.method()} ${request.url()}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path === '/api/session' && method === 'GET') return route.fulfill({ json: { user } });
    if (['/api/bootstrap', '/api/live', '/api/notifications'].includes(path) && method === 'GET') {
      snapshots++;
      const receipt = payload(); receipts.push(structuredClone(receipt.notifications));
      return route.fulfill({ json: receipt });
    }
    const read = /^\/api\/notifications\/(\d+)\/read$/.exec(path);
    if ((read || path === '/api/notifications/read') && method === 'POST') {
      const id = read ? Number(read[1]) : null;
      assert.ok(id == null || rows.some(item => item.id === id), 'Only fixture notifications may be read');
      writes.push({ method, path, id }); markRead(id);
      const receipt = payload(); receipts.push(structuredClone(receipt.notifications));
      return route.fulfill({ json: receipt });
    }
    if (path === '/api/admin' && method === 'GET') return route.fulfill({ json: {
      users: registration ? [user, student] : [user], resources: [], announcements: [],
      channels: [], contacts: [], reports: [] } });
    if (path === '/api/admin/registrations' && method === 'GET') return route.fulfill({ json: {
      requests: registration && student.account_status === 'pending' ? [student] : [] } });
    if (path === '/api/chat/blocks' && method === 'GET') return route.fulfill({ json: { blocks: [] } });
    if (path === '/api/admin/users/51/admission' && method === 'PATCH' && registration) {
      assert.deepEqual(request.postDataJSON(), { status: 'approved' });
      writes.push({ method, path, id: student.id }); student = { ...student, account_status: 'approved' };
      rows = rows.map(item => item.registration_user_id === student.id
        ? { ...item, read: true, read_at: item.read_at || iso(serverTime), target_available: false, popup_eligible: false } : item);
      return route.fulfill({ json: { user: student } });
    }
    errors.push(`Unexpected fixture API request: ${method} ${path}`);
    return route.fulfill({ status: 503, json: { error: 'Unexpected isolated retention fixture request' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(origin + route);
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__retentionStreams())).toBe(1);
  return { page, context, writes, errors, receipts, expired,
    get(id) { return structuredClone(rows.find(item => item.id === id)); },
    setTime(value) { serverTime = value; },
    add(item) { assert.ok(!expired.has(item.id), 'Expired fixture IDs cannot be resurrected'); rows = [structuredClone(item), ...rows]; },
    async refresh(change) {
      const before = snapshots;
      await page.evaluate(change => window.__retentionUpdate(change), change);
      await expect.poll(() => snapshots).toBeGreaterThan(before);
    },
    async reload() { await page.reload(); await expect(page.locator('.app-shell')).toBeVisible(); },
  };
}

const main = page => page.locator('#main-content');
const item = (page, id) => main(page).locator(`.notification-item[data-notification-id="${id}"]`);
async function selectTab(page, read) { await main(page).getByRole('tab', { name: read ? /^Lu/ : /^Non lu/ }).click(); }
async function ids(page) { return main(page).locator('.notification-item').evaluateAll(nodes => nodes.map(node => Number(node.dataset.notificationId))); }
async function noOverflow(page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Notifications cause no horizontal overflow'); }
async function screenshot(page, name) {
  const path = `${output}/${name}.png`; await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
}
async function checked(name, options, run) {
  const f = await fixture(options);
  try { await run(f); await noOverflow(f.page); assert.deepEqual(f.errors, []); report.passed.push(name); }
  finally {
    report.errors.push(...f.errors); report.apiWrites.push(...f.writes.map(write => ({ check: name, ...write })));
    await f.context.close();
  }
}

try {
  await checked('Single read survives receipts, reload and live refresh, including an unavailable destination', {
    notices: [notice(303), notice(302, { read: true, read_at: iso(initialTime - 6 * HOUR) }),
      notice(301, { created_at: iso(initialTime - 90 * 24 * HOUR) })],
  }, async f => {
    const { page } = f;
    const creationLabel = await item(page, 303).locator('small').textContent();
    await item(page, 303).locator('.notification-content').click();
    await expect(item(page, 303)).toHaveCount(0);
    await expect(page).toHaveURL(/\/app\/notifications$/);
    await selectTab(page, true);
    await expect(item(page, 303)).toContainText('Destination indisponible');
    assert.deepEqual(await ids(page), [303, 302]);
    assert.equal((await item(page, 303).locator('small').textContent()).split('·')[0], creationLabel.split('·')[0], 'Displayed date stays the creation date');
    const firstRead = f.get(303).read_at;
    f.setTime(initialTime + 24 * HOUR);
    await item(page, 303).locator('.notification-content').click();
    assert.equal(f.writes.filter(write => write.id === 303).length, 1, 'Reopening a read item sends no new read mutation');
    await f.refresh();
    assert.deepEqual(await ids(page), [303, 302], 'Live refresh retains server order');
    assert.equal(f.get(303).read_at, firstRead);
    await f.reload(); await selectTab(page, true);
    assert.deepEqual(await ids(page), [303, 302]);
    await screenshot(page, 'desktop-dark-read-history');
    await page.locator('.notification-button').click();
    const popover = page.locator('.notification-popover');
    await popover.getByRole('button', { name: 'Lu', exact: true }).click();
    await expect(popover.locator('[data-notification-id="303"]')).toBeVisible();
    await expect(popover.locator('[data-notification-id="302"]')).toBeVisible();
    await page.keyboard.press('Escape'); await selectTab(page, false);
    await expect(item(page, 301)).toBeVisible();
    assert.equal(f.get(301).read_at, null, 'An old unread item is never aged out by its creation date');
  });

  await checked('Read all keeps earlier first-read times and moves every unread item into persistent Read history', {
    width: 390, height: 844, theme: 'light', notices: [notice(313),
      notice(312, { read: true, read_at: iso(initialTime - 10 * HOUR) }), notice(311)],
  }, async f => {
    const { page } = f, earlierRead = f.get(312).read_at;
    await main(page).locator('.notification-mark-all').click();
    await expect(main(page).locator('.notification-item')).toHaveCount(0);
    await selectTab(page, true); assert.deepEqual(await ids(page), [313, 312, 311]);
    assert.equal(f.get(312).read_at, earlierRead);
    const firstReads = [313, 312, 311].map(id => f.get(id).read_at);
    f.setTime(initialTime + 2 * HOUR); f.add(notice(314)); await f.refresh();
    await main(page).locator('.notification-mark-all').click();
    await expect.poll(() => ids(page)).toEqual([314, 313, 312, 311]);
    assert.deepEqual([313, 312, 311].map(id => f.get(id).read_at), firstReads, 'A later read-all receipt preserves first-read timestamps');
    await f.reload(); await selectTab(page, true);
    assert.deepEqual(await ids(page), [314, 313, 312, 311]);
    await f.refresh({ discussionReads: true });
    assert.deepEqual(await ids(page), [314, 313, 312, 311], 'Inbox-only live refresh preserves all read items and ordering');
    assert.equal(f.writes.filter(write => write.path === '/api/notifications/read').length, 2);
    await screenshot(page, 'phone-light-read-all-history');
  });

  for (const previouslyRead of [false, true]) {
    await checked(`Approval ${previouslyRead ? 'preserves an existing' : 'starts the'} first-read receipt after the student leaves pending requests`, {
      width: previouslyRead ? 1440 : 390, height: 900, theme: previouslyRead ? 'light' : 'dark',
      route: '/app/admin?tab=accounts', registration: true,
      notices: [notice(323, { type: 'admin', path: registrationPath(51), registration_user_id: 51,
        target_available: true, read: previouslyRead, read_at: previouslyRead ? iso(initialTime - 12 * HOUR) : null }), notice(322)],
    }, async f => {
      const { page } = f, firstRead = f.get(323).read_at || iso(initialTime);
      await page.locator('#registration-51').getByRole('button', { name: 'Accepter', exact: true }).click();
      await expect(page.locator('#registration-51')).toHaveCount(0);
      await expect.poll(() => f.get(323).read).toBe(true);
      assert.equal(f.get(323).read_at, firstRead);
      await page.goto(origin + '/app/notifications'); await selectTab(page, true);
      await expect(item(page, 323)).toBeVisible(); await expect(item(page, 323)).toContainText('Destination indisponible');
      await item(page, 323).locator('.notification-content').click();
      await expect(page).toHaveURL(/\/app\/notifications$/);
      await expect(item(page, 323)).toBeVisible();
      await f.refresh({ registrations: true }); await expect(item(page, 323)).toBeVisible();
      await f.reload(); await selectTab(page, true); await expect(item(page, 323)).toBeVisible();
      assert.equal(f.get(323).read_at, firstRead);
      assert.deepEqual(f.writes.map(write => write.path), ['/api/admin/users/51/admission'], 'Direct approval needs no extra frontend read write');
      await selectTab(page, false); await expect(item(page, 322)).toBeVisible();
      await selectTab(page, true);
      if (!previouslyRead) await screenshot(page, 'phone-dark-approved-read-history');
    });
  }

  await checked('The UI respects the exact server 72-hour boundary and never resurrects expired history', {
    notices: [notice(334, { created_at: iso(initialTime - 180 * 24 * HOUR) }),
      notice(333, { read: true, read_at: iso(initialTime - retention + 1) }),
      notice(332, { read: true, read_at: iso(initialTime - retention) }),
      notice(331, { read: true, read_at: iso(initialTime - retention - 1) })],
  }, async f => {
    const { page } = f;
    await expect(item(page, 334)).toBeVisible(); await selectTab(page, true);
    assert.deepEqual(await ids(page), [333], '72h minus 1ms stays visible; exactly 72h and older are absent');
    assert.deepEqual([...f.expired].sort(), [331, 332]);
    f.setTime(initialTime + 1); await f.refresh();
    await expect(item(page, 333)).toHaveCount(0);
    await expect(main(page)).toContainText('Aucune notification lue');
    await f.reload(); await selectTab(page, true);
    assert.deepEqual(await ids(page), []);
    f.setTime(initialTime + 5 * 24 * HOUR); await f.refresh({ discussionReads: true });
    assert.deepEqual(await ids(page), []);
    await selectTab(page, false); await expect(item(page, 334)).toBeVisible();
    assert.equal(f.writes.length, 0, 'Expiry and live refresh require no browser deletion or read mutation');
  });
  console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors }, null, 2));
} catch (error) { report.failure = error.stack; throw error; }
finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
