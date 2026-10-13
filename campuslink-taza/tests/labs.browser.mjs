import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { validateLabSource, LABS_LANGUAGES, LABS_POLICY } from '../server/labs.js';
import { chooseOption } from './ui.helpers.mjs';
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const executablePath = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(executablePath) ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [];
mkdirSync('test-results', { recursive: true });
let activePage;
async function fixture(width = 1280, languages = LABS_LANGUAGES) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800, isMobile: width < 800, serviceWorkers: 'block' });
  const user = { id: 3, username: 'labs-fixture', name: 'Étudiant test', role: 'student', account_status: 'approved', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 3, language: 'fr' };
  const sessions = [], writes = [], errors = [];
  await context.addInitScript(() => { window.EventSource = undefined; localStorage.setItem('campuslink-prototype-v1:language', '"fr"'); localStorage.setItem('campuslink-prototype-v1:theme', '"dark"'); localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true'); });
  await context.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'flaa', name: 'Faculté test' }, resources: [], notifications: [], announcements: [], messages: [], saved: [], history: [], channels: [] } });
    if (path === '/api/labs' && req.method() === 'GET') return route.fulfill({ json: { sessions, policy: LABS_POLICY, executionAvailable: false, languages } });
    if (path === '/api/labs' && req.method() === 'POST') {
      const body = req.postDataJSON(); writes.push({ path, body });
      const voluntaryXp = body.language === 'javascript' && body.voluntaryXp;
      const session = { id: crypto.randomUUID(), language: body.language, voluntaryXp, potential: voluntaryXp ? 10 : 0, source: '', result: {}, revisions: 0, updatedAt: new Date().toISOString(), completedAt: null, rewardedPoints: 0 };
      sessions.push(session); return route.fulfill({ status: 201, json: { session } });
    }
    const action = /^\/api\/labs\/([^/]+)\/(check|complete)$/.exec(path);
    if (action) {
      const session = sessions.find(item => item.id === action[1]), body = req.postDataJSON(); writes.push({ path, body });
      if (action[2] === 'check') { session.source = body.source; session.result = await validateLabSource(session.language, body.source); session.revisions++; if (session.voluntaryXp && session.result.status === 'syntax_error') session.potential = Math.max(0, session.potential - 2); }
      else session.completedAt = new Date().toISOString();
      return route.fulfill({ json: { session, reason: 'practice_not_enabled' } });
    }
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage(); activePage = page; page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL + '/app/labs'); await expect(page.getByRole('heading', { name: 'Campus Labs', exact: true })).toBeVisible();
  return { context, page, writes, sessions, errors };
}
async function fits(page) {
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
}
async function scenario(name, run) { await run(); passed.push(name); console.log('PASS ' + name); }
try {
  await scenario('Voluntary practice shows actual parser errors, retains prior potential and never runs hostile code', async () => {
    const f = await fixture(390);
    try {
      assert.deepEqual(f.writes, [], 'Opening Labs must not start an XP session.');
      await f.page.getByLabel('Participer volontairement aux XP de pratique JavaScript').check();
      await f.page.getByLabel('Votre code').fill('const x = ;');
      await f.page.getByRole('button', { name: 'Vérifier la syntaxe', exact: true }).click();
      await expect(f.page.locator('.labs-result')).toContainText('Ligne 1');
      await expect(f.page.locator('.labs-xp-status')).toContainText('8 / 10 XP');
      await f.page.getByLabel('Votre code').fill('globalThis.labsExecuted=true; while(true) {}');
      await expect(f.page.getByRole('button', { name: 'Terminer la session', exact: true })).toBeDisabled();
      await f.page.getByRole('button', { name: 'Vérifier la syntaxe', exact: true }).click();
      await expect(f.page.locator('.labs-result')).toContainText('Syntaxe valide');
      assert.equal(await f.page.evaluate(() => window.labsExecuted), undefined);
      await fits(f.page);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await scenario('JSON has actual validation, and language choices follow this server’s capabilities', async () => {
    const f = await fixture(1280, ['javascript', 'json']);
    try {
      await chooseOption(f.page.getByLabel('Langage', { exact: true }), 'json');
      await expect(f.page.getByLabel('Participer volontairement aux XP de pratique JavaScript')).toBeDisabled();
      await f.page.getByRole('button', { name: 'Vérifier la syntaxe', exact: true }).click();
      await expect(f.page.locator('.labs-result')).toContainText('Syntaxe valide');
      await expect(f.page.locator('.labs-sidebar')).toContainText('Indisponibles sur ce serveur : Python · C · C++');
      await f.page.getByLabel('Langage', { exact: true }).click();
      for (const language of ['python', 'c', 'cpp']) await expect(f.page.getByRole('listbox').locator(`[data-value="${language}"]`)).toHaveAttribute('aria-disabled', 'true');
      await f.page.keyboard.press('Escape');
      assert.equal(f.sessions[0].voluntaryXp, false);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  for (const [language, label, invalid] of [['python', 'Python', 'def moyenne(valeurs)\n    return 0'], ['c', 'C', 'int main(void) { return 0;'], ['cpp', 'C++', 'int main() { return 0;']]) {
    await scenario(`${label} shows real parser diagnostics and restores private sessions without JavaScript XP`, async () => {
      const f = await fixture(390);
      try {
        await f.page.getByLabel('Participer volontairement aux XP de pratique JavaScript').check();
        await chooseOption(f.page.getByLabel('Langage', { exact: true }), language);
        await expect(f.page.getByLabel('Participer volontairement aux XP de pratique JavaScript')).not.toBeChecked();
        await expect(f.page.getByLabel('Participer volontairement aux XP de pratique JavaScript')).toBeDisabled();
        const original = await f.page.getByLabel('Votre code').inputValue();
        await f.page.getByRole('button', { name: 'Vérifier la syntaxe', exact: true }).click();
        await expect(f.page.locator('.labs-result')).toContainText('Syntaxe valide');
        assert.equal(f.sessions[0].language, language);
        assert.equal(f.sessions[0].voluntaryXp, false);
        assert.equal(f.sessions[0].potential, 0);
        await f.page.getByLabel('Votre code').fill(invalid);
        await f.page.getByRole('button', { name: 'Vérifier la syntaxe', exact: true }).click();
        await expect(f.page.locator('.labs-result')).toContainText('Ligne');
        assert.equal(f.sessions[0].result.status, 'syntax_error');
        await f.page.getByRole('button', { name: 'Nouvelle session', exact: true }).click();
        await f.page.locator('.labs-session-list').getByRole('button').filter({ has: f.page.getByText(label, { exact: true }) }).click();
        await expect(f.page.getByLabel('Votre code')).toHaveValue(invalid);
        await f.page.getByLabel('Votre code').fill(original);
        await f.page.getByRole('button', { name: 'Vérifier la syntaxe', exact: true }).click();
        await expect(f.page.locator('.labs-result')).toContainText('Syntaxe valide');
        await f.page.getByRole('button', { name: 'Terminer la session', exact: true }).click();
        await expect(f.page.locator('.labs-alert')).toContainText('Session enregistrée');
        await expect(f.page.getByLabel('Votre code')).toBeDisabled();
        await fits(f.page); assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
  }
  await scenario('Mobile graph controls plot deterministic functions, show values and reject executable expressions', async () => {
    const f = await fixture(390);
    try {
      await f.page.getByRole('tab', { name: 'Graphiques', exact: true }).click();
      await f.page.getByLabel('f(x)', { exact: true }).fill('x^2 - 1');
      await f.page.getByRole('button', { name: 'Tracer', exact: true }).click();
      await expect(f.page.getByRole('img', { name: 'f(x) = x^2 - 1' })).toBeVisible();
      assert.ok((await f.page.locator('.labs-function').getAttribute('d')).includes('L'));
      await f.page.getByText('Consulter quelques valeurs', { exact: true }).click();
      await expect(f.page.locator('.labs-values table')).toBeVisible();
      await f.page.getByLabel('f(x)', { exact: true }).fill('window.alert(1)');
      await f.page.getByRole('button', { name: 'Tracer', exact: true }).click();
      await expect(f.page.getByRole('alert')).toContainText('Expression invalide');
      await fits(f.page); assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  writeFileSync('test-results/labs-browser-report.json', JSON.stringify({ passed }, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: 'test-results/labs-browser-failure.png' }).catch(() => {});
  writeFileSync('test-results/labs-browser-report.json', JSON.stringify({ passed, error: error.message }, null, 2)); throw error;
} finally { await browser.close(); }
