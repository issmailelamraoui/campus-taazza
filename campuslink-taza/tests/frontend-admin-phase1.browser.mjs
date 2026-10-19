import { chromium, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { getFilieres } from '../src/data/studies.js';
import { chooseOption } from './ui.helpers.mjs';

// Every API request is intercepted, including all permission and login writes.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const expect = baseExpect.configure({ timeout: 20000 });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const failures = [], results = [];
const date = '2026-10-18T10:00:00Z';
const output = 'test-results/frontend-admin-phase1';
await mkdir(output, { recursive: true });

async function fixture({ width = 320, faculty = 'flaa', language = 'fr', role = 'global_admin', guest = false } = {}) {
  const programme = getFilieres(faculty)[0].id;
  const self = { id: 1, username: 'owner.fixture', name: 'Administration de test', role, has_admin_access: true, faculty_id: faculty, filiere_id: programme, current_semester: 1, account_status: 'approved', language, preferences: {}, administrative_capabilities: [{ facultyId: faculty, filiereId: programme, capabilities: ['student.support', 'content.moderate'] }] };
  const student = { ...self, id: 2, username: 'compte.etudiant.identifiant.long', name: 'Étudiante au nom particulièrement long العربية', email: 'fixture@example.test', role: 'student', has_admin_access: false, administrative_capabilities: [] };
  const state = { self, session: guest ? null : self, users: [self, student, { ...student, id: 3, username: 'pending.fixture', name: 'Pending fixture', account_status: 'pending' }, { ...student, id: 4, username: 'disabled.fixture', name: 'Disabled fixture', disabled: true }], appointments: [{ id: 81, user_id: 2, faculty_id: faculty, filiere_id: programme, capabilities: ['content.moderate'], revoked_at: null }], calls: [], fail: false };
  const resource = { id: 20, faculty_id: faculty, filiere_id: programme, title: 'Document de test au nom long العربية', filename: 'fixture.pdf', module: 'Module de test', semester: 1, category: 'courses', part_number: 'complete', created_at: date, size: 5000, mime: 'application/pdf', version: 1, author: student, library_visible: true, status: 'new' };
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 720 : 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(({ language }) => {
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify('light'));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    window.EventSource = undefined;
  }, { language });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => failures.push(error.message));
  await context.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.replace(/^\/api/, ''), method = req.method();
    const send = (data, status = 200) => route.fulfill({ status, json: data });
    if (method === 'GET') {
      if (path === '/session') return send({ user: state.session });
      if (path === '/bootstrap') return send({ user: state.self, faculty: { id: faculty, code: faculty.toUpperCase(), name: faculty }, resources: [resource], messages: [{ id: 41, faculty_id: faculty, filiere_id: programme, channel: 'general', content: 'Message de test', created_at: date, author: student, attachments: [], reactions: {} }], announcements: [{ id: 31, faculty_id: faculty, title: 'Annonce de test', content: 'Contenu de test', author: self, created_at: date }], channels: [], members: state.users, saved: [], history: [], events: [], notifications: [] });
      if (path === '/admin') return send({ users: state.users, resources: [resource], reports: [{ id: 51, faculty_id: faculty, target_type: 'message', target_id: 41, reason: 'inappropriate', details: 'Détail du signalement', reporter: student, created_at: date, status: 'open' }], contacts: [{ id: 61, faculty_id: faculty, name: student.name, email: student.email, subject: 'credentials', message: 'Demande de test', status: 'reviewing', created_at: date }], channels: [{ id: 'general', faculty_id: faculty, name: 'Discussion de test', description: 'Description', read_only: false }], announcements: [] });
      if (path === '/admin/registrations') return send({ requests: [state.users[2]] });
      if (path === '/admin/appointments') return send({ appointments: state.appointments });
      if (path === '/chat/blocks') return send({ blocks: [] });
    }
    state.calls.push({ method, path, body: req.postDataJSON() });
    if (path === '/admin/appointments' && method === 'POST') {
      await new Promise(resolve => setTimeout(resolve, 120));
      if (state.fail) { state.fail = false; return send({ error: 'Nomination temporairement indisponible.' }, 503); }
      const appointment = { ...req.postDataJSON(), id: 82, revoked_at: null };
      state.appointments.push(appointment); return send({ appointment }, 201);
    }
    if (path === '/admin/appointments/81' && method === 'DELETE') {
      state.appointments[0].revoked_at = date; return send({ ok: true });
    }
    if (path === '/login' && method === 'POST') {
      await new Promise(resolve => setTimeout(resolve, 120)); state.session = state.self; return send({ user: state.self });
    }
    failures.push(`Unexpected fixture API ${method} ${path}`);
    return send({ error: 'Unexpected fixture endpoint' }, 503);
  });
  return { context, page, state, programme };
}

async function fit(page, label) {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
  assert.ok(geometry.page <= geometry.viewport + 1, `${label}: no page overflow ${JSON.stringify(geometry)}`);
  results.push({ label, ...geometry });
}

try {
  // One faculty per configuration, with all administration tabs and a real resource form.
  for (const config of [{ width: 320, faculty: 'flaa', language: 'fr' }, { width: 390, faculty: 'feg', language: 'ar' }, { width: 768, faculty: 'fsjp', language: 'en' }, { width: 1920, faculty: 'fsa', language: 'fr' }]) {
    const { context, page } = await fixture(config);
    try {
      await page.goto(baseURL + '/app/admin');
      await expect(page.locator('.admin-page')).toHaveAttribute('aria-busy', 'false');
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(8);
      for (let index = 0; index < 8; index++) {
        await tabs.nth(index).click();
        await fit(page, `${config.faculty}/${config.width}/${config.language}/tab-${index}`);
      }
      await tabs.nth(3).click();
      await page.locator('.admin-resource-title').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const part = dialog.getByRole('combobox').nth(2);
      await part.click();
      const values = await page.getByRole('listbox').getByRole('option').evaluateAll(nodes => nodes.map(node => node.dataset.value));
      assert.deepEqual(values, ['complete', ...Array.from({ length: 20 }, (_, i) => String(i + 1))]);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      if (config.width === 320) {
        await tabs.nth(7).click();
        await expect(page.locator('.admin-assistance-row .admin-status')).toHaveText('En cours d’examen');
        const search = page.locator('.admin-search-field input');
        assert.ok(await search.evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
      }
      await page.screenshot({ path: `${output}/admin-${config.faculty}-${config.width}.png`, fullPage: true });
      console.log(`PASS ${config.faculty}: eight admin panels at ${config.width}px (${config.language}) and 21 part options`);
    } finally { await context.close(); }
  }

  const { context, page, state, programme } = await fixture();
  try {
    await page.goto(baseURL + '/app/permissions?user=2');
    await expect(page.locator('.permissions-page')).toHaveAttribute('aria-busy', 'false');
    const form = page.locator('.permissions-form'), account = form.getByRole('combobox').nth(0), program = form.getByRole('combobox').nth(2), grant = form.locator('button[type="submit"]');
    await account.click();
    assert.deepEqual(await page.getByRole('listbox').getByRole('option').evaluateAll(nodes => nodes.map(node => node.dataset.value)), ['', '2']);
    await page.keyboard.press('Escape');
    await form.getByRole('checkbox', { name: /Déposer dans tous/ }).check();
    await expect(grant).toBeDisabled();
    await expect(program).toHaveAttribute('aria-invalid', 'true');
    await form.evaluate(node => node.requestSubmit());
    assert.equal(state.calls.length, 0, 'Invalid upload scope never reaches API');
    await chooseOption(program, programme);
    await expect(grant).toBeEnabled();
    state.fail = true;
    await grant.click();
    await expect(form.getByRole('alert')).toHaveText('Nomination temporairement indisponible.');
    await expect(form.getByRole('checkbox', { name: /Déposer dans tous/ })).toBeChecked();
    await form.evaluate(node => { node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await expect.poll(() => state.calls.filter(call => call.path === '/admin/appointments').length).toBe(2);
    await expect(page.locator('.permissions-page')).toHaveAttribute('aria-busy', 'false');
    assert.deepEqual(state.calls[1].body.capabilities, ['resource.upload']);
    await expect(form.getByRole('checkbox', { name: /Déposer dans tous/ })).not.toBeChecked();
    const revoke = page.locator('.permissions-appointment').first().getByRole('button');
    await revoke.click();
    await expect(page.getByRole('dialog')).toContainText(state.users[1].name);
    assert.equal(state.calls.filter(call => call.method === 'DELETE').length, 0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await revoke.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Révoquer la nomination', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.permissions-appointment').first().locator('.admin-status')).toHaveText('Révoquée');
    assert.equal(state.calls.filter(call => call.method === 'DELETE').length, 1);
    await fit(page, '320px permission form, appointment list and revocation');
    console.log('PASS permissions: eligible accounts, upload scope, preserved server error, single submission, reviewed revocation');
  } finally { await context.close(); }

  const login = await fixture({ guest: true, role: 'faculty_leader' });
  try {
    await login.page.goto(baseURL + '/login');
    await login.page.locator('#login-username').fill('leader.fixture');
    await login.page.locator('#login-password').fill('Fixture-only-password');
    await login.page.locator('.login-form').evaluate(node => { node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await expect(login.page).toHaveURL(/\/app\/admin$/);
    await expect(login.page.locator('.admin-page')).toHaveAttribute('aria-busy', 'false');
    assert.equal(login.state.calls.filter(call => call.path === '/login').length, 1);
    await expect(login.page.locator('.admin-demo-notice')).toContainText('Responsable de faculté');
    await login.page.goto(baseURL + '/');
    await login.page.setViewportSize({ width: 768, height: 900 });
    await expect(login.page.locator('.public-header-login')).toHaveAttribute('href', '/app/admin');
    console.log('PASS faculty leader: one login request, administration destination and public account link');
  } finally { await login.context.close(); }
  assert.deepEqual(failures, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ results, failures }, null, 2));
} finally { await browser.close(); }
