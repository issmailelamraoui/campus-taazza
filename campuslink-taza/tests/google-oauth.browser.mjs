import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chooseOption } from './ui.helpers.mjs';

// Every API and Google navigation stays inside this fixture. No provider session,
// real student account, password or production database is touched by this suite.
const baseURL = process.env.CAMPUS_GOOGLE_UI_URL || process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [], passed = [];
const password = 'Fixture-current-password-2026!';
const authorizationEndpoint = 'https://oauth-fixture.example.neon.tech/neondb/auth/sign-in/social/init';
const initToken = 'opaque-provider-init-token-2026';
const faculties = [{ id: 'fsa', name: 'Faculté des Sciences Appliquées', filieres: [{ id: 'mathematics', name: 'Mathématiques et applications' }] }];
const identity = { email: 'sara@usmba.ac.ma', name: 'Sara Étudiante' };
const student = (overrides = {}) => ({ id: 2, username: 'sara.student', name: 'Sara Étudiante', email: identity.email, role: 'student', faculty_id: 'fsa', filiere_id: 'mathematics', current_semester: 1, account_status: 'approved', preferences: {}, ...overrides });
const labels = {
  fr: { google: 'Continuer avec Google', submit: 'Envoyer ma demande' },
  en: { google: 'Continue with Google', submit: 'Submit my application' },
  ar: { google: 'المتابعة باستخدام Google', submit: 'إرسال طلبي' },
};
await mkdir('test-results/google-oauth', { recursive: true });

async function fixture({ width = 1280, theme = 'dark', language = 'fr', user = null, enabled = true, linked = false, initEndpoint } = {}) {
  const state = { user, enabled, linked, authorizationEndpoint: initEndpoint, calls: [], starts: [], submissions: [], logins: [], verificationSends: [], verificationConfirms: [], googleNavigations: [], initNavigations: [], rejectedNavigations: [], startDelay: 0, profileDelay: 0, verificationDelay: 0, verificationSendFailure: null, verificationConfirmFailure: null, startFailure: null, profileFailure: null, optionsFailure: false, configFailure: false, expiredProfile: false, expiredLink: false, destination: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=browser-bound-test' };
  const context = await browser.newContext({ viewport: { width, height: width === 320 ? 700 : 900 }, hasTouch: width < 900, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(({ theme, language }) => {
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    window.__googleStreams = 0;
    window.EventSource = class { constructor() { window.__googleStreams++; } addEventListener() {} close() {} };
  }, { theme, language });
  await context.route('https://accounts.google.com/**', async route => {
    state.googleNavigations.push(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Google fixture</title><p>Google sign-in fixture</p>' });
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!request.isNavigationRequest() || url.origin === new URL(baseURL).origin || url.origin === 'https://accounts.google.com') return route.fallback();
    if (url.origin === new URL(authorizationEndpoint).origin && url.pathname === new URL(authorizationEndpoint).pathname) {
      state.initNavigations.push(request.url());
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Managed OAuth fixture</title><p>Managed OAuth init fixture</p>' });
    }
    state.rejectedNavigations.push(request.url());
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Rejected destination fixture</title>' });
  });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/api/, ''), method = request.method();
    const send = (json, status = 200) => route.fulfill({ status, json }).catch(() => {});
    state.calls.push({ method, path });
    if (path === '/session') return send({ user: state.user });
    if (path === '/auth/google/config') return state.configFailure ? send({ error: 'Unavailable' }, 503) : send({ enabled: state.enabled, domains: state.enabled ? ['usmba.ac.ma'] : [], ...(state.enabled && state.authorizationEndpoint ? { authorizationEndpoint: state.authorizationEndpoint } : {}) });
    if (path === '/registration-options') return state.optionsFailure ? send({ error: 'Facultés temporairement indisponibles.' }, 503) : send({ faculties });
    if (path === '/auth/google/profile' && method === 'GET') return state.expiredProfile ? send({ error: 'Expired', code: 'GOOGLE_SESSION_INVALID' }, 401) : send({ profile: identity });
    if (path === '/auth/google/profile' && method === 'POST') {
      state.submissions.push(request.postDataJSON());
      if (state.profileDelay) await new Promise(resolve => setTimeout(resolve, state.profileDelay));
      if (state.profileFailure) return send({ error: 'Invalid profile', code: state.profileFailure }, 400);
      state.user = student({ ...request.postDataJSON(), email: identity.email, account_status: 'pending' }); state.linked = true;
      return send({ user: state.user, authenticated: true }, 201);
    }
    if (path === '/auth/google/email-verification/start' && method === 'POST') {
      state.verificationSends.push(request.postDataJSON());
      if (state.verificationDelay) await new Promise(resolve => setTimeout(resolve, state.verificationDelay));
      if (state.verificationSendFailure) return send({ error: 'Private provider detail must stay hidden', ...state.verificationSendFailure }, state.verificationSendFailure.status || 503);
      return send({ success: true });
    }
    if (path === '/auth/google/email-verification/confirm' && method === 'POST') {
      state.verificationConfirms.push(request.postDataJSON());
      if (state.verificationDelay) await new Promise(resolve => setTimeout(resolve, state.verificationDelay));
      if (state.verificationConfirmFailure) return send({ error: 'Private provider detail must stay hidden', ...state.verificationConfirmFailure }, state.verificationConfirmFailure.status || 400);
      return send({ verified: true });
    }
    if (path === '/auth/google/start' && method === 'POST') {
      state.starts.push(request.postDataJSON());
      if (state.startDelay) await new Promise(resolve => setTimeout(resolve, state.startDelay));
      if (state.expiredLink) { state.user = null; return send({ error: 'Expired', code: 'GOOGLE_SESSION_INVALID' }, 401); }
      if (state.startFailure) return send({ error: 'Google denied', code: state.startFailure }, 403);
      return send({ url: state.destination });
    }
    if (path === '/auth/google/callback' && method === 'GET' && state.googleCallbackUser) {
      // Model only the browser result of an already validated server callback.
      // Provider identity/admission checks are covered by the backend suites.
      state.user = state.googleCallbackUser; state.googleCallbackUser = null;
      return route.fulfill({ status: 303, headers: { location: baseURL + '/app' }, body: '' });
    }
    if (path === '/auth/google/link') return send(state.linked ? { linked: true, email: identity.email } : { linked: false });
    if (path === '/login' && method === 'POST') {
      state.logins.push(request.postDataJSON());
      state.user = student({ email: 'legacy@example.test' }); return send({ user: state.user });
    }
    if (path === '/logout' && method === 'POST') { state.user = null; return send({ ok: true }); }
    if (path === '/bootstrap' || path === '/live') {
      if (!state.user) return send({ error: 'Expired' }, 401);
      if (state.user.account_status !== 'approved') return send({ error: 'Pending', code: 'ACCOUNT_PENDING' }, 403);
      return send({ user: state.user, faculty: { id: 'fsa', code: 'FSA', name: faculties[0].name }, resources: [], announcements: [], messages: [], notifications: [], channels: [], members: [state.user], saved: [], history: [], unread_count: 0 });
    }
    if (path === '/members/2/achievements') return send({ achievements: [] });
    if (path === '/chat/blocks') return send({ blocks: [] });
    errors.push(`Unexpected API request: ${method} ${path}`);
    return send({ error: 'Unexpected fixture request' }, 500);
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, state };
}
const google = page => page.locator('.google-auth-button');
const completion = page => page.locator('.google-profile-card');
const linkCard = page => page.locator('.google-link-card');
const verification = page => page.locator('.google-email-verification');
const verificationEmail = page => verification(page).locator('[name="google-verification-email"]');
const verificationCode = page => verification(page).locator('[name="google-verification-code"]');
async function noSecrets(page) {
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: window.history.state }));
  for (const secret of [password, initToken, 'neon_auth_session_verifier', 'access_token', 'id_token', 'client_secret', 'code_verifier']) assert.equal(stored.includes(secret), false, `No ${secret} in browser storage`);
}
async function noVerificationSecrets(page) {
  await noSecrets(page);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: window.history.state }));
  for (const secret of [identity.email, '123456', '654321']) assert.equal(stored.includes(secret), false, 'Verification email and code stay out of browser persistence');
}
async function fits(page, controls) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'Page fits the viewport');
  for (const box of await controls.evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, height: rect.height }; }))) {
    assert.ok(box.left >= -1 && box.right <= page.viewportSize().width + 1, 'Control fits the viewport');
    assert.ok(box.height >= 44, 'Controls offer a 44px touch target');
  }
}
async function enterProfile(page) {
  await page.locator('#google-profile-name').fill('Sara Étudiante');
  await page.locator('#google-profile-username').fill('sara.new');
  await chooseOption(page.locator('#google-profile-faculty'), 'fsa');
  await chooseOption(page.locator('#google-profile-filiere'), 'mathematics');
  await chooseOption(page.locator('#google-profile-semester'), '3');
}
async function scenario(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }

try {
  await scenario('Login, registration and completion fit phones, tablets and PCs in light/dark and FR/EN/AR', async () => {
    for (const width of [320, 768, 1280]) for (const theme of ['light', 'dark']) for (const language of ['fr', 'en', 'ar']) {
      const { context, page, state } = await fixture({ width, theme, language });
      for (const path of ['/login', '/register']) {
        await page.goto(baseURL + path);
        await expect(google(page)).toHaveText(labels[language].google);
        await expect(page.locator('.google-auth-note')).toContainText('@usmba.ac.ma');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
        await fits(page, google(page));
        await expect(page.locator(path === '/login' ? '#login-password' : '#register-password')).toBeEnabled();
        const submitBox = await page.locator('.login-form button[type="submit"]').boundingBox(), googleBox = await google(page).boundingBox();
        assert.ok(googleBox.y >= submitBox.y + submitBox.height, 'Google is grouped below the main form action');
        if (theme === 'dark' && language === 'ar') await page.screenshot({ path: `test-results/google-oauth/${path.slice(1)}-options-${width}-dark-ar.png`, fullPage: true });
      }
      await page.goto(baseURL + '/login?google_error=GOOGLE_LINK_REQUIRED');
      await expect(page.locator('.google-auth-status')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page).toHaveURL(baseURL + '/login');
      await expect(google(page)).toBeVisible();
      await expect(google(page)).toBeEnabled();
      await expect(page.locator('#login-username, #login-password')).toHaveCount(0);
      await fits(page, page.locator('.google-auth-button, .google-password-option, .google-email-verification input, .google-email-verification button'));
      const recoveryGoogleBox = await google(page).boundingBox();
      assert.ok(recoveryGoogleBox.y + recoveryGoogleBox.height <= page.viewportSize().height, 'Google retry is visible in the initial viewport');
      if (theme === 'dark' && language === 'ar') await page.screenshot({ path: `test-results/google-oauth/link-required-${width}-dark-ar.png`, fullPage: true });
      await page.goto(baseURL + '/auth/google/complete');
      await expect(page.locator('#google-profile-email')).toHaveValue(identity.email);
      await expect(page.locator('#google-profile-email')).toHaveAttribute('readonly', '');
      await expect(page.locator('#google-profile-name')).toHaveValue(identity.name);
      await fits(page, completion(page).locator('input, button[role="combobox"], button[type="submit"]'));
      assert.equal(state.calls.some(call => ['/bootstrap', '/live'].includes(call.path)), false);
      assert.equal(await page.evaluate(() => window.__googleStreams), 0);
      if (theme === 'dark' && language === 'ar') await page.screenshot({ path: `test-results/google-oauth/completion-${width}-dark-ar.png`, fullPage: true });
      await noSecrets(page); await context.close();
    }
  });

  await scenario('Disabled or unavailable Google configuration keeps password registration and login usable', async () => {
    for (const failed of [false, true]) {
      const { context, page, state } = await fixture({ enabled: false }); state.configFailure = failed;
      await page.goto(baseURL + '/register'); await expect(page.locator('#register-password')).toBeEnabled();
      await expect.poll(() => state.calls.filter(call => call.path === '/auth/google/config').length).toBe(1);
      await expect(google(page)).toHaveCount(0);
      await page.goto(baseURL + '/login'); await expect(page.locator('#login-password')).toBeEnabled(); await expect(google(page)).toHaveCount(0);
      await page.locator('#login-username').fill('legacy.student'); await page.locator('#login-password').fill(password);
      await page.locator('.login-form button[type="submit"]').click(); await expect(page).toHaveURL(/\/app$/);
      assert.deepEqual(state.logins, [{ username: 'legacy.student', password }]);
      assert.equal(state.starts.length, 0); await noSecrets(page); await context.close();
    }
  });

  await scenario('The new sign-in layout remains clear at common phone and desktop widths', async () => {
    for (const [width, theme, language, googleFailure] of [[390, 'dark', 'fr', false], [390, 'dark', 'ar', true], [1280, 'light', 'fr', true]]) {
      const { context, page } = await fixture({ width, theme, language });
      await page.goto(baseURL + '/login' + (googleFailure ? '?google_error=GOOGLE_LINK_REQUIRED' : ''));
      await expect(googleFailure ? page.locator('.google-auth-status') : google(page)).toBeVisible();
      await fits(page, page.locator('.login-form input, .login-form .login-submit, .google-auth-button, .google-password-option'));
      if (googleFailure) await expect(page.locator('#login-username, #login-password')).toHaveCount(0);
      await page.screenshot({ path: `test-results/google-oauth/${googleFailure ? 'link-required' : 'login-normal'}-${width}-${theme}-${language}.png`, fullPage: true });
      await context.close();
    }
  });

  await scenario('Google startup shows progress, prevents simultaneous/double login, and permits retry after refusal', async () => {
    const { context, page, state } = await fixture(); state.startDelay = 250; state.startFailure = 'GOOGLE_DISABLED';
    await page.goto(baseURL + '/login'); await expect(google(page)).toBeVisible();
    await google(page).evaluate(button => { button.click(); button.click(); });
    await expect(google(page)).toBeDisabled(); await expect(google(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#login-password')).toBeDisabled();
    await page.locator('.login-form').evaluate(form => form.requestSubmit());
    await expect(page.getByRole('alert')).toContainText('momentanément indisponible');
    assert.deepEqual(state.starts, [{ intent: 'login' }]); assert.equal(state.logins.length, 0);
    await expect(page.locator('#login-password')).toBeEnabled();
    state.startFailure = null;
    await google(page).click(); await expect(page).toHaveURL(/^https:\/\/accounts\.google\.com\//);
    assert.equal(state.googleNavigations.length, 1); assert.equal(state.starts.length, 2); await context.close();
  });

  await scenario('A Google callback failure keeps Google upfront without password fields or private data', async () => {
    for (const managed of [false, true]) {
      const { context, page, state } = await fixture({ initEndpoint: managed ? authorizationEndpoint : undefined });
      if (managed) state.destination = `${authorizationEndpoint}?token=${initToken}`;
      await page.goto(`${baseURL}/login?foo=kept&google_error=GOOGLE_LINK_REQUIRED`);
      await expect(page.locator('.google-auth-status')).toContainText('pas encore pu être associé');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('Ce compte existe déjà');
      await expect(page.locator('body')).not.toContainText('Confirmer et continuer avec Google');
      await expect(page).toHaveURL(baseURL + '/login?foo=kept');
      await expect(page.locator('#login-username, #login-password, .login-form')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Connexion par mot de passe', exact: true })).toBeEnabled();
      await expect(google(page)).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Contacter l’administration', exact: true }).first()).toBeVisible();
      assert.equal(state.logins.length, 0); assert.equal(state.starts.length, 0);
      assert.equal(state.calls.some(call => ['/bootstrap', '/live'].includes(call.path)), false);
      state.startFailure = 'GOOGLE_DISABLED'; await google(page).click();
      await expect(page.getByRole('alert')).toContainText('momentanément indisponible');
      await expect(google(page)).toBeVisible(); await expect(google(page)).toBeEnabled();
      state.startFailure = null; await google(page).click();
      await expect(page).toHaveURL(state.destination);
      assert.deepEqual(state.starts, [{ intent: 'login' }, { intent: 'login' }]);
      assert.equal(state.logins.length, 0);
      assert.equal(state.calls.some(call => ['/logout', '/bootstrap', '/live'].includes(call.path)), false);
      assert.equal(state.rejectedNavigations.length, 0);
      assert.equal(managed ? state.initNavigations.length : state.googleNavigations.length, 1);
      await noSecrets(page); await context.close();
    }
  });

  await scenario('Password sign-in appears only after an explicit choice from the Google failure view', async () => {
    const { context, page, state } = await fixture();
    await page.goto(baseURL + '/login?google_error=GOOGLE_LINK_REQUIRED');
    await expect(page.locator('.google-auth-status')).toBeVisible(); await expect(google(page)).toBeEnabled();
    assert.equal(state.logins.length, 0); assert.equal(state.calls.some(call => call.path === '/bootstrap'), false);
    await expect(page.locator('#login-username, #login-password')).toHaveCount(0);
    await page.getByRole('button', { name: 'Connexion par mot de passe', exact: true }).click();
    await expect(page.locator('.google-login-recovery')).toHaveCount(0);
    await expect(page.locator('#login-password')).toBeVisible();
    assert.equal(state.logins.length, 0); assert.equal(state.starts.length, 0);
    await page.locator('#login-username').fill('legacy.student'); await page.locator('#login-password').fill(password);
    await page.locator('.login-submit').click(); await expect(page).toHaveURL(/\/app$/);
    assert.deepEqual(state.logins, [{ username: 'legacy.student', password }]);
    assert.equal(state.starts.length, 0); await noSecrets(page); await context.close();
  });

  await scenario('Email recovery stays optional, sends only on explicit actions and keeps its draft out of browser persistence', async () => {
    const { context, page, state } = await fixture({ width: 320 });
    await page.goto(baseURL + '/login?google_error=GOOGLE_LINK_REQUIRED');
    await expect(verification(page)).toBeVisible(); await expect(google(page)).toBeEnabled();
    await expect(verificationEmail(page)).toHaveValue(''); await expect(verificationCode(page)).toHaveCount(0);
    assert.deepEqual(state.verificationSends, []); assert.deepEqual(state.verificationConfirms, []);
    await verificationEmail(page).fill('personal@gmail.com');
    await verification(page).locator('button[type="submit"]').click();
    await expect(verification(page).getByRole('alert')).toContainText('Utilisez une adresse académique autorisée');
    assert.deepEqual(state.verificationSends, []);
    await verificationEmail(page).fill('SARA@USMBA.AC.MA'); state.verificationDelay = 250;
    await verification(page).locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await expect(google(page)).toBeDisabled(); await expect(page.locator('.google-password-option')).toBeDisabled();
    await expect(verificationEmail(page)).toBeDisabled();
    await expect(verificationCode(page)).toBeVisible(); await expect(verificationEmail(page)).toHaveValue(identity.email);
    await expect(verificationEmail(page)).toHaveAttribute('readonly', '');
    assert.deepEqual(state.verificationSends, [{ email: identity.email }]);
    await expect(google(page)).toBeEnabled(); await fits(page, verification(page).locator('input, button'));
    await verificationCode(page).fill('654321'); await noVerificationSecrets(page);
    await verification(page).getByRole('button', { name: 'Renvoyer un code', exact: true }).click();
    await expect(verificationCode(page)).toHaveValue(''); await expect(verificationCode(page)).toBeEnabled();
    assert.deepEqual(state.verificationSends, [{ email: identity.email }, { email: identity.email }]);
    await page.reload(); await expect(verificationEmail(page)).toHaveValue(''); await expect(verificationCode(page)).toHaveCount(0);
    assert.equal(state.verificationSends.length, 2); assert.equal(state.verificationConfirms.length, 0); assert.equal(state.starts.length, 0);
    await expect(page.locator('#login-username, #login-password')).toHaveCount(0); await noVerificationSecrets(page);
    await page.goto(baseURL + '/login?google_error=GOOGLE_DOMAIN_REJECTED'); await expect(verification(page)).toHaveCount(0);
    assert.equal(state.calls.some(call => ['/login', '/logout', '/bootstrap', '/live', '/auth/google/link'].includes(call.path)), false);
    await context.close();
  });

  await scenario('Email confirmation clears the code, locks duplicate submissions and starts a fresh Google flow without password or campus access', async () => {
    for (const managed of [false, true]) {
      const { context, page, state } = await fixture({ width: managed ? 768 : 390, initEndpoint: managed ? authorizationEndpoint : undefined });
      if (managed) state.destination = `${authorizationEndpoint}?token=${initToken}`;
      await page.goto(baseURL + '/login?google_error=GOOGLE_LINK_REQUIRED');
      await verificationEmail(page).fill(identity.email); await verification(page).locator('button[type="submit"]').click();
      await expect(verificationCode(page)).toBeVisible(); await verificationCode(page).fill('123456'); state.verificationDelay = 250;
      await verification(page).locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
      await expect(verificationCode(page)).toHaveValue(''); await expect(google(page)).toBeDisabled();
      await expect(page.locator('.google-password-option')).toBeDisabled();
      await expect(page).toHaveURL(state.destination);
      assert.deepEqual(state.verificationConfirms, [{ email: identity.email, code: '123456' }]);
      assert.deepEqual(state.starts, [{ intent: 'login' }]); assert.deepEqual(state.logins, []); assert.equal(state.user, null);
      assert.deepEqual(state.calls.filter(call => call.method === 'POST').map(call => call.path), ['/auth/google/email-verification/start', '/auth/google/email-verification/confirm', '/auth/google/start']);
      assert.equal(state.calls.some(call => ['/bootstrap', '/live', '/auth/google/link', '/logout'].includes(call.path)), false);
      assert.equal(state.rejectedNavigations.length, 0); assert.equal(managed ? state.initNavigations.length : state.googleNavigations.length, 1);
      await noVerificationSecrets(page);
      state.user = student({ account_status: 'pending' });
      await page.goto(baseURL + '/account-review'); await expect(page.locator('.onboarding-heading h1')).toContainText('en attente');
      assert.equal(state.calls.some(call => ['/bootstrap', '/live'].includes(call.path)), false);
      await context.close();
    }
  });

  await scenario('Unavailable verification, invalid codes and provider cooldowns remain recoverable without leaking provider details', async () => {
    const { context, page, state } = await fixture();
    await page.goto(baseURL + '/login?google_error=GOOGLE_LINK_REQUIRED');
    await verificationEmail(page).fill(identity.email);
    state.verificationSendFailure = { code: 'GOOGLE_VERIFICATION_UNAVAILABLE', status: 503 };
    await verification(page).locator('button[type="submit"]').click();
    await expect(verification(page).getByRole('alert')).toContainText('momentanément indisponible');
    await expect(verificationEmail(page)).toHaveValue(identity.email); await expect(google(page)).toBeEnabled();
    state.verificationSendFailure = null; await verification(page).locator('button[type="submit"]').click();
    await expect(verificationCode(page)).toBeVisible(); await verificationCode(page).fill('123456');
    state.verificationConfirmFailure = { code: 'GOOGLE_VERIFICATION_INVALID', status: 400 };
    await verification(page).locator('button[type="submit"]').click();
    await expect(verification(page).getByRole('alert')).toContainText('Vérifiez votre adresse universitaire');
    await expect(verificationCode(page)).toHaveValue(''); await expect(verificationEmail(page)).toHaveValue(identity.email);
    assert.equal(state.starts.length, 0);
    state.verificationConfirmFailure = { code: 'GOOGLE_VERIFICATION_RATE_LIMITED', status: 429, retryAfter: 1 };
    await verificationCode(page).fill('123456'); await verification(page).locator('button[type="submit"]').click();
    await expect(verification(page).getByRole('alert')).toContainText('Trop de tentatives');
    await expect(verificationCode(page)).toHaveValue(''); await verificationCode(page).fill('123456');
    await expect(verification(page).locator('button[type="submit"]')).toBeDisabled();
    await expect(verification(page).getByRole('button', { name: 'Renvoyer un code', exact: true })).toBeDisabled();
    await expect(google(page)).toBeEnabled(); await expect(page.locator('body')).not.toContainText('Private provider detail');
    state.verificationConfirmFailure = null;
    await expect(verification(page).locator('button[type="submit"]')).toBeEnabled({ timeout: 5000 });
    await verification(page).getByRole('button', { name: 'Modifier l’adresse', exact: true }).click();
    await expect(verificationCode(page)).toHaveCount(0); await expect(verificationEmail(page)).toBeEditable();
    assert.equal(state.verificationConfirms.length, 2); assert.equal(state.starts.length, 0); assert.equal(state.logins.length, 0);
    assert.equal(state.calls.some(call => ['/bootstrap', '/live'].includes(call.path)), false);
    await noVerificationSecrets(page); await context.close();
  });

  await scenario('Confirming email alone never opens campus and a failed or unsafe Google restart keeps the visible Google retry usable', async () => {
    for (const failure of ['provider', 'destination']) {
      const { context, page, state } = await fixture();
      await page.goto(baseURL + '/login?google_error=GOOGLE_LINK_REQUIRED');
      await verificationEmail(page).fill(identity.email); await verification(page).locator('button[type="submit"]').click();
      await expect(verificationCode(page)).toBeVisible(); await verificationCode(page).fill('123456');
      if (failure === 'provider') state.startFailure = 'GOOGLE_DISABLED'; else state.destination = 'https://attacker.example/oauth';
      await verification(page).locator('button[type="submit"]').click();
      await expect(verification(page).getByRole('status')).toContainText('Adresse confirmée');
      await expect(verification(page).getByRole('alert')).toContainText(failure === 'provider' ? 'momentanément indisponible' : 'n’a pas abouti');
      await expect(page).toHaveURL(baseURL + '/login'); await expect(google(page)).toBeVisible(); await expect(google(page)).toBeEnabled();
      await expect(verificationEmail(page)).toHaveCount(0); await expect(verificationCode(page)).toHaveCount(0);
      await expect(page.locator('#login-username, #login-password')).toHaveCount(0);
      assert.equal(state.user, null); assert.equal(state.googleNavigations.length, 0); assert.equal(state.rejectedNavigations.length, 0);
      assert.equal(state.calls.some(call => ['/login', '/bootstrap', '/live', '/auth/google/link'].includes(call.path)), false);
      await noVerificationSecrets(page);
      state.startFailure = null; state.destination = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=browser-bound-test';
      await google(page).click(); await expect(page).toHaveURL(state.destination);
      assert.equal(state.verificationSends.length, 1); assert.equal(state.verificationConfirms.length, 1);
      assert.deepEqual(state.starts, [{ intent: 'login' }, { intent: 'login' }]); await context.close();
    }
  });

  await scenario('Google failure survives query consumption, reload and back while fresh normal login and classic return clear it', async () => {
    const { context, page, state } = await fixture({ width: 390 });
    await page.goto(baseURL + '/login?foo=kept&google_error=GOOGLE_LINK_REQUIRED');
    await expect(page).toHaveURL(baseURL + '/login?foo=kept');
    await expect(page.locator('#login-username, #login-password')).toHaveCount(0); await expect(google(page)).toBeEnabled();
    assert.equal(await page.evaluate(() => window.history.state?.usr?.campusGoogleError), 'GOOGLE_LINK_REQUIRED');
    await page.reload();
    await expect(page.locator('.google-login-recovery')).toBeVisible();
    await expect(page.locator('#login-username, #login-password')).toHaveCount(0); await expect(google(page)).toBeEnabled();
    await page.locator('.public-header-login').click();
    await expect(page).toHaveURL(baseURL + '/login'); await expect(page.locator('#login-password')).toBeVisible();
    await expect(page.locator('.google-login-recovery')).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(baseURL + '/login?foo=kept');
    await expect(page.locator('.google-login-recovery')).toBeVisible(); await expect(page.locator('#login-password')).toHaveCount(0);
    await page.getByRole('button', { name: 'Connexion par mot de passe', exact: true }).click();
    await expect(page.locator('#login-password')).toBeVisible();
    assert.equal(await page.evaluate(() => window.history.state?.usr?.campusGoogleError), undefined);
    await page.reload(); await expect(page.locator('#login-password')).toBeVisible();
    await expect(page.locator('.google-login-recovery')).toHaveCount(0);
    assert.equal(state.logins.length, 0); assert.equal(state.starts.length, 0);
    assert.equal(state.calls.some(call => ['/logout', '/bootstrap', '/live'].includes(call.path)), false);
    await page.goto(baseURL + '/login?google_error=' + encodeURIComponent(password));
    await expect(page).toHaveURL(baseURL + '/login');
    assert.equal(await page.evaluate(() => window.history.state?.usr?.campusGoogleError), 'GOOGLE_OAUTH_FAILED');
    await expect(page.locator('#login-password')).toHaveCount(0);
    await noSecrets(page); await context.close();
  });

  await scenario('Frontend rejects a server response pointing away from the Google account host', async () => {
    const { context, page, state } = await fixture(); state.destination = 'https://attacker.example/oauth';
    await page.goto(baseURL + '/login'); await google(page).click();
    await expect(page.getByRole('alert')).toContainText('n’a pas abouti');
    await expect(page).toHaveURL(/\/login$/); await expect(google(page)).toBeEnabled();
    assert.equal(state.googleNavigations.length, 0); await context.close();
  });

  await scenario('Login and password-confirmed linking accept the exact configured managed OAuth init hop', async () => {
    for (const intent of ['login', 'link']) {
      const { context, page, state } = await fixture({ initEndpoint: authorizationEndpoint, user: intent === 'link' ? student() : null });
      state.destination = `${authorizationEndpoint}?token=${initToken}`;
      await page.goto(baseURL + (intent === 'link' ? '/app/profile' : '/login'));
      if (intent === 'link') {
        await linkCard(page).getByRole('button', { name: 'Associer Google', exact: true }).click();
        await linkCard(page).getByLabel('Mot de passe actuel', { exact: true }).fill(password);
        await linkCard(page).locator('button[type="submit"]').click();
      } else await google(page).click();
      await expect(page).toHaveURL(state.destination);
      assert.deepEqual(state.starts, [intent === 'link' ? { intent, password } : { intent }]);
      assert.deepEqual(state.initNavigations, [state.destination]);
      assert.equal(state.googleNavigations.length, 0); assert.equal(state.rejectedNavigations.length, 0);
      await page.goto(baseURL + (intent === 'link' ? '/app/profile' : '/login'));
      await expect(intent === 'link' ? linkCard(page) : google(page)).toBeVisible();
      await noSecrets(page); await context.close();
    }
  });

  await scenario('Managed OAuth init navigation rejects wrong origins, paths, token shapes and unsafe configuration', async () => {
    const valid = `${authorizationEndpoint}?token=${initToken}`;
    const cases = [
      ['unconfigured provider', valid, null],
      ['other origin', valid.replace('oauth-fixture.example.neon.tech', 'attacker.example')],
      ['lookalike origin', valid.replace('oauth-fixture.example.neon.tech', 'oauth-fixture.example.neon.tech.attacker.example')],
      ['other path', valid.replace('/sign-in/social/init', '/sign-in/social/other')],
      ['path suffix', valid.replace('/social/init?', '/social/init/extra?')],
      ['insecure protocol', valid.replace('https:', 'http:')],
      ['credentials', valid.replace('https://', 'https://student:password@')],
      ['alternate port', valid.replace('.tech/', '.tech:444/')],
      ['fragment', `${valid}#unexpected`],
      ['missing token', authorizationEndpoint],
      ['empty token', `${authorizationEndpoint}?token=`],
      ['whitespace token', `${authorizationEndpoint}?token=%20`],
      ['oversized token', `${authorizationEndpoint}?token=${'a'.repeat(4097)}`],
      ['unsafe token characters', `${authorizationEndpoint}?token=opaque%2Ftoken`],
      ['control characters', `${authorizationEndpoint}?token=opaque%00token`],
      ['duplicate token', `${valid}&token=another-token`],
      ['extra parameter', `${valid}&redirect_uri=https%3A%2F%2Fattacker.example`],
      ['wrong parameter name', valid.replace('?token=', '?Token=')],
      ['configured query', valid, `${authorizationEndpoint}?token=not-public`],
      ['configured fragment', valid, `${authorizationEndpoint}#unexpected`],
      ['configured credentials', valid, authorizationEndpoint.replace('https://', 'https://student@')],
      ['malformed configuration', valid, 'invalid-endpoint'],
      ['Google fragment', 'https://accounts.google.com/o/oauth2/v2/auth#unexpected'],
    ];
    const { context, page, state } = await fixture({ initEndpoint: authorizationEndpoint });
    for (const [name, destination, configured = authorizationEndpoint] of cases) {
      state.destination = destination; state.authorizationEndpoint = configured;
      await page.goto(baseURL + '/login'); await google(page).click();
      await expect(page.getByRole('alert'), name).toContainText('n’a pas abouti');
      await expect(page, name).toHaveURL(baseURL + '/login');
      await expect(google(page), name).toBeEnabled(); await expect(page.locator('#login-password'), name).toBeEnabled();
      assert.equal(state.initNavigations.length, 0, name); assert.equal(state.rejectedNavigations.length, 0, name);
      await noSecrets(page);
    }
    assert.equal(state.starts.length, cases.length); await context.close();
  });

  await scenario('New academic Google profile submits once and stays pending without private bootstrap or streams', async () => {
    const { context, page, state } = await fixture({ width: 320 }); state.profileDelay = 250;
    await page.goto(baseURL + '/auth/google/complete'); await expect(page.locator('#google-profile-name')).toBeVisible();
    await enterProfile(page);
    await completion(page).locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await expect(completion(page).locator('button[type="submit"]')).toBeDisabled();
    await expect(page).toHaveURL(/\/account-review$/); await expect(page.locator('.onboarding-heading h1')).toContainText('en attente');
    assert.deepEqual(state.submissions, [{ name: 'Sara Étudiante', username: 'sara.new', faculty_id: 'fsa', filiere_id: 'mathematics', current_semester: 3 }]);
    assert.equal(state.calls.some(call => ['/bootstrap', '/live'].includes(call.path)), false);
    assert.equal(await page.evaluate(() => window.__googleStreams), 0);
    assert.equal(state.user.role, 'student'); await fits(page, page.locator('.account-review-card button')); await noSecrets(page);
    await page.goto(baseURL + '/app/library'); await expect(page).toHaveURL(/\/account-review$/);
    assert.equal(state.calls.some(call => call.path === '/bootstrap'), false);
    await context.close();
  });

  await scenario('Profile options and validation errors remain recoverable and retain the draft', async () => {
    const { context, page, state } = await fixture(); state.optionsFailure = true;
    await page.goto(baseURL + '/auth/google/complete'); await expect(page.getByRole('alert')).toContainText('Facultés temporairement indisponibles');
    state.optionsFailure = false; await completion(page).getByRole('button', { name: 'Réessayer', exact: true }).click();
    await enterProfile(page); state.profileFailure = 'GOOGLE_PROFILE_INVALID';
    await completion(page).locator('button[type="submit"]').click(); await expect(page.getByRole('alert')).toContainText('Vérifiez le nom d’utilisateur');
    await expect(page.locator('#google-profile-username')).toHaveValue('sara.new');
    state.profileFailure = null; await completion(page).locator('button[type="submit"]').click(); await expect(page).toHaveURL(/\/account-review$/);
    assert.equal(state.submissions.length, 2); await context.close();
  });

  await scenario('Expired pending Google identity displays a restart message and never opens protected data', async () => {
    const { context, page, state } = await fixture(); state.expiredProfile = true;
    await page.goto(baseURL + '/auth/google/complete'); await expect(page.getByRole('alert')).toContainText('a expiré');
    await expect(completion(page).locator('form')).toHaveCount(0);
    await completion(page).getByRole('link', { name: 'Retour à la connexion', exact: true }).click(); await expect(page).toHaveURL(/\/login$/);
    assert.equal(state.calls.some(call => ['/bootstrap', '/live'].includes(call.path)), false); await context.close();
  });

  await scenario('An approved Google session restores campus access, logs out and preserves legacy password sign-in', async () => {
    const { context, page, state } = await fixture({ user: student(), linked: true });
    await page.goto(baseURL + '/login'); await expect(page).toHaveURL(/\/app$/); await expect(page.locator('.home-welcome')).toBeVisible();
    assert.ok(state.calls.some(call => call.path === '/bootstrap'));
    await page.goto(baseURL + '/app/profile'); await expect(linkCard(page)).toContainText('Votre compte Google est associé.');
    await expect(linkCard(page)).toContainText(identity.email);
    await page.locator('.settings-stack').getByRole('button', { name: 'Se déconnecter', exact: true }).click(); await expect(page).toHaveURL(/\/login$/);
    await page.locator('#login-username').fill('legacy.student'); await page.locator('#login-password').fill(password);
    await page.locator('.login-form button[type="submit"]').click(); await expect(page).toHaveURL(/\/app$/);
    assert.equal(state.user.email, 'legacy@example.test'); assert.equal(state.calls.filter(call => call.path === '/logout').length, 1);
    await noSecrets(page); await context.close();
  });

  await scenario('An already linked account returns through Google without password or email verification and browser Back never restores an obsolete confirmation page', async () => {
    for (const staleFailure of [false, true]) {
      const { context, page, state } = await fixture({ width: 390, user: student(), linked: true, initEndpoint: staleFailure ? authorizationEndpoint : undefined });
      if (staleFailure) state.destination = `${authorizationEndpoint}?token=${initToken}`;
      await page.goto(baseURL + '/app/profile'); await expect(linkCard(page)).toContainText('Votre compte Google est associé.');
      await page.locator('.settings-stack').getByRole('button', { name: 'Se déconnecter', exact: true }).click();
      await expect(page).toHaveURL(baseURL + '/login'); await expect(google(page)).toBeEnabled();
      await expect(verification(page)).toHaveCount(0); assert.equal(state.user, null);
      // The known safe entry lets actual browser Back traversal detect whether
      // the later normal/error entry incorrectly survives the OAuth roundtrip.
      const baseline = baseURL + '/login?history=before-google';
      await page.goto(baseline); await expect(google(page)).toBeEnabled();
      await page.goto(baseURL + '/login?history=google-start' + (staleFailure ? '&google_error=GOOGLE_LINK_REQUIRED' : ''));
      await expect(page).toHaveURL(baseURL + '/login?history=google-start');
      await expect(verification(page)).toHaveCount(staleFailure ? 1 : 0); await expect(google(page)).toBeEnabled();
      const afterLogout = state.calls.length;
      await google(page).click(); await expect(page).toHaveURL(state.destination);
      assert.deepEqual(state.starts, [{ intent: 'login' }]); assert.deepEqual(state.logins, []);
      assert.deepEqual(state.verificationSends, []); assert.deepEqual(state.verificationConfirms, []);
      assert.equal(staleFailure ? state.initNavigations.length : state.googleNavigations.length, 1);
      assert.equal(state.user, null, 'Google navigation alone does not create an application session.');
      state.googleCallbackUser = student();
      await page.goto(baseURL + '/api/auth/google/callback?neon_auth_session_verifier=linked-fixture-verifier');
      await expect(page).toHaveURL(baseURL + '/app'); await expect(page.locator('.home-welcome')).toBeVisible();
      const continuation = state.calls.slice(afterLogout);
      assert.deepEqual(continuation.filter(call => call.method === 'POST').map(call => call.path), ['/auth/google/start']);
      assert.equal(continuation.some(call => ['/login', '/auth/google/link', '/auth/google/email-verification/start', '/auth/google/email-verification/confirm'].includes(call.path)), false);
      assert.ok(continuation.some(call => call.path === '/auth/google/callback')); assert.ok(continuation.some(call => call.path === '/bootstrap'));
      assert.equal(state.user.id, 2); assert.equal(state.user.account_status, 'approved');
      await page.goto(baseURL + '/app/profile');
      await page.locator('.settings-stack').getByRole('button', { name: 'Se déconnecter', exact: true }).click();
      await expect(page).toHaveURL(baseURL + '/login'); await expect(google(page)).toBeEnabled();
      let reachedBaseline = false;
      for (let step = 0; step < 8 && !reachedBaseline; step++) {
        await page.goBack();
        const current = new URL(page.url());
        if (current.origin !== new URL(baseURL).origin) continue;
        if (current.pathname.startsWith('/app')) await expect(page).toHaveURL(/\/login(?:\?|$)/);
        await expect(page.locator('.login-form-heading h2')).toContainText('Ravi de vous retrouver');
        await expect(verification(page)).toHaveCount(0); await expect(page.locator('#login-password')).toBeVisible();
        assert.equal(await page.evaluate(() => window.history.state?.usr?.campusGoogleError), undefined);
        assert.notEqual(new URL(page.url()).searchParams.get('history'), 'google-start', 'The obsolete pre-OAuth page must be replaced in browser history.');
        reachedBaseline = page.url() === baseline;
      }
      assert.equal(reachedBaseline, true, 'Back reaches the safe page before the OAuth attempt.');
      assert.deepEqual(state.verificationSends, []); assert.deepEqual(state.verificationConfirms, []); assert.deepEqual(state.logins, []);
      await noSecrets(page); await context.close();
    }
  });

  await scenario('Current-password linking preserves the session on wrong password and navigates once after confirmation', async () => {
    const { context, page, state } = await fixture({ width: 768, user: student() });
    await page.goto(baseURL + '/app/profile'); await linkCard(page).getByRole('button', { name: 'Associer Google', exact: true }).click();
    await linkCard(page).getByLabel('Mot de passe actuel', { exact: true }).fill('Wrong-fixture-password');
    state.startFailure = 'GOOGLE_PASSWORD_INVALID'; await linkCard(page).locator('button[type="submit"]').click();
    await expect(linkCard(page).getByRole('alert')).toContainText('mot de passe actuel est incorrect');
    await expect(page).toHaveURL(/\/app\/profile$/); await expect(page.locator('.profile-card')).toBeVisible();
    await expect(linkCard(page).getByLabel('Mot de passe actuel', { exact: true })).toHaveValue('');
    assert.equal(state.user.id, 2); await noSecrets(page);
    state.startFailure = null; state.startDelay = 250;
    await linkCard(page).getByLabel('Mot de passe actuel', { exact: true }).fill(password);
    await linkCard(page).locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await expect(linkCard(page).locator('button[type="submit"]')).toBeDisabled();
    await expect(page).toHaveURL(/^https:\/\/accounts\.google\.com\//);
    assert.deepEqual(state.starts, [{ intent: 'link', password: 'Wrong-fixture-password' }, { intent: 'link', password }]);
    state.linked = true; await page.goto(baseURL + '/app/profile'); await expect(linkCard(page)).toContainText('Votre compte Google est associé.');
    await expect(linkCard(page).locator('input')).toHaveCount(0); await noSecrets(page); await context.close();
  });

  await scenario('Pending password accounts can link Google while administrative approval remains enforced', async () => {
    const { context, page, state } = await fixture({ user: student({ account_status: 'pending' }), width: 320 });
    await page.goto(baseURL + '/account-review'); await linkCard(page).getByRole('button', { name: 'Associer Google', exact: true }).click();
    await linkCard(page).getByLabel('Mot de passe actuel', { exact: true }).fill(password);
    await fits(page, linkCard(page).locator('input, button')); await noSecrets(page);
    assert.equal(state.calls.some(call => ['/bootstrap', '/live'].includes(call.path)), false);
    await context.close();
  });

  await scenario('An expired linking session returns to login without silently restarting Google', async () => {
    const { context, page, state } = await fixture({ user: student() });
    await page.goto(baseURL + '/app/profile'); await linkCard(page).getByRole('button', { name: 'Associer Google', exact: true }).click();
    await linkCard(page).getByLabel('Mot de passe actuel', { exact: true }).fill(password); state.expiredLink = true;
    await linkCard(page).locator('button[type="submit"]').click(); await expect(page).toHaveURL(/\/login$/);
    assert.equal(state.starts.length, 1); assert.equal(state.googleNavigations.length, 0); await noSecrets(page); await context.close();
  });

  await scenario('OAuth refusal, domain, verification, conflict and expiry errors are clear and consumed from the URL', async () => {
    const cases = [
      ['GOOGLE_DOMAIN_REJECTED', 'fr', 'adresses personnelles'], ['GOOGLE_EMAIL_UNVERIFIED', 'en', 'Google must verify'],
      ['GOOGLE_ATTEMPT_INVALID', 'fr', 'a expiré'],
      ['GOOGLE_ACCESS_DENIED', 'en', 'was cancelled'], ['GOOGLE_LINK_CONFLICT', 'fr', 'ne peut pas être associé'],
      ['GOOGLE_ACCOUNT_DISABLED', 'ar', 'هذا الحساب معطّل'], ['UNKNOWN_ERROR', 'fr', 'n’a pas abouti'],
    ];
    for (const [code, language, text] of cases) {
      const { context, page, state } = await fixture({ language });
      await page.goto(`${baseURL}/login?foo=kept&google_error=${code}`);
      await expect(page.getByRole('alert')).toContainText(text);
      await expect(page).toHaveURL(/\/login\?foo=kept$/);
      await expect(google(page)).toBeEnabled(); await expect(page.locator('#login-username, #login-password')).toHaveCount(0);
      assert.equal(state.starts.length, 0); assert.equal(state.logins.length, 0); await context.close();
    }
    for (const account_status of ['approved', 'pending']) {
      const { context, page } = await fixture({ user: student({ account_status }) });
      const path = account_status === 'approved' ? '/app/profile' : '/account-review';
      await page.goto(`${baseURL}${path}?google_error=GOOGLE_LINK_CONFLICT`);
      await expect(page.getByRole('alert')).toContainText('ne peut pas être associé'); await expect(page).toHaveURL(baseURL + path);
      await context.close();
    }
  });

  await scenario('Pending status checks enter campus only after approval and existing password resets keep their gate', async () => {
    const { context, page, state } = await fixture({ user: student({ account_status: 'pending' }) });
    await page.goto(baseURL + '/account-review'); await page.getByRole('button', { name: 'Vérifier le statut', exact: true }).click();
    await expect(page.locator('.account-review-card [role="status"]')).toContainText('toujours en attente');
    assert.equal(state.calls.some(call => call.path === '/bootstrap'), false);
    state.user = student(); await page.getByRole('button', { name: 'Vérifier le statut', exact: true }).click();
    await expect(page).toHaveURL(/\/app$/); await expect(page.locator('.home-welcome')).toBeVisible();
    state.user = student({ must_change_password: true, password_reset_state: 'pending' });
    const before = state.calls.filter(call => call.path === '/bootstrap').length;
    await page.goto(baseURL + '/auth/google/complete'); await expect(page).toHaveURL(/\/change-password$/);
    assert.equal(state.calls.filter(call => call.path === '/bootstrap').length, before);
    await context.close();
  });
  assert.deepEqual(errors, []);
  console.log(`${passed.length} Google OAuth browser scenarios passed (18 responsive language/theme combinations).`);
} finally { await browser.close(); }
