import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { browserOptions, selectLanguage } from './browser-utils.mjs';

// Requests below write only to the runner's disposable schema and identity
// fixtures. Refuse an accidental run against the real localhost application.
assert.equal(process.env.CAMPUS_BROWSER_DISPOSABLE, '1', 'Use tests/run-browser.mjs for administrator popup checks.');
const origin = process.env.CAMPUS_BROWSER_ORIGIN;
assert.ok(origin, 'A disposable browser server origin is required.');
const expect = playwrightExpect.configure({ timeout: 30000 });
const browser = await chromium.launch(browserOptions());
const contexts = [];
const errors = [];
const failedRequests = [];
const suffix = randomUUID().slice(0, 8);
const marker = `Inbox browser ${suffix}`;
let administrator;
let initialProfile;
let createdApplicant;
let page;

async function context(options = {}) {
  const owner = await browser.newContext(options);
  contexts.push(owner);
  await owner.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.__campusInboxStreams = [];
    window.EventSource = class extends NativeEventSource {
      constructor(...args) { super(...args); window.__campusInboxStreams.push(this); }
    };
    window.__campusAlertArrivals = [];
    const observed = new WeakSet();
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const cards = [...(node.matches('.admin-incoming-alert') ? [node] : []), ...node.querySelectorAll('.admin-incoming-alert')];
        for (const card of cards) if (!observed.has(card)) {
          observed.add(card); window.__campusAlertArrivals.push(Number(card.dataset.notificationId));
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  return owner;
}

async function newPage(owner) {
  const target = await owner.newPage();
  target.setDefaultTimeout(30000);
  target.setDefaultNavigationTimeout(30000);
  target.on('pageerror', error => errors.push(error.message));
  target.on('response', response => {
    if (response.status() >= 500 && new URL(response.url()).pathname.startsWith('/api/')) failedRequests.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  return target;
}

async function json(owner, path, options) {
  const response = await owner.request.fetch(`${origin}/api${path}`, options);
  const body = await response.json();
  assert.ok(response.ok(), `${path}: ${response.status()} ${JSON.stringify(body)}`);
  return body;
}

async function login(owner, username, password = 'Campus2026!') {
  return json(owner, '/login', { method: 'POST', data: { username, password } });
}

async function snapshot() { return json(administrator, '/bootstrap'); }

async function notify(tab, body) {
  const data = await snapshot();
  const notification = data.notifications.find(item => item.type === 'admin' && item.path === `/app/admin?tab=${tab}` && item.body === body);
  assert.ok(notification, `${tab} notice is visible in the administrator's own faculty inbox`);
  assert.equal(data.faculty.id, initialProfile.faculty_id, 'The administrator receives cross-faculty requests without switching their own faculty');
  return notification;
}

async function popup(notification) {
  const card = page.locator(`.admin-incoming-alert[data-notification-id="${notification.id}"]`);
  await expect(card).toBeVisible();
  // Keyboard focus pauses the display timer while other API assertions run.
  await card.getByRole('link').focus();
  return card;
}

async function openPopup(notification, tab, tabLabel) {
  const card = await popup(notification);
  const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/notifications/read' && response.request().method() === 'POST');
  await card.getByRole('link').click();
  assert.ok((await read).ok(), 'Opening the popup persists its read state');
  await expect(page).toHaveURL(`${origin}/app/admin?tab=${tab}`);
  // Pending counters participate in the tab's accessible name.
  await expect(page.locator('.admin-tabbar').getByRole('tab').filter({ hasText: tabLabel })).toHaveAttribute('aria-selected', 'true');
  await expect(card).toHaveCount(0);
  assert.ok((await snapshot()).notifications.find(item => item.id === notification.id)?.read, 'The clicked notification is marked read');
}

async function refreshFromDuplicateEvent(target = page) {
  const refreshed = target.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap' && response.request().method() === 'GET');
  await target.evaluate(() => {
    const stream = window.__campusInboxStreams.at(-1);
    if (!stream) throw new Error('The administrator has no active update stream.');
    for (let i = 0; i < 2; i++) stream.dispatchEvent(new MessageEvent('update', { data: '{"adminInbox":true}' }));
  });
  assert.ok((await refreshed).ok());
  await target.waitForTimeout(300);
}

async function openScreen(target, route = '/app/chat/general') {
  const stream = target.waitForResponse(response => new URL(response.url()).pathname === '/api/events/stream');
  await target.goto(`${origin}${route}`);
  await target.locator('.app-shell').waitFor();
  assert.equal((await stream).status(), 200);
}

async function contact(owner, name, message) {
  return json(owner, '/contact', { method: 'POST', data: { name, email: `${suffix}@campuslink.test`, subject: 'general', message } });
}

try {
  administrator = await context({ viewport: { width: 1440, height: 960 } });
  const localStudent = await context();
  const crossStudent = await context({ viewport: { width: 390, height: 850 } });
  const facultyAdministrator = await context();
  const anonymous = await context();
  await login(administrator, 'admin', 'Admin2026!');
  initialProfile = (await snapshot()).user;
  assert.equal(initialProfile.role, 'global_admin');
  assert.equal(initialProfile.faculty_id, 'flaa', 'This suite uses the runner compatibility fixture');
  await json(administrator, '/profile', { method: 'PATCH', data: { language: 'fr', preferences: { ...initialProfile.preferences, admin: true, important: true } } });
  await login(localStudent, 'yassine');
  await login(crossStudent, 'meryem');
  await login(facultyAdministrator, 'professeure');
  const crossBootstrap = await json(crossStudent, '/bootstrap');
  assert.equal(crossBootstrap.user.faculty_id, 'fsa');
  const target = crossBootstrap.messages.find(message => message.channel === 'general');
  assert.ok(target, 'A cross-faculty message is available to its own student');

  const oldReason = `${marker} old report`;
  await json(crossStudent, '/reports', { method: 'POST', data: { target_type: 'message', target_id: target.id, reason: oldReason } });
  const oldNotice = await notify('reports', oldReason);
  assert.equal(Boolean(oldNotice.read), false);
  page = await newPage(administrator);
  await openScreen(page);
  await page.waitForTimeout(300);
  await expect(page.locator('.admin-incoming-alert')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.__campusAlertArrivals), [], 'Initial unread administrative notices establish a silent baseline');
  const studentPage = await newPage(crossStudent);
  await openScreen(studentPage);
  console.log('PASS existing unread requests stay silent on initial login');

  const refreshedGeneral = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap');
  await json(localStudent, '/messages', { method: 'POST', data: { channel: 'general', content: `${marker} ordinary general message` } });
  assert.ok((await refreshedGeneral).ok());
  const importantContent = `${marker} ordinary important message`;
  const refreshedImportant = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap');
  await json(localStudent, '/messages', { method: 'POST', data: { channel: 'important', content: importantContent } });
  assert.ok((await refreshedImportant).ok());
  assert.ok((await snapshot()).notifications.some(item => item.type === 'important' && item.body === importantContent), 'Ordinary important notifications still reach the inbox');
  await page.waitForTimeout(300);
  await expect(page.locator('.admin-incoming-alert')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.__campusAlertArrivals), [], 'General and important chat activity never creates an administrator popup');
  console.log('PASS ordinary chat traffic and important notifications do not create administrative popups');

  const reportReason = `${marker} cross faculty report`;
  const report = await json(crossStudent, '/reports', { method: 'POST', data: { target_type: 'message', target_id: target.id, reason: reportReason, details: 'The global administrator should receive this while their FLAA screen is already open.' } });
  const reportNotice = await notify('reports', reportReason);
  assert.equal(new URL(page.url()).pathname, '/app/chat/general', 'The already open administrator chat receives the new report without navigation');
  await popup(reportNotice);
  assert.ok(!(await json(facultyAdministrator, '/bootstrap')).notifications.some(item => item.body === reportReason), 'A different faculty administrator does not receive the report');
  await openPopup(reportNotice, 'reports', 'Signalements');
  assert.ok((await json(administrator, '/admin')).reports.some(item => item.id === report.id && item.faculty_id === 'fsa'));
  await expect(page.locator('.admin-report-card').filter({ hasText: reportReason })).toBeVisible();
  await refreshFromDuplicateEvent();
  await expect(page.locator('.admin-incoming-alert')).toHaveCount(0);
  assert.equal(await page.evaluate(id => window.__campusAlertArrivals.filter(value => value === id).length, reportNotice.id), 1, 'Duplicate updates do not show an already opened request again');
  console.log('PASS live cross-faculty report popup opens the correct tab, persists read state and ignores duplicate refreshes');

  const authenticatedName = `${marker} authenticated contact`;
  const authenticatedContact = await contact(crossStudent, authenticatedName, `${marker} authenticated request contents`);
  const authenticatedNotice = await notify('contacts', authenticatedName);
  await openPopup(authenticatedNotice, 'contacts', 'Demandes de contact');
  await expect(page.locator('.admin-contact-card').filter({ hasText: `${marker} authenticated request contents` })).toBeVisible();
  const studentReply = `${marker} private student response`;
  const studentRefreshed = studentPage.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap');
  await json(administrator, `/admin/contacts/${authenticatedContact.id}`, { method: 'PATCH', data: { status: 'resolved', reply: studentReply } });
  assert.ok((await studentRefreshed).ok());
  assert.ok((await json(crossStudent, '/bootstrap')).notifications.some(item => item.type === 'admin' && item.path === '/app/notifications' && item.body === studentReply));
  await studentPage.waitForTimeout(300);
  await expect(studentPage.locator('.admin-incoming-alert')).toHaveCount(0);
  assert.deepEqual(await studentPage.evaluate(() => window.__campusAlertArrivals), [], 'A student receiving an administrator response has no administrative popup');
  console.log('PASS authenticated contact popup opens its tab; ordinary student responses stay outside the administrator popup feed');

  const anonymousName = `${marker} anonymous contact`;
  const anonymousMessage = `${marker} anonymous recovery request`;
  await contact(anonymous, anonymousName, anonymousMessage);
  const anonymousNotice = await notify('contacts', anonymousName);
  await popup(anonymousNotice);
  assert.ok(!(await json(facultyAdministrator, '/bootstrap')).notifications.some(item => item.body === anonymousName), 'Anonymous requests reach global administrators only');
  await openPopup(anonymousNotice, 'contacts', 'Demandes de contact');
  const anonymousRecord = (await json(administrator, '/admin')).contacts.find(item => item.message === anonymousMessage);
  assert.ok(anonymousRecord);
  assert.equal(anonymousRecord.faculty_id, null);
  assert.equal(anonymousRecord.user_id, null);
  console.log('PASS anonymous contact recovery popup is scoped to global administrators');

  const applicant = await context();
  const applicantName = `${marker} new student registration`;
  const registered = await json(applicant, '/register', { method: 'POST', data: { name: applicantName, username: `inbox_${suffix}`, email: `inbox_${suffix}@campuslink.test`, password: 'InboxBrowser2026!', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 5 } });
  createdApplicant = registered.user;
  assert.equal(registered.user.account_status, 'pending');
  const registrationNotice = await notify('registrations', applicantName);
  await openPopup(registrationNotice, 'registrations', 'Demandes d’inscription');
  await expect(page.locator(`[data-registration-id="${registered.user.id}"]`)).toBeVisible();
  console.log('PASS student registration popup opens the pending admission tab');

  await page.goto(`${origin}/app/admin?tab=contacts`);
  await page.locator('.admin-contact-list').waitFor();
  await json(administrator, '/profile', { method: 'PATCH', data: { preferences: { ...initialProfile.preferences, admin: false, important: true } } });
  const mutedName = `${marker} muted contact`;
  const mutedMessage = `${marker} live queue while popups muted`;
  await contact(crossStudent, mutedName, mutedMessage);
  await expect(page.locator('.admin-contact-card').filter({ hasText: mutedMessage })).toBeVisible();
  await expect(page.locator('.admin-incoming-alert')).toHaveCount(0);
  assert.ok(!(await snapshot()).notifications.some(item => item.type === 'admin' && item.body === mutedName), 'The administrator preference suppresses the notification row');
  assert.equal(new URL(page.url()).search, '?tab=contacts', 'The already open muted inbox still updates its queue');
  console.log('PASS muted administrative notifications suppress popups while the already open request queue refreshes');

  await json(administrator, '/profile', { method: 'PATCH', data: { preferences: { ...initialProfile.preferences, admin: true, important: true } } });
  for (const language of ['FR', 'AR']) {
    await page.setViewportSize({ width: 360, height: 800 });
    await selectLanguage(page, language);
    const mobileName = `${marker} ${language} contact avec un nom suffisamment long pour vérifier la lecture`;
    await contact(crossStudent, mobileName, `${marker} mobile ${language} request`);
    const mobileNotice = await notify('contacts', mobileName);
    const mobilePopup = await popup(mobileNotice);
    const bounds = await mobilePopup.evaluate(element => {
      const card = element.getBoundingClientRect();
      const text = element.querySelector('strong');
      const close = element.querySelector('button').getBoundingClientRect();
      const link = element.querySelector('a').getBoundingClientRect();
      return { left: card.left, right: card.right, width: innerWidth, content: document.documentElement.scrollWidth, font: parseFloat(getComputedStyle(text).fontSize), closeHeight: close.height, linkHeight: link.height, dir: document.documentElement.dir };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.content <= bounds.width + 1, `${language} mobile popup overflows: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.font >= 15 && bounds.closeHeight >= 40 && bounds.linkHeight >= 38, 'Mobile notification text and actions remain readable and touchable');
    assert.equal(bounds.dir, language === 'AR' ? 'rtl' : 'ltr');
    await page.screenshot({ path: `/tmp/campuslink-admin-alert-${language.toLowerCase()}-mobile.png`, fullPage: true, animations: 'disabled' });
    if (language === 'FR') {
      await mobilePopup.locator('.admin-incoming-close').click();
      await expect(mobilePopup).toHaveCount(0);
      assert.equal(Boolean((await snapshot()).notifications.find(item => item.id === mobileNotice.id)?.read), false, 'Dismissal closes the popup without treating the request as read');
    } else {
      await json(administrator, '/notifications/read', { method: 'POST', data: { ids: [mobileNotice.id] } });
    }
    await refreshFromDuplicateEvent();
    await expect(mobilePopup).toHaveCount(0);
    assert.equal(await page.evaluate(id => window.__campusAlertArrivals.filter(value => value === id).length, mobileNotice.id), 1, 'Dismissed notifications and notices read from another client are not repeated by duplicate events');
  }
  await openScreen(page, '/app/admin?tab=contacts');
  await page.waitForTimeout(300);
  await expect(page.locator('.admin-incoming-alert')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.__campusAlertArrivals), [], 'Reloading reconnects with the existing unread notifications as a silent baseline');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  assert.deepEqual(failedRequests, [], 'No backend failures');
  console.log('PASS readable FR/AR phone popups, dismissal, unread duplicate suppression and reconnect baseline');
} catch (error) {
  console.error(JSON.stringify({ url: page?.url(), errors, failedRequests, body: await page?.locator('body').innerText().catch(() => ''), error: error.message }, null, 2));
  await page?.screenshot({ path: '/tmp/campuslink-admin-alert-error.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  // Do not leave an extra pending counter behind for another suite using this
  // same fixture. Only this test's randomly named applicant is removable here.
  if (administrator && createdApplicant?.username === `inbox_${suffix}`) await administrator.request.delete(`${origin}/api/admin/users/${createdApplicant.id}`).catch(() => {});
  if (administrator && initialProfile) await administrator.request.patch(`${origin}/api/profile`, { data: { language: initialProfile.language || 'fr', preferences: initialProfile.preferences } }).catch(() => {});
  for (const owner of contexts) await owner.close().catch(() => {});
  await browser.close();
}
