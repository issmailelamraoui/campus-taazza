import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// All APIs and Google navigation are intercepted. This suite sends no email
// and changes no provider account or database password.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5183';
const browser = await chromium.launch({ headless: true });
const errors = [], passed = [];
const email = 'sara@usmba.ac.ma', code = '123456', password = '87654321';
await mkdir('test-results/password-recovery', { recursive: true });
async function fixture({ width = 390, theme = 'dark', language = 'fr', profile = false, resetState = null, accountEmail = email } = {}) {
  const user = profile ? { id: 2, username: 'sara.student', name: 'Sara Student', email: accountEmail, role: 'student', faculty_id: 'fsa', filiere_id: 'mathematics', current_semester: 1, account_status: 'approved', preferences: {}, language, ...(resetState ? { must_change_password: true, password_reset_state: resetState } : {}) } : null;
  const state = { user, starts: [], completions: [], profiles: [], google: [], calls: [], sendFailure: null, completeFailure: null, completeAbort: false, completeResult: { success: true }, delay: 0 };
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(({ theme, language }) => {
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    window.EventSource = class { addEventListener() {} close() {} };
  }, { theme, language });
  await context.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Google fixture</title>' }));
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const send = (data, status = 200) => route.fulfill({ status, json: data });
    state.calls.push(path);
    if (path === '/session') return send({ user: state.user });
    if (path === '/auth/google/config') return send({ enabled: true, domains: ['usmba.ac.ma'] });
    if (path === '/profile' && request.method() === 'PATCH') { state.profiles.push(request.postDataJSON()); return send({ user: state.user }); }
    if (path === '/auth/google/start') { state.google.push(request.postDataJSON()); return send({ url: 'https://accounts.google.com/o/oauth2/v2/auth?fixture=1' }); }
    if (path === '/auth/password-recovery/start') {
      state.starts.push(request.postDataJSON());
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      return state.sendFailure ? send({ error: 'Private provider detail', ...state.sendFailure }, state.sendFailure.status || 503) : send({ success: true });
    }
    if (path === '/auth/password-recovery/complete') {
      state.completions.push(request.postDataJSON());
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      if (state.completeAbort) return route.abort('failed');
      if (state.completeFailure) { if (state.completeFailure.code === 'PASSWORD_RECOVERY_UNKNOWN') state.user = null; return send({ error: 'Private provider detail', ...state.completeFailure }, state.completeFailure.status || 400); }
      state.user = null; return send(state.completeResult);
    }
    if (path === '/bootstrap' || path === '/live') return send({ user: state.user, faculty: { id: 'fsa', code: 'FSA', name: 'Faculty fixture' }, resources: [], announcements: [], messages: [], notifications: [], channels: [], members: [], saved: [], history: [], unread_count: 0 });
    if (path === '/auth/google/link') return send({ linked: false });
    if (path.startsWith('/members/') && path.endsWith('/achievements')) return send({ achievements: [], contribution: {} });
    if (path === '/xp' || path.endsWith('/achievements')) return send({ achievements: [], contribution: {} });
    errors.push(`Unexpected API ${path}`); return send({ error: 'Unexpected fixture request' }, 500);
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  return { context, page, state };
}
const form = page => page.locator('.password-recovery-form');
async function sent(page) { await page.locator('[name="recoveryEmail"]').fill(` ${email.toUpperCase()} `); await form(page).getByRole('button', { name: 'Recevoir le code', exact: true }).click(); await expect(page.locator('[name="recoveryCode"]')).toBeVisible(); }
async function choose(page, value = password, confirmation = value) { await page.locator('[name="recoveryCode"]').fill(code); await page.locator('[name="newPassword"]').fill(value); await page.locator('[name="confirmation"]').fill(confirmation); }
async function noSecrets(page) { const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); for (const secret of [email, code, password]) assert.equal(storage.includes(secret), false); }
async function scenario(name, run) { if (process.env.CAMPUS_RECOVERY_UI_SCENARIO && !name.includes(process.env.CAMPUS_RECOVERY_UI_SCENARIO)) return; await run(); passed.push(name); console.log(`PASS ${name}`); }
try {
  await scenario('Forgot password opens dedicated recovery; Google needs no manual email or code', async () => {
    const { context, page, state } = await fixture();
    await page.goto(baseURL + '/login'); await page.getByRole('button', { name: 'Mot de passe oublié ?', exact: true }).click();
    await expect(page).toHaveURL(/\/forgot-password$/); await expect(page.locator('.recovery-card')).toBeVisible(); assert.equal(state.starts.length, 0);
    await page.getByRole('button', { name: 'Continuer avec Google', exact: true }).click(); await expect(page).toHaveURL(/accounts\.google\.com/);
    assert.deepEqual(state.google, [{ intent: 'login' }]); assert.equal(state.starts.length, 0); assert.equal(state.completions.length, 0); await context.close();
  });
  await scenario('Email and OTP validation, one send per double click, eight digits accepted without extra requirements', async () => {
    const { context, page, state } = await fixture({ width: 320 }); await page.goto(baseURL + '/forgot-password');
    await form(page).getByRole('button', { name: 'Recevoir le code', exact: true }).click(); await expect(page.locator('[name="recoveryEmail"]')).toBeFocused(); assert.equal(state.starts.length, 0);
    state.delay = 150; await page.locator('[name="recoveryEmail"]').fill(` ${email.toUpperCase()} `);
    await form(page).getByRole('button', { name: 'Recevoir le code', exact: true }).evaluate(button => { button.click(); button.click(); });
    await expect(page.locator('[name="recoveryCode"]')).toBeFocused(); assert.deepEqual(state.starts, [{ email }]);
    await expect(form(page).getByRole('button', { name: /Renvoyer dans/ })).toBeDisabled();
    await choose(page, '1234567'); await form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click(); await expect(page.locator('[name="newPassword"]')).toBeFocused(); assert.equal(state.completions.length, 0);
    await choose(page, password, '87654322'); await form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click(); await expect(page.locator('[name="confirmation"]')).toBeFocused(); assert.equal(state.completions.length, 0);
    await choose(page); await form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).evaluate(button => { button.click(); button.click(); });
    await expect(page.locator('.password-recovery-done')).toBeVisible(); assert.deepEqual(state.completions, [{ email, code, newPassword: password }]);
    await expect(page.locator('[name="newPassword"]')).toHaveCount(0); await noSecrets(page); await page.locator('.password-recovery-done a').click(); await expect(page).toHaveURL(/\/login$/); await context.close();
  });
  await scenario('Invalid and rate limited codes stay private and do not retry the mutation', async () => {
    const { context, page, state } = await fixture(); await page.goto(baseURL + '/forgot-password'); await sent(page); await choose(page);
    state.completeFailure = { code: 'PASSWORD_RECOVERY_INVALID' }; await form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('incorrect ou a expiré'); await expect(page.locator('[name="newPassword"]')).toHaveValue(''); await expect(page.locator('[name="recoveryCode"]')).toHaveValue('');
    assert.equal((await page.locator('body').innerText()).includes('Private provider detail'), false);
    state.completeFailure = { status: 429, code: 'PASSWORD_RECOVERY_RATE_LIMITED', retryAfter: 90 }; await choose(page); await form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('Trop de tentatives'); await expect(form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true })).toBeDisabled(); assert.equal(state.completions.length, 2); await noSecrets(page); await context.close();
  });
  await scenario('Unconfirmed outcomes offer sign in and prevent blind password retries', async () => {
    const { context, page, state } = await fixture(); await page.goto(baseURL + '/forgot-password'); await sent(page); await choose(page);
    state.completeResult = { success: false }; await form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click();
    await expect(form(page).getByRole('link', { name: 'Essayer de me connecter' })).toBeVisible(); await expect(page.locator('[name="newPassword"]')).toBeDisabled(); assert.equal(state.completions.length, 1); await context.close();
  });
  await scenario('A dropped password mutation response never permits a blind retry', async () => {
    const { context, page, state } = await fixture(); await page.goto(baseURL + '/forgot-password'); await sent(page); await choose(page);
    state.completeAbort = true; await form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click();
    await expect(form(page).getByRole('link', { name: 'Essayer de me connecter' })).toBeVisible(); await expect(page.locator('[name="newPassword"]')).toBeDisabled(); await expect(page.locator('[name="newPassword"]')).toHaveValue(''); assert.equal(state.completions.length, 1); await context.close();
  });
  await scenario('Resending a code clears the previously entered code and password fields', async () => {
    const { context, page, state } = await fixture(); await page.clock.install(); await page.goto(baseURL + '/forgot-password'); await sent(page); await choose(page);
    await page.clock.fastForward(61000); await form(page).getByRole('button', { name: 'Renvoyer le code', exact: true }).click();
    await expect(page.locator('[name="newPassword"]')).toHaveValue(''); await expect(page.locator('[name="confirmation"]')).toHaveValue(''); await expect(page.locator('[name="recoveryCode"]')).toHaveValue(''); assert.equal(state.starts.length, 2); await context.close();
  });
  await scenario('Profile sends only to the locked account email and requires no current password', async () => {
    const { context, page, state } = await fixture({ profile: true, width: 1280 }); await page.goto(baseURL + '/app/profile');
    await expect(page.locator('[name="recoveryEmail"]')).toHaveValue(email); await expect(page.locator('[name="recoveryEmail"]')).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Mot de passe actuel', { exact: true })).toHaveCount(0);
    await form(page).getByRole('button', { name: 'Recevoir le code', exact: true }).click(); await expect(page.locator('[name="recoveryCode"]')).toBeVisible(); assert.deepEqual(state.starts, [{ email }]); await context.close();
  });
  await scenario('Uncertain restricted accounts can recover by locked academic email instead of being trapped', async () => {
    const { context, page, state } = await fixture({ profile: true, resetState: 'unknown' }); await page.goto(baseURL + '/login');
    await expect(page).toHaveURL(/\/change-password$/); await expect(page.locator('[name="recoveryEmail"]')).toHaveValue(email); await expect(page.locator('[name="recoveryEmail"]')).toHaveAttribute('readonly', '');
    await expect(page.locator('.password-change-card')).toContainText('Essayez de vous reconnecter');
    await form(page).getByRole('button', { name: 'Recevoir le code', exact: true }).click(); await expect(page.locator('[name="recoveryCode"]')).toBeVisible(); assert.deepEqual(state.starts, [{ email }]); await context.close();
  });
  await scenario('Confirmed bound-account resets reload login with durable feedback even when session expiry unmounts the form', async () => {
    const { context, page, state } = await fixture({ profile: true }); await page.goto(baseURL + '/app/profile');
    await form(page).getByRole('button', { name: 'Recevoir le code', exact: true }).click(); await expect(page.locator('[name="recoveryCode"]')).toBeVisible(); await choose(page);
    state.delay = 350; await form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click(); await expect.poll(() => state.completions.length).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('campus-session-expired'))); await expect(page).toHaveURL(/\/login\?password_reset=success$/);
    await expect(page.getByRole('status').filter({ hasText: 'Mot de passe mis à jour.' })).toBeVisible(); await page.reload(); await expect(page.getByRole('status').filter({ hasText: 'Mot de passe mis à jour.' })).toBeVisible(); await context.close();
  });
  await scenario('Bound-account ambiguous outcomes reload login with recovery guidance; invalid codes stay on profile', async () => {
    const { context, page, state } = await fixture({ profile: true }); await page.goto(baseURL + '/app/profile');
    await form(page).getByRole('button', { name: 'Recevoir le code', exact: true }).click(); await expect(page.locator('[name="recoveryCode"]')).toBeVisible(); await choose(page);
    state.completeFailure = { code: 'PASSWORD_RECOVERY_INVALID' }; await form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click(); await expect(form(page).getByRole('alert')).toContainText('incorrect ou a expiré'); await expect(page).toHaveURL(/\/app\/profile$/);
    await choose(page); state.completeFailure = { status: 503, code: 'PASSWORD_RECOVERY_UNKNOWN' }; await form(page).getByRole('button', { name: 'Enregistrer mon mot de passe', exact: true }).click(); await expect(page).toHaveURL(/\/login\?password_reset=unknown$/);
    await expect(page.getByRole('status').filter({ hasText: 'Essayez votre nouveau mot de passe ou demandez un nouveau code.' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Mot de passe oublié ?', exact: true })).toBeVisible(); await context.close();
  });
  await scenario('Existing personal-email accounts retain current-password change with eight digits', async () => {
    const { context, page, state } = await fixture({ profile: true, accountEmail: 'legacy@example.test' }); await page.goto(baseURL + '/app/profile');
    await expect(page.locator('[name="recoveryEmail"]')).toHaveCount(0); await page.getByLabel('Mot de passe actuel', { exact: true }).fill('Existing-fixture-password');
    await page.getByLabel('Nouveau mot de passe', { exact: true }).fill(password); await page.getByLabel('Confirmer le nouveau mot de passe', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Modifier le mot de passe', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: 'Mot de passe modifié.' })).toBeVisible();
    assert.deepEqual(state.profiles, [{ current_password: 'Existing-fixture-password', password }]); assert.equal(state.starts.length, 0); await context.close();
  });
  await scenario('Recovery remains usable at 320, 768, 1280px in French, English, Arabic, light and dark', async () => {
    for (const width of [320, 768, 1280]) for (const language of ['fr', 'en', 'ar']) for (const theme of ['dark', 'light']) {
      const { context, page } = await fixture({ width, language, theme }); await page.goto(baseURL + '/forgot-password');
      await expect(page.locator('.password-recovery-form')).toBeVisible(); await page.locator('[name="recoveryEmail"]').fill(email); await form(page).locator('button[type="submit"]').click(); await expect(page.locator('[name="recoveryCode"]')).toBeVisible();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${width}/${language}/${theme} overflow`);
      await expect(form(page).locator('button[type="submit"]')).toBeEnabled();
      await page.screenshot({ path: `test-results/password-recovery/${width}-${language}-${theme}.png`, fullPage: true }); await context.close();
    }
  });
  assert.deepEqual(errors, []); console.log(`PASS ${passed.length} password recovery UI scenarios`);
} finally { await browser.close(); }
