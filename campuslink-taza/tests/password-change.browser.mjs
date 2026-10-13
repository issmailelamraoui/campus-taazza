import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// These browser contracts isolate all API calls; no provider passwords change.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5181';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [], passed = [];
const temporary = 'Temporary-password-123!', chosen = 'My-new-personal-password-2026!';

async function setup({ resetState = 'issued', required = true, width = 1280 } = {}) {
  const user = { id: 2, username: 'reset.student', name: 'Sara Student', email: 'student@example.test', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language: 'fr', preferences: {}, must_change_password: required, password_reset_state: required ? resetState : null };
  const state = { user, calls: [], completion: [], delay: 0, failure: null };
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', hasTouch: width < 760 });
  await context.addInitScript(() => {
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    localStorage.setItem('campuslink-private-study-v1:2:knowledge', JSON.stringify([{ id: 'old-private-note', content: 'Private cached note' }]));
    window.__resetStreamOpened = 0; window.__resetStreamClosed = 0;
    window.EventSource = class { constructor() { window.__resetStreamOpened++; } addEventListener() {} close() { window.__resetStreamClosed++; } };
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/api/, ''), method = request.method();
    state.calls.push({ method, path });
    const send = (data, status = 200) => route.fulfill({ status, json: data });
    if (path === '/session') return send({ user: state.user });
    if (path === '/bootstrap') {
      if (state.user?.must_change_password) return send({ error: 'Choisissez votre mot de passe.', code: 'PASSWORD_CHANGE_REQUIRED' }, 403);
      return send({ user: state.user, faculty: { id: 'flaa', code: 'FLAA', name: 'Faculté de test' }, resources: [], announcements: [], messages: [], notifications: [], unread_count: 0, saved: [], history: [], events: [], channels: [], members: [] });
    }
    if (path === '/password-reset/complete' && method === 'POST') {
      state.completion.push(request.postDataJSON());
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      if (state.failure) { state.user = { ...state.user, password_reset_state: state.failure.state }; return send({ error: state.failure.error, code: state.failure.code }, state.failure.status); }
      state.user = { ...state.user, must_change_password: false, password_reset_state: null };
      return send({ ok: true, user: state.user });
    }
    if (path === '/contact' && method === 'POST') return send({ ok: true });
    if (path === '/logout' && method === 'POST') { state.user = null; return send({ ok: true }); }
    errors.push(`Unexpected API request: ${method} ${path}`);
    return send({ error: 'Unexpected browser fixture request.' }, 500);
  });
  return { context, page, state };
}

const card = page => page.locator('.password-change-card');
const submit = page => card(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true });
async function enter(page, newPassword = chosen, confirmation = newPassword) {
  await page.getByLabel('Mot de passe temporaire', { exact: true }).fill(temporary);
  await page.getByLabel('Nouveau mot de passe', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirmer le nouveau mot de passe', { exact: true }).fill(confirmation);
}
async function noSecrets(page) {
  const cached = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.equal(cached.includes(temporary), false); assert.equal(cached.includes(chosen), false);
}
async function offlineSnapshot(page) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(value => value.name);
    if (!names.includes('campuslink-offline-session-v1')) return null;
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('campuslink-offline-session-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const value = await new Promise((resolve, reject) => { const request = db.transaction('session').objectStore('session').get('active'); request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error); });
    db.close(); return value;
  });
}
async function scenario(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }

try {
  await scenario('Required sessions block protected deep links and onboarding without bootstrap, events or private snapshots', async () => {
    const { context, page, state } = await setup();
    for (const path of ['/app/library?document=88&page=2#resource-88', '/onboarding', '/login']) {
      await page.goto(baseURL + path); await expect(page).toHaveURL(/\/change-password$/); await expect(card(page)).toBeVisible();
      assert.equal(state.calls.some(call => call.path !== '/session'), false);
      assert.equal(await page.evaluate(() => window.__resetStreamOpened), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('campuslink-private-study-v1:2:knowledge')), null);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('campus-offline-enabled', { detail: { userId: '2' } })));
      assert.equal(await offlineSnapshot(page), null);
    }
    await noSecrets(page); await context.close();
  });

  await scenario('A distinct confirmed password submits once and restores the student destination with a fresh bootstrap', async () => {
    const { context, page, state } = await setup();
    await page.goto(baseURL + '/login'); await expect(card(page)).toBeVisible();
    for (const [password, confirmation] of [[temporary, temporary], ['short', 'short'], [chosen, 'Different-confirmation-123!']]) {
      await enter(page, password, confirmation); await submit(page).click(); await expect(card(page).getByRole('alert')).toBeVisible(); assert.equal(state.completion.length, 0);
    }
    await enter(page); state.delay = 200;
    await card(page).locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await expect(page).toHaveURL(/\/app$/); await expect(page.locator('.home-welcome')).toBeVisible();
    assert.deepEqual(state.completion, [{ currentPassword: temporary, newPassword: chosen }]);
    assert.ok(state.calls.some(call => call.path === '/bootstrap'));
    await expect(page.locator('input[name="currentPassword"]')).toHaveCount(0); await noSecrets(page); await context.close();
  });

  await scenario('Pending, unknown and expired sessions only offer status checks, administration contact and logout', async () => {
    for (const resetState of ['pending', 'unknown', 'expired']) {
      const { context, page, state } = await setup({ resetState, width: 390 });
      await page.goto(baseURL + '/app'); await expect(page).toHaveURL(/\/change-password$/); await expect(card(page)).toBeVisible();
      await expect(card(page).locator('input[type="password"]')).toHaveCount(0);
      await card(page).getByRole('button', { name: 'Vérifier le statut', exact: true }).click();
      await expect(card(page)).toHaveAttribute('aria-busy', 'false');
      assert.equal(state.calls.some(call => !['/session'].includes(call.path)), false);
      await card(page).getByRole('button', { name: 'Contacter l’administration', exact: true }).click();
      const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
      await dialog.getByLabel('Votre message', { exact: true }).fill('Je souhaite un nouvel accès confirmé pour mon compte.');
      await dialog.getByRole('button', { name: 'Envoyer la demande', exact: true }).click(); await expect(dialog).toContainText('Demande envoyée');
      await dialog.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      assert.equal(state.completion.length, 0); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
      await card(page).getByRole('button', { name: 'Se déconnecter', exact: true }).click(); await expect(page).toHaveURL(/\/login$/);
      assert.equal(state.calls.filter(call => call.path === '/logout').length, 1); await noSecrets(page); await context.close();
    }
  });

  await scenario('Status refresh opens an issued form and an expired completion clears credentials and blocks retries', async () => {
    const { context, page, state } = await setup({ resetState: 'pending' });
    await page.goto(baseURL + '/change-password'); await expect(card(page)).toBeVisible();
    state.user = { ...state.user, password_reset_state: 'issued' };
    await card(page).getByRole('button', { name: 'Vérifier le statut', exact: true }).click(); await expect(submit(page)).toBeVisible();
    await enter(page); state.failure = { state: 'expired', status: 403, code: 'PASSWORD_RESET_EXPIRED', error: 'Le mot de passe temporaire a expiré.' };
    await submit(page).click(); await expect(card(page).locator('input[type="password"]')).toHaveCount(0); await expect(card(page)).toContainText('a expiré');
    assert.equal(state.completion.length, 1); assert.equal(state.calls.some(call => call.path === '/bootstrap'), false); await noSecrets(page); await context.close();
  });

  await scenario('An active account reset clears cached private study state and leaves the running campus view', async () => {
    const { context, page, state } = await setup({ required: false });
    await page.goto(baseURL + '/app'); await expect(page.locator('.home-welcome')).toBeVisible();
    state.user = { ...state.user, must_change_password: true, password_reset_state: 'issued' };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page).toHaveURL(/\/change-password$/); await expect(card(page)).toBeVisible();
    assert.equal(await page.evaluate(() => localStorage.getItem('campuslink-private-study-v1:2:knowledge')), null);
    assert.ok(await page.evaluate(() => window.__resetStreamClosed >= 1)); await noSecrets(page); await context.close();
  });
  assert.deepEqual(errors, []); console.log(`${passed.length} forced password change browser scenarios passed.`);
} finally { await browser.close(); }
