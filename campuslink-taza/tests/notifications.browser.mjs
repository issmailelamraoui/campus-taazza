import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// Every API request is intercepted. No live users, admissions or notifications
// are changed by this responsive navigation and live-update regression suite.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
await mkdir('test-results/notifications', { recursive: true });
const stamp = () => new Date().toISOString();
const registrationPath = id => `/app/admin?tab=registrations&registration=${id}#registration-${id}`;
const discussion = id => ({ id, type: 'mentions', title: 'Discussion ' + id, body: 'A private reply', path: `/app/chat/general#message-${id}`, created_at: stamp(), read: false, target_available: true, popup_eligible: false });
const admission = (id, student) => ({ id, type: 'admin', title: 'Inscription ' + student, body: 'Pending student ' + student, path: registrationPath(student), created_at: stamp(), registration_user_id: student, read: false, target_available: true, popup_eligible: true });

async function fixture(width, role = 'global_admin', { messages = [], reports = [], resources = [] } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width === 768 ? 1024 : 900 }, hasTouch: width < 1000, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    const streams = [];
    window.EventSource = class extends EventTarget {
      constructor() { super(); streams.push(this); }
      close() { const index = streams.indexOf(this); if (index >= 0) streams.splice(index, 1); }
    };
    window.__notificationUpdate = () => streams.forEach(stream => stream.dispatchEvent(new MessageEvent('update', { data: '{"registrations":true}' })));
    window.__notificationStreamCount = () => streams.length;
  });
  const user = { id: role === 'student' ? 3 : 2, username: 'notification-fixture-' + width, name: 'Notification fixture', role, faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language: 'fr', preferences: {} };
  const requests = Array.from({ length: 16 }, (_, index) => ({ ...user, id: 40 + index, name: 'Pending student ' + (40 + index), username: 'pending.' + (40 + index), email: 'pending.' + index + '@notification.test', role: 'student', account_status: 'pending', registered_at: stamp() }));
  let notices = [discussion(10)], bootstraps = 0;
  const writes = [], readWrites = [], adminRequests = [], readCursors = new Map();
  const messageScope = item => item.channel === 'filiere' ? 'filiere:' + (Number(item.semester) % 2 ? Number(item.semester) : Number(item.semester) - 1) : item.channel;
  const ordinaryUnread = () => messages.filter(item => item.author.id !== user.id && item.id > (readCursors.get(messageScope(item)) || 0)).length;
  const counters = () => ({ unread_count: notices.filter(item => !item.read).length, discussion_unread_count: messages.length ? ordinaryUnread() : notices.filter(item => !item.read && ['mentions', 'important'].includes(item.type)).length, admin_unread_count: notices.filter(item => !item.read && item.popup_eligible).length });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap'||path==='/api/live') {
      bootstraps++;
      return route.fulfill({ json: { messages_complete:true,user, faculty: { id: 'flaa', code: 'FLAA', name: 'Faculté des Langues, des Lettres et des Arts' }, resources: [], messages, announcements: [], notifications: notices, ...counters(), channels: [], members: [user], saved: [], history: [] } });
    }
    if (path === '/api/admin') {
      const archive = new URL(request.url()).searchParams.get('status') === 'all';
      adminRequests.push({ archive });
      return route.fulfill({ json: { users: [user], resources, announcements: [], channels: [], contacts: [], reports: reports.filter(item => archive || !['resolved', 'dismissed'].includes(item.status)) } });
    }
    if (path === '/api/admin/registrations') {
      await new Promise(resolve => setTimeout(resolve, 160));
      return route.fulfill({ json: { requests } });
    }
    if (path === '/api/chat/blocks') return route.fulfill({ json: { blocks: [] } });
    if (path === '/api/messages/read' && method === 'POST') {
      const body = request.postDataJSON();
      const visible = await request.frame().evaluate(() => {
        const history = document.querySelector('.community-message-history'), bounds = history.getBoundingClientRect();
        return [...history.querySelectorAll('[data-message-id]')].filter(node => {
          const rect = node.getBoundingClientRect();
          return rect.bottom > Math.max(bounds.top, 0) && rect.top < Math.min(bounds.bottom, innerHeight);
        }).map(node => Number(node.dataset.messageId));
      });
      readWrites.push({ body, visible });
      const scope = messageScope(body);
      readCursors.set(scope, Math.max(readCursors.get(scope) || 0, body.through_id));
      return route.fulfill({ json: { discussion_unread_count: ordinaryUnread() } });
    }
    const read = /^\/api\/notifications\/(\d+)\/read$/.exec(path);
    if (read && method === 'POST') {
      const item = notices.find(item => item.id === Number(read[1]));
      assert.ok(item, 'Only fixture notifications may be marked read');
      writes.push({ id: item.id, action: 'read' });
      notices = notices.map(row => row.id === item.id ? { ...row, read: true } : row);
      return route.fulfill({ json: { notifications: notices, ...counters(), has_more: false } });
    }
    errors.push(`Unexpected fixture request: ${method} ${path}`);
    return route.fulfill({ status: 404, json: { error: 'Unexpected fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL + '/app/notifications');
  await expect(page.locator('.notification-item[data-notification-id="10"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__notificationStreamCount())).toBe(1);
  return {
    page, context, writes, readWrites, adminRequests,
    async arrive(item) {
      const previous = bootstraps;
      notices = [item, ...notices];
      await page.evaluate(() => window.__notificationUpdate());
      await expect.poll(() => bootstraps).toBeGreaterThan(previous);
    },
  };
}

async function exactRegistration(page, id) {
  await expect(page).toHaveURL(url => url.pathname === '/app/admin' && url.searchParams.get('tab') === 'accounts' && url.searchParams.get('registration') === String(id) && url.hash === '#registration-' + id);
  const target = page.locator('#registration-' + id);
  await expect(target).toHaveClass(/admin-notification-target/);
  await expect(target).toBeFocused();
  await expect(page.locator('.notification-popover')).toHaveCount(0);
  await expect(page.locator('.sidebar')).not.toHaveClass(/\bopen\b/);
  const geometry = await target.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, header: document.querySelector('.app-header').getBoundingClientRect().bottom, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  assert.ok(geometry.top >= geometry.header - 2 && geometry.bottom <= geometry.height, 'The exact pending request scrolls fully into view: ' + JSON.stringify(geometry));
  assert.equal(geometry.overflow, false);
}

try {
  for (const width of [390, 768, 1440]) {
    const f = await fixture(width);
    try {
      const mobileNavigation = await f.page.locator('.mobile-bottom-nav').isVisible();
      const badge = f.page.locator(`${mobileNavigation ? '.mobile-bottom-nav' : '.sidebar'} a[href="/app/community"] .discussion-unread-dot`);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute('data-unread-count', '1');
      await f.arrive(discussion(11));
      await expect(badge).toHaveAttribute('data-unread-count', '2');
      await expect(f.page.locator('.admin-notification-popup')).toHaveCount(0);

      await f.arrive(admission(21, 51));
      const popup = f.page.locator('.admin-notification-popup[data-notification-id="21"]');
      await expect(popup).toBeVisible();
      const rect = await popup.boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1, 'The administrative popup fits the screen');
      await popup.locator('.admin-notification-popup-open').click();
      await exactRegistration(f.page, 51);
      await expect.poll(() => f.writes.filter(item => item.id === 21 && item.action === 'read').length).toBe(1);

      // A second notification changes only the query/hash of an already open
      // Administration page, exercising async card targeting and panel closure.
      await f.arrive(admission(22, 52));
      await f.page.locator('.admin-notification-popup[data-notification-id="22"] .admin-notification-popup-close').click();
      await f.page.locator('.notification-button').click();
      await f.page.locator('.notification-popover [data-notification-id="22"] .notification-content').click();
      await exactRegistration(f.page, 52);
      await expect.poll(() => f.writes.filter(item => item.id === 22 && item.action === 'read').length).toBe(1);
      await expect(badge).toHaveAttribute('data-unread-count', '2');
      await f.page.screenshot({ path: `test-results/notifications/registration-${width}.png`, animations: 'disabled' });
      console.log(`PASS ${width}px: discussion badge, administrative live popup and exact registration navigation`);
    } finally { await f.context.close(); }
  }

  const student = await fixture(390, 'student');
  try {
    await student.arrive(admission(30, 53));
    await expect(student.page.locator('.notification-item[data-notification-id="30"]')).toBeVisible();
    await expect(student.page.locator('.admin-notification-popup')).toHaveCount(0);
    console.log('PASS student sessions never display administrative popups');
  } finally { await student.context.close(); }

  const burst = await fixture(390);
  try {
    for (let index = 0; index < 4; index++) await burst.arrive(admission(41 + index, 50 + index));
    await expect(burst.page.locator('.admin-notification-popup')).toHaveCount(3);
    await expect(burst.page.locator('.admin-notification-popup[data-notification-id="44"]')).toHaveCount(0);
    await burst.page.locator('.admin-notification-popup[data-notification-id="41"] .admin-notification-popup-close').click();
    await expect(burst.page.locator('.admin-notification-popup[data-notification-id="44"]')).toBeVisible();
    await expect(burst.page.locator('.admin-notification-popup')).toHaveCount(3);
    await burst.page.reload();
    await expect(burst.page.locator('.notification-item[data-notification-id="41"]')).toBeVisible();
    await expect.poll(() => burst.page.evaluate(() => window.__notificationStreamCount())).toBe(1);
    await burst.page.evaluate(() => window.__notificationUpdate());
    await expect(burst.page.locator('.admin-notification-popup')).toHaveCount(0);
    console.log('PASS administrative bursts queue all notices, display at most three and preserve dismissal after refresh');
  } finally { await burst.context.close(); }

  for (const width of [390, 768, 1440]) {
    const messages = [
      ...Array.from({ length: 55 }, (_, index) => ({ id: 10 + index, channel: 'general', semester: null, filiere_id: null })),
      ...Array.from({ length: 15 }, (_, index) => ({ id: 101 + index, channel: 'filiere', semester: 4, filiere_id: 'french_studies' })),
    ].map(item => ({ ...item, faculty_id: 'flaa', content: `Visible message ${item.id}.\nA discussion remains unread until its messages become visible.\nThis extra line keeps older and later messages outside the viewport.`, created_at: new Date(Date.now() - 300000 + item.id * 1000).toISOString(), author: { id: 4, name: 'Other student', username: 'other.student' }, attachments: [] }));
    const f = await fixture(width, 'student', { messages });
    try {
      const mobileNavigation = await f.page.locator('.mobile-bottom-nav').isVisible();
      const badge = f.page.locator(`${mobileNavigation ? '.mobile-bottom-nav' : '.sidebar'} a[href="/app/community"] .discussion-unread-dot`);
      await expect(badge).toHaveAttribute('data-unread-count', '70');
      await f.page.waitForTimeout(550);
      assert.equal(f.readWrites.length, 0, 'Messages stay unread while the notification page is open');
      await f.page.locator('[data-notification-id="10"] .notification-content').click();
      await expect(f.page).toHaveURL(/\/app\/community\?channel=general&message=10$/);
      await expect.poll(() => f.readWrites.length).toBeGreaterThan(0);
      const initial = f.readWrites[0];
      assert.equal(initial.body.channel, 'general');
      assert.equal(initial.body.through_id, Math.max(...initial.visible), 'The read cursor stops at the last visible message');
      assert.ok(initial.body.through_id < 64, 'Jumping to an older message preserves later offscreen messages as unread');
      await expect(badge).toHaveAttribute('data-unread-count', String(70 - (initial.body.through_id - 9)));
      await f.page.locator('.community-message-history').evaluate(node => node.scrollTo(0, node.scrollHeight));
      await expect.poll(() => f.readWrites.some(item => item.body.channel === 'general' && item.body.through_id === 64)).toBe(true);
      await expect(badge).toHaveAttribute('data-unread-count', '15');
      await f.page.getByRole('button', { name: 'Messages épinglés', exact: true }).click();
      await expect(f.page.locator('.community-pins-modal')).toBeVisible();
      const beforeModalArrival = f.readWrites.length;
      messages.push({ ...messages[0], id: 65, content: 'A new ordinary message arrived while a modal covers the discussion.', created_at: stamp() });
      await f.arrive(discussion(65));
      await expect(badge).toHaveAttribute('data-unread-count', '16');
      await f.page.waitForTimeout(700);
      assert.equal(f.readWrites.length, beforeModalArrival, 'A modal prevents covered discussion messages from being marked read');
      await f.page.keyboard.press('Escape');
      await expect(f.page.locator('.community-pins-modal')).toHaveCount(0);
      await expect.poll(() => f.readWrites.some(item => item.body.channel === 'general' && item.body.through_id === 65)).toBe(true);
      await expect(badge).toHaveAttribute('data-unread-count', '15');
      if (await f.page.locator('.community-mobile-back').isVisible()) {
        await f.page.locator('.community-mobile-back').click();
        const previous = f.readWrites.length;
        await f.page.waitForTimeout(550);
        assert.equal(f.readWrites.length, previous, 'The hidden mobile conversation cannot advance a read cursor');
      }
      await f.page.getByRole('button', { name: 'S3–S4', exact: true }).click();
      await expect.poll(() => f.readWrites.some(item => item.body.channel === 'filiere' && item.body.semester === 3 && item.body.through_id === 115)).toBe(true);
      for (const read of f.readWrites) assert.equal(read.body.through_id, Math.max(...read.visible), 'Every cursor uses the visible conversation only');
      await expect(badge).toHaveCount(0);
      await expect(f.page.locator('.admin-notification-popup')).toHaveCount(0);
      console.log(`PASS ${width}px: ordinary discussion badges clear only visible messages within the selected channel/year and pause behind modals`);
    } finally { await f.context.close(); }
  }

  for (const width of [390, 768, 1440]) {
    const report = { id: 71, target_type: 'message', target_id: 10, faculty_id: 'flaa', reason: 'other', details: 'Exact archived report 71', status: 'resolved', created_at: stamp(), reporter: { name: 'Report fixture' } };
    const resource = { id: 81, faculty_id: 'flaa', filiere_id: 'french_studies', title: 'Exact pending resource 81', filename: 'pending-resource.txt', semester: 1, category: 'courses', module: 'Notification verification', part_number: 'complete', status: 'pending', mime: 'text/plain', created_at: stamp() };
    const f = await fixture(width, 'global_admin', { reports: [report], resources: [resource] });
    try {
      for (const [id, kind, target, content] of [[31, 'report', 71, report.details], [32, 'resource', 81, resource.title]]) {
        const path = `/app/admin?tab=${kind === 'report' ? 'reports' : 'resources'}&${kind}=${target}#${kind}-${target}`;
        await f.arrive({ id, type: 'admin', title: `Administrative ${kind}`, body: content, path, created_at: stamp(), read: false, target_available: true, popup_eligible: true });
        await f.page.locator(`.admin-notification-popup[data-notification-id="${id}"] .admin-notification-popup-open`).click();
        const modal = f.page.locator('.admin-modal');
        await expect(modal).toBeVisible();
        await expect(modal).toContainText(content);
        await expect(modal).toHaveAttribute('data-notification-target-ready', 'true');
        await expect(modal).toBeFocused();
        await expect(f.page).toHaveURL(url => url.searchParams.get(kind) === String(target));
        await expect.poll(() => f.writes.filter(item => item.id === id && item.action === 'read').length).toBe(1);
        const rect = await modal.boundingBox();
        assert.ok(rect.x >= -1 && rect.x + rect.width <= width + 1, `${kind} detail fits the screen`);
        if (kind === 'report') assert.ok(f.adminRequests.some(item => item.archive), 'Archived report targeting requests the archive instead of the default open-only list');
        await f.page.keyboard.press('Escape');
        await expect(modal).toHaveCount(0);
      }
      console.log(`PASS ${width}px: archived report and resource notices open their exact administrative detail`);
    } finally { await f.context.close(); }
  }

  const source = await fixture(390, 'student');
  let releaseFile;
  const fileReady = new Promise(resolve => { releaseFile = resolve; });
  try {
    const resource = { id: 91, title: 'Document outside bootstrap' };
    let fileRequested = false;
    await source.context.route('**/api/files/91', async route => {
      assert.equal(route.request().method(), 'GET');
      fileRequested = true;
      await fileReady;
      // A plain response verifies the exact canonical destination in headless
      // Chromium without depending on its built-in PDF extension.
      return route.fulfill({ contentType: 'text/plain', body: 'The exact source document is now visibly loaded.' });
    });
    await source.context.route('**/api/history', route => {
      assert.equal(route.request().method(), 'POST');
      assert.equal(route.request().postDataJSON().resource_id, '91');
      return route.fulfill({ json: { ok: true } });
    });
    await source.arrive({ id: 51, type: 'resources', title: resource.title, body: 'Open the exact source', path: '/app/resources/courses/s1/reader-notifications#resource-91', created_at: stamp(), read: false, target_available: true, popup_eligible: false });
    await source.page.locator('[data-notification-id="51"] .notification-content').click({ noWaitAfter: true });
    await expect.poll(() => fileRequested).toBe(true);
    assert.equal(source.writes.filter(item => item.id === 51 && item.action === 'read').length, 1, 'Explicitly opening the source marks its notification read immediately, before its file finishes loading');
    releaseFile();
    await expect(source.page).toHaveURL(baseURL + '/api/files/91');
    await expect(source.page.locator('body')).toContainText('The exact source document is now visibly loaded.');
    assert.equal(source.writes.filter(item => item.id === 51).length, 1, 'Opening and loading the native source do not duplicate its explicit read receipt');
    console.log('PASS source documents outside bootstrap open their exact native destination and mark read once on explicit click, before loading completes');
  } finally { releaseFile(); await source.context.close(); }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
