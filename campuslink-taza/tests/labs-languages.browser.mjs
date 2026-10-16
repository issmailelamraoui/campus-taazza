import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createTestApp } from './backend-helpers.mjs';
import { chooseOption } from './ui.helpers.mjs';

if (!process.env.CAMPUS_TEST_DATABASE_URL) throw new Error('Set CAMPUS_TEST_DATABASE_URL to an isolated test database before running this browser suite.');
const env = await createTestApp(), server = env.app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(executablePath) ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [], errors = [];
mkdirSync('test-results', { recursive: true });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await context.addInitScript(() => { if (window !== window.top) return; window.EventSource = undefined; localStorage.setItem('campuslink-prototype-v1:language', '"fr"'); localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true'); });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/login');
  await page.locator('#login-username').fill('yassine'); await page.locator('#login-password').fill('Campus2026!');
  await page.locator('form.login-form button[type=submit]').click(); await expect(page).toHaveURL(origin + '/app');
  await page.goto(origin + '/app/labs'); await expect(page.getByRole('heading', { name: 'Campus Labs', exact: true })).toBeVisible();
  const available = await context.request.get(origin + '/api/labs'); assert.equal(available.status(), 200);
  const capabilities = await available.json(); assert.equal(capabilities.executionAvailable, true);
  for (const id of ['python', 'c', 'cpp']) assert.ok(capabilities.languages.includes(id), `${id} must have a real checker.`);
  const initialXp = (await env.db.prepare("SELECT COUNT(*)::integer AS count FROM xp_events WHERE user_id=3 AND category='practice'").get()).count;
  const peer = await browser.newContext({ serviceWorkers: 'block' });
  const peerLogin = await peer.request.post(origin + '/api/login', { data: { username: 'sara', password: 'Campus2026!' } }); assert.equal(peerLogin.status(), 200);
  for (const [language, label, invalid] of [['python', 'Python', 'def moyenne(valeurs)\n    return 0'], ['c', 'C', 'int main(void) { return 0;'], ['cpp', 'C++', 'int main() { return 0;']]) {
    await chooseOption(page.getByLabel('Langage', { exact: true }), language);
    await expect(page.getByLabel('Participer volontairement aux XP de pratique JavaScript')).toBeDisabled();
    const source = await page.locator('.cm-line').allTextContents().then(lines => lines.join('\n'));
    await page.getByRole('button', { name: 'Exécuter', exact: true }).click();
    await expect(page.locator('.labs-result')).toContainText('Syntaxe vérifiée'); await expect(page.getByRole('button', { name: 'Exécuter', exact: true })).toBeEnabled({ timeout: 60000 }); await expect(page.locator('.labs-console-output')).toContainText('14');
    const current = (await (await context.request.get(origin + '/api/labs')).json()).sessions.find(session => session.language === language);
    assert.ok(current); assert.equal(current.source, source); assert.equal(current.voluntaryXp, false); assert.equal(current.potential, 0);
    const denied = await peer.request.get(origin + '/api/labs/' + current.id); assert.equal(denied.status(), 404);
    await env.db.prepare('UPDATE labs_sessions SET last_checked_at=NULL WHERE id=?').run(current.id);
    await page.getByLabel('Votre code').fill(invalid); await page.getByRole('button', { name: 'Exécuter', exact: true }).click();
    await expect(page.locator('.labs-result')).toContainText('Ligne'); await expect(page.getByRole('button', { name: 'Exécuter', exact: true })).toBeEnabled({ timeout: 60000 });
    const malformed = await env.db.prepare('SELECT last_result FROM labs_sessions WHERE id=?').get(current.id); assert.equal(malformed.last_result.status, 'syntax_error');
    await env.db.prepare('UPDATE labs_sessions SET last_checked_at=NULL WHERE id=?').run(current.id);
    await page.getByLabel('Votre code').fill(source); await page.getByRole('button', { name: 'Exécuter', exact: true }).click();
    await expect(page.locator('.labs-result')).toContainText('Syntaxe vérifiée'); await expect(page.getByRole('button', { name: 'Exécuter', exact: true })).toBeEnabled({ timeout: 60000 }); await expect(page.locator('.labs-console-output')).toContainText('14');
    await page.getByRole('button', { name: 'Terminer la session', exact: true }).click(); await expect(page.locator('.labs-code-editor')).toHaveAttribute('data-readonly', 'true');
    await page.reload(); await expect(page.getByLabel('Langage', { exact: true })).toBeEnabled();
    await page.locator('.labs-session-list').getByRole('button').filter({ has: page.getByText(label, { exact: true }) }).click();
    assert.equal((await page.locator('.cm-line').allTextContents()).join('\n'), source); await expect(page.locator('.labs-code-editor')).toHaveAttribute('data-readonly', 'true');
    const record = await env.db.prepare('SELECT completed_at,rewarded_points FROM labs_sessions WHERE id=?').get(current.id); assert.ok(record.completed_at); assert.equal(record.rewarded_points, 0);
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })); assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
    const name = `${label} validates and diagnoses real syntax, persists a private completed session, and fits a phone`; passed.push(name); console.log('PASS ' + name);
  }
  assert.equal((await env.db.prepare("SELECT COUNT(*)::integer AS count FROM xp_events WHERE user_id=3 AND category='practice'").get()).count, initialXp);
  assert.deepEqual(errors, []); await peer.close(); await context.close();
  writeFileSync('test-results/labs-languages-browser-report.json', JSON.stringify({ passed }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/labs-languages-browser-failure.png', fullPage: true }).catch(() => {});
  writeFileSync('test-results/labs-languages-browser-report.json', JSON.stringify({ passed, error: error.message, errors }, null, 2)); throw error;
} finally {
  await browser.close(); env.app.locals.endStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await env.close();
}
