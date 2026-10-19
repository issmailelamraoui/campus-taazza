import { chromium, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// All API traffic is intercepted; execution uses the actual browser JavaScript runtime.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const expect = baseExpect.configure({ timeout: 20000 });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [], writes = [];
let loads = 0, releaseInitial, recovered = false;
const initialResponse = new Promise(resolve => { releaseInitial = resolve; });
const user = { id: 3, username: 'labs.availability.fixture', name: 'Étudiante test', role: 'student', account_status: 'approved', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, language: 'fr', preferences: {} };
const existing = { id: 'existing-session', language: 'javascript', source: 'console.log("Existing session");', result: { status: 'valid_syntax', diagnostics: [] }, updatedAt: '2026-10-18T10:00:00Z', completedAt: null, voluntaryXp: false, revisions: 1 };
let created;
const context = await browser.newContext({ viewport: { width: 320, height: 720 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
await context.addInitScript(() => {
  if (window !== window.top) return;
  window.EventSource = undefined;
  localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
  localStorage.setItem('campuslink-prototype-v1:theme', '"light"');
  localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
});
const page = await context.newPage(); page.setDefaultTimeout(20000);
page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
  const send = (json, status = 200) => route.fulfill({ status, json });
  if (path === '/api/session') return send({ user });
  if (path === '/api/bootstrap') return send({ user, faculty: { id: 'flaa', name: 'Faculté test' }, resources: [], notifications: [], announcements: [], messages: [], saved: [], history: [], channels: [], members: [] });
  if (path === '/api/labs' && method === 'GET') {
    loads++;
    if (!recovered) {
      await initialResponse;
      return send({ error: 'Sessions temporairement indisponibles.' }, 503).catch(() => {});
    }
    return send({ sessions: [existing], languages: ['javascript', 'json'] });
  }
  if (path === '/api/labs' && method === 'POST') {
    writes.push({ path, body: request.postDataJSON() });
    created = { ...existing, id: 'new-fixture-session', source: '', result: {}, revisions: 0 };
    return send({ session: created }, 201);
  }
  if (path === '/api/labs/new-fixture-session/check' && method === 'POST') {
    const body = request.postDataJSON(); writes.push({ path, body });
    created = { ...created, source: body.source, result: { status: 'valid_syntax', diagnostics: [] }, revisions: 1 };
    return send({ session: created });
  }
  errors.push(`Unexpected fixture API ${method} ${path}`);
  return send({ error: 'Unexpected fixture endpoint' }, 503);
});

const run = () => page.getByRole('button', { name: 'Exécuter', exact: true });
try {
  await page.goto(baseURL + '/app/labs');
  await expect(page.locator('.labs-sessions-loading')).toContainText('Chargement de vos sessions privées');
  await expect.poll(() => Boolean(releaseInitial)).toBe(true);
  releaseInitial();
  const availability = page.locator('.labs-sessions-error');
  await expect(availability).toContainText('Sessions temporairement indisponibles.');
  await expect(page.locator('.labs-sessions-loading')).toHaveCount(0);
  await page.getByRole('button', { name: 'Nouvelle session', exact: true }).click();
  await expect(availability).toBeVisible();
  const source = 'console.log("LOCAL-EXECUTION-42");';
  await page.getByLabel('Votre code', { exact: true }).fill(source);
  await run().click(); await expect(run()).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('.labs-console-output')).toContainText('LOCAL-EXECUTION-42');
  await expect(page.locator('.labs-console-status')).toHaveText('Terminé');
  await expect(availability).toBeVisible();
  const unsaved = page.locator('.labs-alert[role="status"]');
  await expect(unsaved).toContainText('cette exécution n’a pas été enregistrée');
  assert.deepEqual(writes, [], 'Unavailable sessions never create a hidden write');

  const loadsBeforeRetry = loads;
  recovered = true;
  await availability.getByRole('button', { name: 'Réessayer le chargement des sessions', exact: true }).click();
  await expect(availability).toHaveCount(0);
  await expect(page.locator('.labs-session-list')).toContainText('JavaScript');
  await expect(page.getByLabel('Votre code', { exact: true })).toHaveText(source);
  await expect(unsaved).toContainText('cette exécution n’a pas été enregistrée');
  assert.equal(loads, loadsBeforeRetry + 1);
  assert.deepEqual(writes, [], 'Retrying availability preserves code and never saves without execution');

  await run().click(); await expect(run()).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('.labs-result')).toContainText('session enregistrée');
  await expect(page.locator('.labs-console-output')).toContainText('LOCAL-EXECUTION-42');
  await expect(unsaved).toHaveCount(0);
  assert.equal(writes.length, 2, 'Recovered execution creates and checks one session');
  assert.equal(writes[1].body.source, source);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  await mkdir('test-results/labs-availability', { recursive: true });
  await writeFile('test-results/labs-availability/report.json', JSON.stringify({ passed: ['visible loading and persistent availability error', 'actual local execution with explicit unsaved status', 'explicit retry preserves code and does not write', 'recovered execution saves one session'], width: 320, loads, writes: writes.map(write => write.path), errors }, null, 2));
  console.log('PASS Labs availability at 320px: loading, persistent failure, real local execution, truthful unsaved status, explicit retry and recovered save');
} finally { await context.close(); await browser.close(); }
