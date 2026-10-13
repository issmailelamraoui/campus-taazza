import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chooseOption } from './ui.helpers.mjs';

// Isolated UI/API contracts. Provider mutation and authorization use separate
// backend tests; these fixtures never contact an actual authentication service.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [], problems = [];
const date = '2026-10-13T09:00:00.000Z';
const expiry = '2026-10-14T09:00:00.000Z';
const secret = 'Temporary-password-123!';
await mkdir('test-results', { recursive: true });

async function setup({ role = 'global_admin', width = 1440, theme = 'dark' } = {}) {
  const self = { id: 1, name: 'Administration test', username: 'admin.test', email: 'admin@example.test', role, faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, language: 'fr', preferences: {}, account_status: 'approved', disabled: false, registered_at: date, can_reset_password: true };
  const student = { ...self, id: 2, name: 'Sara Benali', username: 'sara.test', email: 'sara@example.test', role: 'student' };
  const other = { ...student, id: 3, name: 'Omar Test', username: 'omar.test' };
  const state = { self, users: [self, student, other, { ...student, id: 4, name: 'Student without permission', username: 'flag.test', can_reset_password: false }, { ...student, id: 5, name: 'Pending student', username: 'pending.test', account_status: 'pending' }, { ...student, id: 6, name: 'Disabled student', username: 'disabled.test', disabled: true }, { ...student, id: 7, name: 'Faculty administrator', username: 'leader.test', role: 'faculty_admin' }], contacts: [{ id: 50, faculty_id: 'flaa', user_id: 2, name: student.name, email: student.email, subject: 'credentials', message: 'J’ai oublié mon mot de passe.', created_at: date, status: 'open' }, { id: 51, faculty_id: 'flaa', user_id: null, name: 'Demande sans compte', email: student.email, subject: 'credentials', message: 'Je ne peux plus me connecter.', created_at: date, status: 'open' }], calls: [], responses: [], delay: 0 };
  const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 1000 }, reducedMotion: 'reduce', hasTouch: width < 760 });
  await context.addInitScript(({ theme }) => {
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    window.EventSource = undefined;
  }, { theme });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => problems.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/api/, ''), method = request.method();
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (method === 'GET') {
      if (path === '/session') return send({ user: state.self });
      if (path === '/bootstrap') return send({ user: state.self, faculty: { id: 'flaa', code: 'FLAA', name: 'Faculté des Langues, des Lettres et des Arts', members: 7 }, resources: [], announcements: [], messages: [], channels: [], members: state.users, saved: [], history: [], events: [], notifications: [] });
      if (path === '/admin') return send({ users: state.users, resources: [], announcements: [], reports: [], contacts: state.contacts, channels: [] });
      if (path === '/admin/registrations') return send({ requests: [] });
      if (path === '/chat/blocks') return send({ blocks: [] });
    }
    if (/^\/admin\/users\/\d+\/password-reset$/.test(path) && method === 'POST') {
      state.calls.push({ path, body: request.postDataJSON() });
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      const response = state.responses.shift() || { status: 200, data: { ok: true, must_change_password: true, expires_at: expiry } };
      return send(response.data, response.status);
    }
    problems.push(`Unexpected API contract: ${method} ${path}`);
    return send({ error: 'Route de test non reconnue.' }, 500);
  });
  await page.goto(`${baseURL}/app/admin?tab=accounts`);
  await expect(page.locator('.admin-page')).toHaveAttribute('aria-busy', 'false');
  return { context, page, state };
}

const modal = page => page.getByRole('dialog');
const resetForm = page => page.locator('.admin-password-reset');
const submitButton = page => resetForm(page).getByRole('button', { name: 'Créer le mot de passe temporaire', exact: true });
const openReset = (page, name = 'Sara Benali') => page.getByRole('button', { name: `Réinitialiser le mot de passe de ${name}`, exact: true }).click();
async function enter(page, value = secret) {
  await resetForm(page).getByLabel('Nouveau mot de passe temporaire', { exact: true }).fill(value);
  await resetForm(page).getByLabel('Motif de la réinitialisation', { exact: true }).fill('Demande et identité vérifiées en personne.');
  await resetForm(page).getByRole('checkbox').check();
}
async function noStoredSecret(page, value = secret) {
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.equal(stored.includes(value), false);
}
async function scenario(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }

try {
  await scenario('Owner-only controls also require the server eligibility flag and an active ordinary student', async () => {
    const owner = await setup();
    await expect(owner.page.getByRole('button', { name: /^Réinitialiser le mot de passe de / })).toHaveCount(2);
    await owner.context.close();
    const faculty = await setup({ role: 'faculty_admin' });
    await expect(faculty.page.getByRole('button', { name: /^Réinitialiser le mot de passe de / })).toHaveCount(0);
    await faculty.context.close();
  });

  await scenario('Verified owner submits once, receives the confirmed password, then clears it on close and target change', async () => {
    const { context, page, state } = await setup(); await openReset(page);
    await resetForm(page).getByRole('button', { name: 'Générer un mot de passe sécurisé', exact: true }).click();
    const generated = await resetForm(page).getByLabel('Nouveau mot de passe temporaire', { exact: true }).inputValue();
    assert.equal(generated.length, 20); await expect(submitButton(page)).toBeDisabled();
    await enter(page); state.delay = 200;
    await resetForm(page).locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await expect(resetForm(page)).toContainText('Le mot de passe temporaire est actif.');
    assert.equal(state.calls.length, 1); assert.equal(state.calls[0].body.identity_verified, true);
    assert.match(state.calls[0].body.operation_id, /^[0-9a-f-]{36}$/i);
    await expect(resetForm(page).getByLabel('Mot de passe temporaire', { exact: true })).toHaveValue(secret);
    await expect(resetForm(page).getByLabel('Mot de passe temporaire', { exact: true })).toHaveAttribute('type', 'password');
    await resetForm(page).getByRole('button', { name: 'Afficher', exact: true }).click();
    await expect(resetForm(page).getByLabel('Mot de passe temporaire', { exact: true })).toHaveAttribute('type', 'text');
    await expect(resetForm(page)).toContainText('Accès temporaire valable jusqu’au'); await noStoredSecret(page);
    await resetForm(page).getByRole('button', { name: 'Fermer et effacer', exact: true }).click();
    await expect(modal(page)).toHaveCount(0); await openReset(page, 'Omar Test');
    await expect(resetForm(page).getByLabel('Nouveau mot de passe temporaire', { exact: true })).toHaveValue('');
    await expect(resetForm(page)).toContainText('Omar Test'); await noStoredSecret(page); await context.close();
  });

  await scenario('Linked assistance targets its actual account and submits the matching contact ID', async () => {
    const { context, page, state } = await setup();
    await page.getByRole('tab', { name: /^Assistance/ }).click();
    await page.locator('.admin-assistance-row').filter({ hasText: 'Sara Benali' }).getByRole('button', { name: 'Traiter', exact: true }).click();
    await modal(page).getByRole('button', { name: 'Créer un accès temporaire', exact: true }).click();
    await expect(resetForm(page)).toContainText('Demande liée #50'); await enter(page); await submitButton(page).click();
    await expect(resetForm(page)).toContainText('Le mot de passe temporaire est actif.');
    assert.equal(state.calls[0].path, '/admin/users/2/password-reset'); assert.equal(state.calls[0].body.contact_id, 50);
    await context.close();
  });

  await scenario('Anonymous assistance requires manual account selection even if its email matches a student', async () => {
    const { context, page, state } = await setup();
    await page.getByRole('tab', { name: /^Assistance/ }).click();
    await page.locator('.admin-assistance-row').filter({ hasText: 'Demande sans compte' }).getByRole('button', { name: 'Traiter', exact: true }).click();
    await modal(page).getByRole('button', { name: 'Choisir le compte à réinitialiser', exact: true }).click();
    await expect(modal(page).getByRole('button', { name: 'Continuer', exact: true })).toBeDisabled();
    await chooseOption(modal(page).getByRole('combobox', { name: 'Compte à réinitialiser', exact: true }), '3');
    await modal(page).getByRole('button', { name: 'Continuer', exact: true }).click();
    await expect(resetForm(page)).toContainText('Omar Test'); await enter(page); await submitButton(page).click();
    await expect(resetForm(page)).toContainText('Le mot de passe temporaire est actif.');
    assert.equal(state.calls[0].path, '/admin/users/3/password-reset'); assert.equal('contact_id' in state.calls[0].body, false);
    await context.close();
  });

  await scenario('Unknown result never produces a receipt, checks the same operation, and requires an explicit new attempt', async () => {
    const { context, page, state } = await setup(); await openReset(page); await enter(page);
    state.responses.push(...Array.from({ length: 2 }, () => ({ status: 503, data: { error: 'Résultat non confirmé.', code: 'PASSWORD_RESET_UNKNOWN' } })));
    await submitButton(page).click();
    await expect(resetForm(page)).toContainText('Le résultat reste à confirmer.');
    await expect(resetForm(page).getByLabel('Mot de passe temporaire', { exact: true })).toHaveCount(0);
    await expect(resetForm(page).getByLabel('Nouveau mot de passe temporaire', { exact: true })).toBeDisabled();
    assert.equal(state.calls.length, 1);
    await resetForm(page).getByRole('button', { name: 'Vérifier cette tentative', exact: true }).click();
    await expect(resetForm(page).getByRole('button', { name: 'Vérifier cette tentative', exact: true })).toBeEnabled();
    assert.deepEqual(state.calls[0].body, state.calls[1].body);
    await resetForm(page).getByRole('button', { name: 'Commencer une nouvelle tentative', exact: true }).click();
    await expect(resetForm(page).getByLabel('Nouveau mot de passe temporaire', { exact: true })).toHaveValue('');
    await expect(resetForm(page).getByLabel('Motif de la réinitialisation', { exact: true })).toHaveValue('');
    await expect(resetForm(page).getByRole('checkbox')).not.toBeChecked();
    await enter(page, 'Second-temporary-password-123!'); await submitButton(page).click();
    await expect(resetForm(page)).toContainText('Le mot de passe temporaire est actif.');
    assert.notEqual(state.calls[0].body.operation_id, state.calls[2].body.operation_id);
    await noStoredSecret(page); await context.close();
  });

  await scenario('Pending operation only allows checking the same attempt and waits for an issued confirmation', async () => {
    const { context, page, state } = await setup(); await openReset(page); await enter(page);
    state.responses.push({ status: 409, data: { error: 'Tentative en cours.', code: 'PASSWORD_RESET_PENDING' } });
    await submitButton(page).click(); await expect(resetForm(page)).toContainText('Le résultat reste à confirmer.');
    await expect(resetForm(page).getByRole('button', { name: 'Commencer une nouvelle tentative', exact: true })).toHaveCount(0);
    await resetForm(page).getByRole('button', { name: 'Vérifier cette tentative', exact: true }).click();
    await expect(resetForm(page)).toContainText('Le mot de passe temporaire est actif.');
    assert.deepEqual(state.calls[0].body, state.calls[1].body); await context.close();
  });

  await scenario('Definitive failure clears the old entry and starts a fresh verified operation after correction', async () => {
    const { context, page, state } = await setup(); await openReset(page); await enter(page);
    state.responses.push({ status: 400, data: { error: 'Demande refusée.', code: 'PASSWORD_RESET_REJECTED' } });
    await submitButton(page).click(); await expect(resetForm(page)).toContainText('Cette tentative a été refusée.');
    await expect(resetForm(page).getByLabel('Nouveau mot de passe temporaire', { exact: true })).toHaveValue('');
    await resetForm(page).getByRole('button', { name: 'Commencer une nouvelle tentative', exact: true }).click();
    await enter(page); await submitButton(page).click(); await expect(resetForm(page)).toContainText('Le mot de passe temporaire est actif.');
    assert.notEqual(state.calls[0].body.operation_id, state.calls[1].body.operation_id); await context.close();
  });

  await scenario('Provider configuration rejection remains a definitive failure even when its HTTP status is 503', async () => {
    const { context, page, state } = await setup(); await openReset(page); await enter(page);
    state.responses.push({ status: 503, data: { error: 'Le compte administrateur Neon Auth doit être autorisé.', code: 'AUTH_ADMIN_CONFIGURATION' } });
    await submitButton(page).click(); await expect(resetForm(page)).toContainText('Cette tentative a été refusée.');
    await expect(resetForm(page).getByLabel('Nouveau mot de passe temporaire', { exact: true })).toHaveValue('');
    await expect(resetForm(page).getByRole('button', { name: 'Vérifier cette tentative', exact: true })).toHaveCount(0);
    await expect(resetForm(page).getByRole('button', { name: 'Commencer une nouvelle tentative', exact: true })).toBeEnabled();
    assert.equal(state.calls.length, 1); await context.close();
  });

  await scenario('The audit reason cannot contain the temporary password and correction remains possible', async () => {
    const { context, page, state } = await setup(); await openReset(page); await enter(page);
    await resetForm(page).getByLabel('Motif de la réinitialisation', { exact: true }).fill(`Demande vérifiée avec ce mot de passe : ${secret}`);
    await submitButton(page).click(); await expect(resetForm(page).getByRole('alert')).toHaveText('Retirez le mot de passe du motif avant de continuer.');
    assert.equal(state.calls.length, 0); await noStoredSecret(page);
    await resetForm(page).getByLabel('Motif de la réinitialisation', { exact: true }).fill('Demande et identité vérifiées en personne.');
    await submitButton(page).click(); await expect(resetForm(page)).toContainText('Le mot de passe temporaire est actif.');
    assert.equal(state.calls.length, 1); assert.equal(state.calls[0].body.reason.includes(secret), false); await context.close();
  });

  await scenario('Session clearing dismisses and erases the password receipt', async () => {
    const { context, page } = await setup(); await openReset(page); await enter(page); await submitButton(page).click();
    await expect(resetForm(page)).toContainText('Le mot de passe temporaire est actif.');
    await page.evaluate(() => window.dispatchEvent(new Event('campus-session-cleared')));
    await expect(modal(page)).toHaveCount(0); await noStoredSecret(page); await openReset(page);
    await expect(resetForm(page).getByLabel('Nouveau mot de passe temporaire', { exact: true })).toHaveValue('');
    await context.close();
  });

  await scenario('Reset dialog fits narrow screens in both themes', async () => {
    for (const theme of ['dark', 'light']) {
      const { context, page } = await setup({ width: 320, theme }); await openReset(page);
      assert.ok(await resetForm(page).evaluate(element => element.getBoundingClientRect().width <= innerWidth));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
      await enter(page); await submitButton(page).click(); await expect(resetForm(page)).toContainText('Le mot de passe temporaire est actif.');
      await noStoredSecret(page); await context.close();
    }
  });
  assert.deepEqual(problems, []);
  await writeFile('test-results/admin-password-reset-report.json', JSON.stringify({ passed, problems }, null, 2));
  console.log(`${passed.length} owner password reset UI scenarios passed.`);
} finally { await browser.close(); }
