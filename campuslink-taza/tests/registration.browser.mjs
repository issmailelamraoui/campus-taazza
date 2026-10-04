import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { browserOptions, selectLanguage } from './browser-utils.mjs';
import { getFilieres, getChatSemester } from '../shared/studies.js';

// This suite creates and deletes test accounts. The runner supplies this flag
// only after creating its disposable PostgreSQL schema and identity fixtures.
assert.equal(process.env.CAMPUS_BROWSER_DISPOSABLE, '1', 'Run registration checks through tests/run-browser.mjs, never against a real campus account.');
const origin = process.env.CAMPUS_BROWSER_ORIGIN;
assert.ok(origin, 'The disposable browser server origin is required.');
const browser = await chromium.launch(browserOptions());
const contexts = [];
const errors = [];
const suffix = randomUUID().slice(0, 8);
const password = 'RegistrationBrowser2026!';
const approvedUsername = `register_approved_${suffix}`;
const rejectedUsername = `register_rejected_${suffix}`;
let page;
let releaseHeldDeletion;

async function context(options) {
  const result = await browser.newContext(options);
  contexts.push(result);
  return result;
}
async function newPage(owner) {
  const result = await owner.newPage();
  result.on('pageerror', error => errors.push(error.message));
  return result;
}
async function request(owner, path, options) {
  return owner.request.fetch(`${origin}/api${path}`, options);
}
async function json(owner, path, options) {
  const response = await request(owner, path, options);
  const body = await response.json();
  assert.ok(response.ok(), `${path}: ${response.status()} ${JSON.stringify(body)}`);
  return body;
}
async function denied(owner, path, options, code = 'ACCOUNT_PENDING') {
  const response = await request(owner, path, options);
  assert.equal(response.status(), 403, `${path} cannot be accessed before approval`);
  assert.equal((await response.json()).code, code, `${path} reports the admission gate`);
}
async function login(owner, username, accountPassword = 'Campus2026!') {
  return json(owner, '/login', { method: 'POST', data: { username, password: accountPassword } });
}
async function layout(target, width, language = 'FR') {
  await target.setViewportSize({ width, height: 940 });
  await selectLanguage(target, language);
  const dimensions = await target.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth, direction: document.documentElement.dir }));
  assert.ok(dimensions.content <= dimensions.width + 1, `${target.url()} overflows at ${width}px ${language}: ${JSON.stringify(dimensions)}`);
  if (language === 'AR') assert.equal(dimensions.direction, 'rtl');
}
async function adminScreen(target) {
  await target.goto(`${origin}/app/admin`);
  await target.locator('.admin-tabbar').waitFor({ timeout: 30000 });
  await target.locator('.admin-loading').waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(await target.locator('.admin-error').count(), 0);
}
async function registrationTab(target) {
  await target.locator('.admin-tabbar').getByRole('tab', { name: /Demandes d.inscription/ }).click();
}

try {
  const admin = await context({ viewport: { width: 1440, height: 1000 } });
  const existing = await context();
  const student = await context({ viewport: { width: 390, height: 940 } });
  const rejected = await context({ viewport: { width: 390, height: 940 } });
  const observer = await context();
  await login(admin, 'admin', 'Admin2026!');
  const adminBootstrap = await json(admin, '/bootstrap');
  await json(admin, '/profile', { method: 'PATCH', data: { preferences: { ...adminBootstrap.user.preferences, admin: false } } });
  const initialAdmissionNotices = adminBootstrap.notifications.filter(notification => notification.path === '/app/admin?tab=registrations').length;
  const adminPage = await newPage(admin);
  const administratorStream = adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/events/stream', { timeout: 30000 });
  await adminScreen(adminPage);
  await registrationTab(adminPage);
  assert.equal((await administratorStream).status(), 200, 'The open registration panel receives authorized live updates');
  await login(existing, 'yassine');
  assert.equal((await json(existing, '/bootstrap')).user.account_status, 'approved', 'Existing students keep their approved access');
  await login(observer, 'meryem');

  page = await newPage(student);
  await page.goto(`${origin}/login`);
  await page.getByRole('link', { name: 'Créer un compte', exact: true }).click();
  await page.waitForURL('**/register');
  const form = page.locator('form').filter({ has: page.locator('#register-name') });
  await page.locator('#register-faculty option[value="fsa"]').waitFor({ state: 'attached', timeout: 30000 });
  assert.equal(await form.evaluate(element => element.checkValidity()), false, 'An empty signup cannot submit without the required information');
  for (const faculty of ['fsa', 'flaa', 'feg', 'fsjp']) {
    await page.locator('#register-faculty').selectOption(faculty);
    const offered = await page.locator('#register-filiere').evaluate(select => [...select.options].filter(option => option.value).map(option => ({ id: option.value, name: option.textContent.trim() })));
    assert.deepEqual(offered, getFilieres(faculty), `${faculty} offers only its existing exact majors`);
    assert.equal(await page.locator('#register-filiere').inputValue(), '', 'Changing faculty clears the previous major');
    await page.locator('#register-filiere').selectOption(getFilieres(faculty)[0].id);
  }
  await page.locator('#register-faculty').selectOption('fsa');
  await page.locator('#register-filiere').selectOption('data_science');
  await page.locator('#register-name').fill('Étudiante Inscription Browser');
  await page.locator('#register-username').fill(approvedUsername);
  await page.locator('#register-email').fill(`${approvedUsername}@campuslink.test`);
  await page.locator('#register-password').fill(password);
  await page.locator('#register-semester').selectOption('6');
  assert.ok(await form.evaluate(element => element.checkValidity()), 'All required registration details form a valid account request');
  for (const width of [390, 768, 1440]) await layout(page, width);
  await layout(page, 390, 'AR');
  await page.screenshot({ path: '/tmp/campuslink-registration-arabic-mobile.png', fullPage: true });
  await selectLanguage(page, 'FR');
  const registered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/register' && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Créer un compte', exact: true }).click();
  const registrationResponse = await registered;
  assert.equal(registrationResponse.status(), 201);
  const newStudent = (await registrationResponse.json()).user;
  assert.equal(newStudent.account_status, 'pending');
  assert.equal(newStudent.role, 'student');
  assert.equal(newStudent.faculty_id, 'fsa');
  assert.equal(newStudent.filiere_id, 'data_science');
  assert.equal(newStudent.current_semester, 6);
  const liveApplicant = adminPage.locator(`[data-registration-id="${newStudent.id}"]`);
  await liveApplicant.waitFor({ timeout: 30000 });
  assert.equal(new URL(adminPage.url()).pathname, '/app/admin', 'The existing administrator panel receives the request without navigation or reload');
  assert.equal((await json(admin, '/bootstrap')).notifications.filter(notification => notification.path === '/app/admin?tab=registrations').length, initialAdmissionNotices, 'Muted administrator notifications do not prevent live request updates');
  await json(admin, '/profile', { method: 'PATCH', data: { preferences: adminBootstrap.user.preferences } });
  await page.waitForURL('**/account-review', { timeout: 30000 });
  await page.getByRole('heading', { name: 'Votre inscription est en attente', exact: true }).waitFor();
  assert.equal(await page.locator('.app-shell').count(), 0, 'A pending account never enters the community UI');
  await layout(page, 390, 'AR');
  await selectLanguage(page, 'FR');
  await page.screenshot({ path: '/tmp/campuslink-registration-pending-mobile.png', fullPage: true });
  const pendingSession = await json(student, '/session');
  assert.equal(pendingSession.user.id, newStudent.id, 'The waiting page retains a private authenticated session');
  assert.equal(pendingSession.user.account_status, 'pending');

  for (const path of ['/bootstrap', '/messages?channel=general', '/studies', '/modules?filiere_id=data_science&semester=6', '/search?q=campus', '/events/stream', '/admin/registrations', `/files/${adminBootstrap.resources[0].id}`, `/avatars/${adminBootstrap.user.id}`]) await denied(student, path);
  await denied(student, '/messages', { method: 'POST', data: { channel: 'general', content: 'Pending accounts must not publish this.' } });
  await denied(student, '/profile', { method: 'PATCH', data: { account_status: 'approved', name: 'Cannot self-approve' } });
  await denied(student, '/studies', { method: 'POST', data: { filiere_id: 'data_science', current_semester: 1 } });
  await denied(student, '/uploads', { method: 'POST', multipart: { file: { name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.from('No resource may be published by a pending account.') }, title: 'Pending resource', filiere_id: 'data_science', semester: '6', module: 'Test', resource_type: 'document', category: 'courses', channel: 'general' } });
  await page.goto(`${origin}/app/chat/general`);
  await page.waitForURL('**/account-review', { timeout: 30000 });
  assert.equal(await page.locator('.chat-composer').count(), 0);
  const observerBefore = await json(observer, '/bootstrap');
  assert.ok(!observerBefore.members.some(member => member.id === newStudent.id), 'Pending applicants are absent from public members');
  console.log('PASS complete signup, exact faculty-major filtering, mobile/RTL layouts, and pending API/UI isolation');

  const applicant = adminPage.locator(`[data-registration-id="${newStudent.id}"]`);
  await applicant.waitFor();
  await expect(applicant).toContainText(approvedUsername);
  await expect(applicant).toContainText('Sciences de Données');
  await expect(applicant).toContainText('S6');
  const admission = adminPage.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/users/${newStudent.id}/admission` && response.request().method() === 'PATCH');
  await applicant.getByRole('button', { name: 'Accepter', exact: true }).click();
  assert.ok((await admission).ok());
  await expect(applicant).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: 'Vérifier le statut', exact: true }).click();
  await page.waitForURL('**/app', { timeout: 30000 });
  await page.locator('.app-shell').waitFor({ timeout: 30000 });
  const approvedSession = (await json(student, '/session')).user;
  assert.equal(approvedSession.id, newStudent.id, 'Approval activates the original session without a second login');
  assert.equal(approvedSession.account_status, 'approved');
  await page.goto(`${origin}/app/chat/filiere`);
  await page.locator('.chat-group-selector').waitFor({ timeout: 30000 });
  await expect(page.locator('.chat-group-selector')).toHaveValue(String(getChatSemester(6)));
  assert.equal(await page.locator('.chat-group-selector option').count(), 3, 'Previously requested paired semester chats remain intact');
  assert.equal((await json(student, '/bootstrap')).user.current_semester, 6, 'Approval keeps the exact academic semester');
  console.log('PASS global administrator approval activates the current session and preserves the study-year chat default');

  const rejectedPayload = { name: 'Inscription Refusée Browser', username: rejectedUsername, email: `${rejectedUsername}@campuslink.test`, password, faculty_id: 'feg', filiere_id: 'management', current_semester: 3 };
  const attempt = await request(rejected, '/register', { method: 'POST', data: { ...rejectedPayload, role: 'global_admin', account_status: 'approved', disabled: false } });
  let rejectedStudent;
  if (attempt.ok()) {
    rejectedStudent = (await attempt.json()).user;
    assert.equal(rejectedStudent.role, 'student', 'Registration cannot grant an administrator role');
    assert.equal(rejectedStudent.account_status, 'pending', 'Registration cannot bypass admission');
  } else {
    assert.equal(attempt.status(), 400, 'Privileged registration fields are rejected as invalid');
    rejectedStudent = (await json(rejected, '/register', { method: 'POST', data: rejectedPayload })).user;
  }
  const rejectedPage = await newPage(rejected);
  await rejectedPage.goto(`${origin}/account-review`);
  await rejectedPage.getByRole('heading', { name: 'Votre inscription est en attente', exact: true }).waitFor({ timeout: 30000 });
  await adminPage.reload();
  await adminPage.locator('.admin-loading').waitFor({ state: 'hidden', timeout: 30000 });
  await registrationTab(adminPage);
  const rejectedRow = adminPage.locator(`[data-registration-id="${rejectedStudent.id}"]`);
  const refusal = adminPage.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/users/${rejectedStudent.id}/admission` && response.request().method() === 'PATCH');
  await rejectedRow.getByRole('button', { name: 'Refuser', exact: true }).click();
  assert.ok((await refusal).ok());
  await rejectedPage.getByRole('button', { name: 'Vérifier le statut', exact: true }).click();
  await rejectedPage.getByRole('heading', { name: 'Inscription refusée', exact: true }).waitFor({ timeout: 30000 });
  assert.equal((await json(rejected, '/session')).user.account_status, 'rejected');
  await denied(rejected, '/bootstrap', undefined, 'ACCOUNT_REJECTED');
  await denied(rejected, '/events/stream', undefined, 'ACCOUNT_REJECTED');
  await rejectedPage.goto(`${origin}/app`);
  await rejectedPage.waitForURL('**/account-review', { timeout: 30000 });
  await adminPage.goto(`${origin}/app/admin?tab=registrations`);
  await adminPage.locator('.admin-tabbar').waitFor({ timeout: 30000 });
  await layout(adminPage, 390, 'AR');
  await expect(adminPage.locator('.admin-tabbar').getByRole('tab', { name: 'طلبات التسجيل', exact: true })).toHaveAttribute('aria-selected', 'true');
  await adminPage.locator('.admin-loading').waitFor({ state: 'hidden', timeout: 30000 });
  await adminPage.screenshot({ path: '/tmp/campuslink-registration-admin-arabic-mobile.png', fullPage: true });
  await selectLanguage(adminPage, 'FR');
  await adminScreen(adminPage);
  console.log('PASS rejected accounts remain outside the community and cannot register themselves as administrators');

  const text = `Resource retained after student removal ${suffix}`;
  const uploaded = await json(student, '/uploads', { method: 'POST', multipart: {
    file: { name: 'registration-retained.txt', mimeType: 'text/plain', buffer: Buffer.from(text) },
    title: text, filiere_id: 'data_science', semester: '6', module: 'Module préservé', resource_type: 'document', category: 'courses', channel: 'general', content: text,
  } });
  const protectedStudentDelete = await request(observer, `/admin/users/${newStudent.id}`, { method: 'DELETE' });
  assert.equal(protectedStudentDelete.status(), 403, 'A student cannot remove another student');
  const protectedAdminDelete = await request(admin, `/admin/users/${adminBootstrap.user.id}`, { method: 'DELETE' });
  assert.ok([400, 403].includes(protectedAdminDelete.status()), 'Administrator self-deletion is protected');
  await adminPage.locator('.admin-tabbar').getByRole('tab', { name: 'Utilisateurs', exact: true }).click();
  await adminPage.getByPlaceholder('Rechercher un utilisateur…').fill(approvedUsername);
  const userRow = adminPage.locator('.admin-user-row').filter({ hasText: approvedUsername });
  await userRow.getByRole('button', { name: /Gérer/ }).click();
  const dialog = adminPage.getByRole('dialog');
  await dialog.getByRole('button', { name: /Supprimer l’étudiant/, exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Confirmer la suppression', exact: true })).toBeVisible();
  assert.equal((await json(student, '/session')).user.id, newStudent.id, 'Opening the confirmation does not remove the student');
  await dialog.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Confirmer la suppression', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: /Supprimer l’étudiant/, exact: true }).click();
  let deletionIntercepted;
  const interceptedDeletion = new Promise(resolve => { deletionIntercepted = resolve; });
  const heldDeletion = new Promise(resolve => { releaseHeldDeletion = resolve; });
  await adminPage.route(`${origin}/api/admin/users/${newStudent.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deletionIntercepted();
    await heldDeletion;
    await route.continue();
  });
  const removal = adminPage.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/users/${newStudent.id}` && response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Confirmer la suppression', exact: true }).click();
  await interceptedDeletion;
  await expect(userRow).toHaveCount(0, { timeout: 1000 });
  const concurrent = await context();
  const reloadedAdministrator = adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/admin' && response.request().method() === 'GET', { timeout: 30000 });
  await json(concurrent, '/register', { method: 'POST', data: { name: 'Inscription Concurrente Browser', username: `register_concurrent_${suffix}`, email: `register_concurrent_${suffix}@campuslink.test`, password, faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 1 } });
  assert.ok((await reloadedAdministrator).ok(), 'A concurrent registration refreshes the already open administrator screen');
  await expect(userRow).toHaveCount(0, { timeout: 1000 });
  assert.equal((await json(student, '/session')).user.id, newStudent.id, 'The held deletion has not reached the backend yet');
  releaseHeldDeletion();
  assert.ok((await removal).ok());
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  await expect(userRow).toHaveCount(0, { timeout: 30000 });
  assert.equal((await json(student, '/session')).user, null, 'Student deletion invalidates the already authenticated session');
  assert.equal((await request(student, '/bootstrap')).status(), 401);
  await page.waitForURL('**/login', { timeout: 30000 });
  assert.equal(await page.locator('.app-shell').count(), 0, 'Student deletion closes the already open chat immediately without a page reload');
  const oldLogin = await request(student, '/login', { method: 'POST', data: { username: approvedUsername, password } });
  assert.ok(!oldLogin.ok(), 'The removed username cannot authenticate or recreate its old profile');
  const after = await json(observer, '/bootstrap');
  assert.ok(!after.members.some(member => member.id === newStudent.id), 'Removed students disappear from public members');
  const retained = after.resources.find(resource => resource.id === uploaded.resource.id);
  assert.ok(retained, 'Removing a student preserves their academic resources');
  assert.equal(retained.semester, 6);
  assert.equal(retained.module, 'Module préservé');
  assert.equal(retained.title, text);
  const retainedMessage = after.messages.find(message => message.id === uploaded.message.id);
  assert.ok(retainedMessage, 'Removing a student preserves academic chat history');
  assert.notEqual(retained.author.name, newStudent.name, 'Preserved resource attribution no longer exposes the removed profile');
  assert.notEqual(retainedMessage.author.name, newStudent.name, 'Preserved message attribution no longer exposes the removed profile');
  const file = await request(observer, `/files/${retained.id}`);
  assert.equal(file.status(), 200, 'The retained academic file remains available to approved faculty members');
  assert.equal((await file.body()).toString(), text);
  assert.deepEqual(errors, [], 'Registration and student management have no browser runtime errors');
  console.log('PASS confirmed student deletion revokes existing access and preserves anonymized academic files and chat history');
  console.log(JSON.stringify({ status: 'passed', tests: 'Signup, pending isolation, administrator approval/refusal, semester defaults, student deletion and retained resources', screenshots: ['/tmp/campuslink-registration-arabic-mobile.png', '/tmp/campuslink-registration-pending-mobile.png', '/tmp/campuslink-registration-admin-arabic-mobile.png'] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ url: page?.url(), errors, body: await page?.locator('body').innerText().catch(() => ''), error: error.message }, null, 2));
  await page?.screenshot({ path: '/tmp/campuslink-registration-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  releaseHeldDeletion?.();
  for (const owner of contexts) await owner.close();
  await browser.close();
}
