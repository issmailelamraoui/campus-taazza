import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { createTestApp } from './helpers.mjs';
import { browserOptions, selectLanguage } from './browser-utils.mjs';
import { makePdf } from '../server/seed.js';

// This suite exercises the production profile defaults, independently of the
// historical FLAA permission fixture or the shared port-5174 browser runner.
const server = createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let environment, browser, adminPage, studentPage;
let releasePendingSend;
const errors = [];
const failedApiRequests = [];
const report = message => console.log(`PASS ${message}`);
const expect = playwrightExpect.configure({ timeout: 20000 });

async function json(context, path, options) {
  const response = await context.request.fetch(`${origin}/api${path}`, options);
  const body = await response.json();
  assert.ok(response.ok(), `${path}: ${response.status()} ${JSON.stringify(body)}`);
  return body;
}

async function login(context, username, password) {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 500 && new URL(response.url()).pathname.startsWith('/api/')) failedApiRequests.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`${origin}/login`);
  await page.locator('input[autocomplete=username]').fill(username);
  await page.locator('input[autocomplete=current-password]').fill(password);
  await page.locator('.login-form-wrap form >button').click();
  await page.waitForURL('**/app');
  await page.locator('.study-page').waitFor();
  return page;
}

async function chat(page, id) {
  await page.goto(`${origin}/app/chat/important${id ? `#message-${id}` : ''}`);
  await page.locator('.chat-composer').waitFor();
  if (id) await page.locator(`#message-${id}`).scrollIntoViewIfNeeded();
}

async function menu(page, id) {
  const trigger = page.locator(`#message-${id} .message-hover-actions >button[aria-expanded]`);
  await trigger.click();
  const current = page.locator(`#message-menu-${id}`);
  await expect(current).toBeVisible();
  await expect(page.locator('.message-menu')).toHaveCount(1);
  return current;
}

async function send(page, content) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/messages') && response.request().method() === 'POST');
  await page.locator('.chat-composer textarea').fill(content);
  await page.locator('.composer-send').click();
  const posted = await response;
  assert.ok(posted.ok(), `Send message: ${posted.status()}`);
  const { message } = await posted.json();
  await expect(page.locator(`#message-${message.id}`)).toBeVisible();
  return message;
}

async function deleteOwn(page, id) {
  const current = await menu(page, id);
  const response = page.waitForResponse(response => response.url().endsWith(`/api/messages/${id}`) && response.request().method() === 'DELETE');
  await current.getByRole('button', { name: 'Supprimer le message', exact: true }).click();
  assert.ok((await response).ok());
  await expect(page.locator(`#message-${id}`)).toHaveCount(0);
  await expect(page.locator('.message-menu')).toHaveCount(0);
}

async function inspectMenuBounds(page, id, label) {
  const current = await menu(page, id);
  const bounds = await current.evaluate(element => {
    const menu = element.getBoundingClientRect();
    const scroll = document.querySelector('.chat-scroll').getBoundingClientRect();
    const rectangle = value => ({ left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height });
    return { menu: rectangle(menu), scroll: rectangle(scroll), viewport: { width: innerWidth, height: innerHeight }, font: parseFloat(getComputedStyle(element.querySelector('button')).fontSize), actionHeight: element.querySelector('button').getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(bounds.overflow, false, `${label}: viewport overflow`);
  assert.ok(bounds.menu.left >= Math.max(0, bounds.scroll.left) - 1 && bounds.menu.right <= Math.min(bounds.viewport.width, bounds.scroll.right) + 1, `${label}: horizontal menu clipping ${JSON.stringify(bounds)}`);
  assert.ok(bounds.menu.top >= Math.max(0, bounds.scroll.top) - 1 && bounds.menu.bottom <= Math.min(bounds.viewport.height, bounds.scroll.bottom) + 1, `${label}: vertical menu clipping ${JSON.stringify(bounds)}`);
  assert.ok(bounds.font >= 14, `${label}: readable action font`);
  assert.ok(bounds.actionHeight >= 43, `${label}: touch target height`);
  return current;
}

try {
  environment = await createTestApp({ legacyCommunity: false, appOrigin: origin });
  server.on('request', environment.app);
  browser = await chromium.launch(browserOptions());
  const admin = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const student = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  adminPage = await login(admin, 'admin', 'Admin2026!');
  studentPage = await login(student, 'meryem', 'Campus2026!');
  await json(student, '/studies', { method: 'POST', data: { filiere_id: 'data_science', current_semester: 1 } });
  const self = (await json(admin, '/session')).user;
  assert.equal(self.name, 'Issmail');
  assert.equal(self.faculty_id, 'fsa');
  assert.equal(self.filiere_id, 'data_science');
  assert.equal(self.role, 'global_admin');
  assert.equal((await json(admin, '/bootstrap')).user.role, 'global_admin');
  for (const context of [admin, student]) {
    const data = await json(context, '/bootstrap');
    assert.ok(data.members.every(member => member.role === 'student'));
    assert.ok(data.messages.every(message => message.author.role === 'student'));
    assert.ok(data.resources.every(resource => resource.author.role === 'student'));
    assert.ok(data.announcements.every(announcement => announcement.author.role === 'student'));
    assert.ok(!data.members.some(member => /professeure|Nadia/.test(`${member.username} ${member.name}`)));
  }
  await studentPage.goto(`${origin}/app/members`);
  await expect(studentPage.locator('.study-member-card').first()).toBeVisible();
  await expect(studentPage.getByRole('button', { name: 'Équipe administrative', exact: true })).toHaveCount(0);
  for (const card of await studentPage.locator('.study-member-card').all()) await expect(card.getByText('Étudiant', { exact: true })).toBeVisible();
  const publication = (await json(admin, '/admin/announcements', { method: 'POST', data: { content: 'Information de communauté de contrôle.' } })).announcements[0];
  await studentPage.goto(`${origin}/app/announcements#announcement-${publication.id}`);
  const announcement = studentPage.locator(`#announcement-${publication.id}`);
  await expect(announcement).toBeVisible();
  await expect(announcement.locator('.announcement-footer')).toContainText(/communauté/i);
  await expect(announcement.locator('.announcement-footer')).not.toContainText(/administrat|admin/i);
  report('production owner profile, private self permissions and student-only public profiles');

  await chat(adminPage);
  await chat(studentPage);
  const ownerMessage = await send(adminPage, 'Message personnel de contrôle.');
  const ownStudentMessage = await send(studentPage, 'Message étudiant à supprimer.');
  const peerMessage = (await json(student, '/messages', { method: 'POST', data: { channel: 'important', content: 'OK' } })).message;
  await chat(studentPage, ownerMessage.id);
  const foreignMenu = await menu(studentPage, ownerMessage.id);
  await expect(foreignMenu.getByRole('button', { name: 'Supprimer le message', exact: true })).toHaveCount(0);
  await expect(foreignMenu.getByRole('button', { name: 'Bloquer les chats', exact: true })).toHaveCount(0);
  await studentPage.keyboard.press('Escape');
  await chat(studentPage, ownStudentMessage.id);
  await deleteOwn(studentPage, ownStudentMessage.id);
  await chat(adminPage, ownerMessage.id);
  await deleteOwn(adminPage, ownerMessage.id);
  report('both participants delete their own messages through the menu; students cannot delete another participant');

  const uploaded = await json(student, '/uploads', { method: 'POST', multipart: {
    filiere_id: 'data_science', semester: '2', module: 'Contrôle du partage', resource_type: 'courses', category: 'courses', title: 'Document conservé après suppression du message', channel: 'important', content: 'Document de contrôle.',
    file: { name: 'moderation-validation.pdf', mimeType: 'application/pdf', buffer: makePdf('Moderation browser validation', ['Preserve this academic resource when its conversation is deleted.']) },
  } });
  await chat(studentPage, uploaded.message.id);
  await deleteOwn(studentPage, uploaded.message.id);
  const retained = (await json(student, '/bootstrap')).resources.find(resource => resource.id === uploaded.resource.id);
  assert.ok(retained);
  assert.equal(retained.message_id, null);
  assert.equal((await student.request.get(`${origin}/api/files/${retained.id}`)).status(), 200);
  report('deleting an attached chat message preserves its academic resource and private file');

  await chat(adminPage, peerMessage.id);
  await expect(adminPage.locator('.chat-message .message-role,.chat-message .role-badge,.chat-message .verified-badge,.chat-message.admin-message')).toHaveCount(0);
  await menu(adminPage, peerMessage.id);
  const otherMessage = (await json(admin, '/messages', { method: 'POST', data: { channel: 'important', content: 'Autre message pour tester le menu unique.' } })).message;
  await adminPage.keyboard.press('Escape');
  await chat(adminPage, peerMessage.id);
  await menu(adminPage, peerMessage.id);
  const other = adminPage.locator(`#message-${otherMessage.id} .message-hover-actions >button[aria-expanded]`);
  const position = await other.boundingBox();
  assert.ok(position && position.y >= 0 && position.y + position.height <= 900, 'The second visible message provides a reachable background trigger');
  {
    const intercepts = await adminPage.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('chat-menu-backdrop'), { x: position.x + position.width / 2, y: position.y + position.height / 2 });
    assert.equal(intercepts, true, 'Open menu backdrop intercepts another message trigger');
    await adminPage.mouse.click(position.x + position.width / 2, position.y + position.height / 2);
    await expect(adminPage.locator('.message-menu')).toHaveCount(0);
    await expect(other).toHaveAttribute('aria-expanded', 'false');
  }
  await menu(adminPage, peerMessage.id);
  await adminPage.keyboard.press('Escape');
  await expect(adminPage.locator('.message-menu')).toHaveCount(0);
  await menu(adminPage, peerMessage.id);
  await adminPage.locator('.chat-menu-backdrop').click({ position: { x: 3, y: 3 } });
  await expect(adminPage.locator('.message-menu')).toHaveCount(0);
  report('one menu, intercepted background triggers, outside dismissal and Escape');

  await mkdir(resolve('screenshots'), { recursive: true });
  const probes = [
    { width: 1440, height: 900, language: 'FR', theme: 'light' },
    { width: 1440, height: 900, language: 'FR', theme: 'dark' },
    { width: 768, height: 1024, language: 'FR', theme: 'light' },
    { width: 768, height: 1024, language: 'AR', theme: 'dark' },
    { width: 360, height: 640, language: 'FR', theme: 'dark' },
    { width: 360, height: 640, language: 'AR', theme: 'light' },
    { width: 390, height: 460, language: 'AR', theme: 'light' },
    { width: 390, height: 460, language: 'AR', theme: 'dark' },
  ];
  for (const probe of probes) {
    console.log(`CHECK menu ${probe.width}x${probe.height}/${probe.language}/${probe.theme}`);
    await adminPage.setViewportSize({ width: probe.width, height: probe.height });
    await selectLanguage(adminPage, probe.language);
    await adminPage.goto(`${origin}/app/settings`);
    await adminPage.locator(`.study-appearance-options button[data-theme-option="${probe.theme}"]`).click();
    await chat(adminPage, peerMessage.id);
    await expect(adminPage.locator('html')).toHaveAttribute('data-theme', probe.theme);
    await expect(adminPage.locator('html')).toHaveAttribute('dir', probe.language === 'AR' ? 'rtl' : 'ltr');
    await inspectMenuBounds(adminPage, peerMessage.id, `${probe.width}x${probe.height}/${probe.language}/${probe.theme}`);
    if (probe.width === 1440 && probe.theme === 'dark') await adminPage.screenshot({ path: resolve('screenshots/student-community-chat-desktop.png') });
    if (probe.width === 390 && probe.theme === 'dark') await adminPage.screenshot({ path: resolve('screenshots/student-community-chat-phone.png') });
    await adminPage.keyboard.press('Escape');
  }
  report('received-message menus fit phone, short-phone, tablet and desktop in both themes and Arabic RTL');

  await adminPage.setViewportSize({ width: 1440, height: 900 });
  await selectLanguage(adminPage, 'FR');
  await chat(adminPage, peerMessage.id);
  await chat(studentPage, peerMessage.id);
  // A send that is still waiting when access is revoked must not recreate a
  // failed local draft after the late 403, or resurface when access is restored.
  const delayedContent = 'Envoi en attente pendant la révocation de l’accès.';
  const sendGate = new Promise(resolveSend => { releasePendingSend = resolveSend; });
  let sendCaptured = false;
  const delayedSendHandler = async route => {
    if (route.request().method() !== 'POST' || sendCaptured) return route.continue();
    sendCaptured = true;
    await sendGate;
    await route.continue();
  };
  const delayedSendPattern = `${origin}/api/messages`;
  await studentPage.route(delayedSendPattern, delayedSendHandler);
  const delayedResponse = studentPage.waitForResponse(response => response.url().endsWith('/api/messages') && response.request().method() === 'POST');
  await studentPage.locator('.chat-composer textarea').fill(delayedContent);
  await studentPage.locator('.composer-send').click();
  await expect.poll(() => sendCaptured).toBe(true);
  await expect(studentPage.locator('.chat-message').filter({ hasText: delayedContent })).toHaveAttribute('data-status', 'pending');
  await expect(studentPage.locator('.chat-composer textarea')).toHaveValue('');
  const blockMenu = await menu(adminPage, peerMessage.id);
  const blocked = adminPage.waitForResponse(response => response.url().endsWith('/api/chat/blocks') && response.request().method() === 'POST');
  await blockMenu.getByRole('button', { name: 'Bloquer les chats', exact: true }).click();
  assert.ok((await blocked).ok());
  await expect(studentPage.locator('.chat-blocked-page')).toBeVisible({ timeout: 15000 });
  await expect(studentPage.locator('.chat-composer')).toHaveCount(0);
  releasePendingSend();
  assert.equal((await delayedResponse).status(), 403, 'In-flight send is rejected after chat access is revoked');
  await studentPage.unroute(delayedSendPattern, delayedSendHandler);
  releasePendingSend = null;
  await expect(studentPage.locator('.chat-blocked-page')).toBeVisible();
  assert.equal((await json(student, '/session')).user.id, 12);
  assert.equal((await json(student, '/session')).user.chat_blocked, true);
  await studentPage.locator('.chat-blocked-page a[href="/app/resources/courses"]').click();
  await studentPage.waitForURL('**/app/resources/courses');
  await expect(studentPage.locator(`#resource-${retained.id}`)).toBeVisible();
  assert.equal((await student.request.get(`${origin}/api/files/${retained.id}`)).status(), 200);
  await adminPage.goto(`${origin}/app/members`);
  const blockedMember = adminPage.locator('#member-12');
  await expect(blockedMember).toBeVisible();
  const unblock = blockedMember.getByRole('button', { name: 'Débloquer les chats · Meryem', exact: true });
  await expect(unblock).toBeEnabled({ timeout: 15000 });
  const restored = adminPage.waitForResponse(response => response.url().endsWith('/api/chat/blocks/12') && response.request().method() === 'DELETE');
  await unblock.click();
  assert.ok((await restored).ok());
  // Reading the retained document refreshes the same mounted provider. Avoid a
  // hard reload here: that would discard local operations and hide an epoch bug.
  const refreshedAccess = studentPage.waitForResponse(response => response.url().endsWith('/api/bootstrap') && response.request().method() === 'GET');
  await studentPage.locator(`#resource-${retained.id} .resource-preview`).click();
  assert.equal((await (await refreshedAccess).json()).user.chat_blocked, false);
  await studentPage.keyboard.press('Escape');
  const navigation = studentPage.locator('.mobile-menu');
  if (await navigation.getAttribute('aria-expanded') !== 'true') await navigation.click();
  await studentPage.locator('.faculty-sidebar a[href="/app/chat/important"]').click();
  await studentPage.locator('.chat-composer').waitFor();
  assert.equal((await json(student, '/session')).user.chat_blocked, false);
  await expect(studentPage.locator('.chat-message').filter({ hasText: delayedContent })).toHaveCount(0);
  assert.equal((await json(student, '/bootstrap')).messages.some(message => message.content === delayedContent), false);
  await send(studentPage, 'Accès aux conversations rétabli.');
  report('admin chat ban updates the live student UI without logout; files remain available and Members restores access');
  report('late rejected send after a live ban does not resurface when access is restored');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  assert.deepEqual(failedApiRequests, [], 'No unexpected server errors');
  report('student community moderation browser suite complete');
} catch (error) {
  await mkdir(resolve('screenshots'), { recursive: true });
  if (adminPage && !adminPage.isClosed()) {
    await adminPage.screenshot({ path: resolve('screenshots/student-community-chat-failure.png') }).catch(() => {});
    console.error('MODERATION FAILURE STATE', JSON.stringify({ admin: { url: adminPage.url(), text: await adminPage.locator('body').innerText().catch(() => '') }, student: studentPage && !studentPage.isClosed() ? { url: studentPage.url(), text: await studentPage.locator('body').innerText().catch(() => '') } : null, failedApiRequests, backend: environment?.app.locals.lastError }));
  }
  throw error;
} finally {
  releasePendingSend?.();
  await browser?.close();
  environment?.app.locals.endStreams();
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  await environment?.close();
}
