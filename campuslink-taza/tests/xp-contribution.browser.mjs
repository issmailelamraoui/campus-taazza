import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, firefox, expect } from '@playwright/test';
import { createTestEnvironment } from './backend-helpers.mjs';
import { createApp } from '../server/app.js';

// All application requests use a disposable PostgreSQL schema, memory storage,
// and injected identity sessions. Never point this fixture at the live API.
assert.ok(process.env.CAMPUS_TEST_DATABASE_URL, 'A dedicated CAMPUS_TEST_DATABASE_URL is required.');
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const engine = process.env.CAMPUSLINK_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox'].includes(engine), 'Use chromium or firefox for CAMPUSLINK_TEST_BROWSER.');
const env = await createTestEnvironment({ demo: false });
const users = {}, cookies = {}, passed = [], errors = [];
let browser, server, app, origin;

async function request(path, { user = 'xp.desktop', method = 'GET', body, form } = {}) {
  const response = await fetch(origin + '/api' + path, {
    method,
    headers: { ...(cookies[user] ? { cookie: cookies[user] } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function upload(user, number) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ title: `XP contribution ${number}`, category: 'courses', resource_type: 'courses', channel: 'general', filiere_id: 'mathematics', semester: '1', module: `XP ${user}`, part_number: String(number), academic_year: '2026/2027', library_visible: 'true', publish_message: 'false' })) form.set(key, value);
  form.set('file', new Blob([`Useful isolated study notes ${user} document ${number}.`], { type: 'text/plain' }), `study-${number}.txt`);
  const result = await request('/uploads', { user, method: 'POST', form });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.xp_awarded, 5);
  return result.data.resource;
}
async function refreshVisiblePage(page) {
  // The focus event is the application's real refresh path after a student
  // returns from another tab; no reload or direct component manipulation.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function proxyAPI(context) {
  await context.route('**/api/**', async route => {
    const source = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: origin + source.pathname + source.search }) });
  });
}
const badge = page => page.locator('.xp-achievement[data-achievement="library_contributor"]');
async function xpDisplayed(page, total, files, earned) {
  await expect(page.getByTestId('xp-total').locator('strong')).toHaveText(String(total));
  await expect(page.locator('.xp-level')).toHaveAttribute('data-total-xp', String(total));
  const progress = page.locator('.xp-level progress');
  await expect(progress).toHaveAttribute('value', String(total));
  await expect(progress).toHaveAttribute('max', '100');
  await expect(badge(page)).toHaveClass(earned ? /\bearned\b/ : /^(?!.*\bearned\b)/);
  await expect(badge(page).locator('dd').first()).toHaveText(`${files} / ${earned ? 20 : 5}`);
  const bounds = await progress.boundingBox();
  assert.ok(bounds && bounds.width >= 100 && bounds.height >= 8, 'The XP progress bar must occupy visible space.');
}
async function fits(page, name) {
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('.xp-page');
    const controls = [...root.querySelectorAll('button, progress, article')].map(node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: node.clientWidth, scrollWidth: node.scrollWidth };
    }).filter(rect => rect.width > 0);
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, controls };
  });
  assert.ok(geometry.scrollWidth <= geometry.width + 1, `${name}: horizontal page overflow ${JSON.stringify(geometry)}`);
  assert.ok(geometry.controls.every(rect => rect.left >= -1 && rect.right <= geometry.width + 1 && rect.scrollWidth <= rect.width + 2), `${name}: XP content and controls must fit the viewport.`);
}
async function uploadThroughUI(page, user, number) {
  await page.goto(baseURL + '/app/library');
  await page.locator('.page-actions').getByRole('button', { name: 'Partager un document', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: `study-${number}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Useful isolated study notes ${user} document ${number}.`) });
  await modal.getByRole('button', { name: /^Classer les documents/ }).click();
  const batch = modal.locator('.upload-batch');
  await batch.getByLabel(/^Module/).fill(`XP ${user}`);
  await batch.getByRole('button', { name: /Appliquer aux/ }).click();
  const row = modal.locator('.upload-file').first();
  if (!(await row.locator('.upload-file-editor').count())) await row.getByRole('button', { name: /^Modifier / }).click();
  await row.getByLabel(/^Part\/Chapitre/).fill(String(number));
  await modal.getByRole('button', { name: /^Vérifier/ }).click();
  await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
  await expect(modal.getByRole('heading', { name: 'Documents ajoutés', exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
  await page.locator('a[href="/app/xp"]').filter({ visible: true }).first().click();
}
async function confirmThroughAdminUI(reportId) {
  // A distinct browser context preserves the student's mounted XP view and
  // cookies while the administrator makes the actual moderation decision.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  try {
    await context.addInitScript(() => {
      window.EventSource = undefined;
      localStorage.setItem('campuslink-prototype-v1:theme', '"dark"');
      localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
      localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    });
    const [name, value] = cookies.admin.split('=');
    await context.addCookies([{ name, value, url: baseURL }]);
    await proxyAPI(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL + '/app/admin?tab=reports');
    await page.locator('.admin-report-row').filter({ hasText: 'Please check this file contribution' }).getByRole('button', { name: 'Examiner', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Examiner un signalement', exact: true })).toBeVisible();
    await expect(dialog.locator('.admin-report-xp-notice')).toContainText('Le simple examen ou le classement sans suite ne retire aucun point.');
    await dialog.getByRole('button', { name: 'Marquer comme examiné', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal((await request('/xp')).data.xp, 25, 'Marking a report reviewed must preserve the contribution reward.');
    await page.locator('.admin-report-row').filter({ hasText: 'Please check this file contribution' }).getByRole('button', { name: 'Examiner', exact: true }).click();
    await expect(dialog.locator('.admin-report-xp-notice')).toBeVisible();
    await page.screenshot({ path: `test-results/xp-contribution/${engine}-admin-confirmation.png` });
    const decision = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/reports/${reportId}` && response.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: 'Confirmer le signalement', exact: true }).click();
    const response = await decision;
    assert.equal(response.status(), 200, await response.text());
    assert.equal((await response.json()).xp_revoked, 5);
    await expect(dialog).toHaveCount(0);
  } finally { await context.close(); }
}

try {
  for (const username of ['admin', 'xp.desktop', 'xp.mobile', 'xp.arabic', 'xp.peer']) {
    users[username] = await env.db.prepare('INSERT INTO users(username,name,role,faculty_id,filiere_id,current_semester) VALUES(?,?,?,?,?,1) RETURNING *').get(username, username, username === 'admin' ? 'global_admin' : 'student', 'fsa', 'mathematics');
    await env.auth.bindUser(users[username].id);
  }
  app = await createApp({ db: env.db, storage: env.storage, auth: env.auth, appOrigin: baseURL });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const username of Object.keys(users)) {
    const login = await request('/login', { user: username, method: 'POST', body: { username, password: username === 'admin' ? 'Admin2026!' : 'Campus2026!' } });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    cookies[username] = login.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session=')).split(';')[0];
  }
  browser = await ({ chromium, firefox })[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
  await mkdir('test-results/xp-contribution', { recursive: true });
  for (const settings of [
    { user: 'xp.desktop', width: 1440, height: 900, theme: 'dark', language: 'fr' },
    { user: 'xp.mobile', width: 390, height: 844, theme: 'light', language: 'fr' },
    { user: 'xp.arabic', width: 320, height: 640, theme: 'dark', language: 'ar' },
  ]) {
    const { user, language, theme, width, height } = settings;
    await env.db.prepare('UPDATE users SET language=? WHERE id=?').run(language, users[user].id);
    const resources = [];
    for (let number = 1; number <= 4; number++) resources.push(await upload(user, number));
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(({ theme, language }) => {
      window.EventSource = undefined;
      localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
      localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
      localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    }, { theme, language });
    const [name, value] = cookies[user].split('=');
    await context.addCookies([{ name, value, url: baseURL }]);
    await proxyAPI(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    const scenario = `${engine}-${width}-${theme}-${language}`;
    try {
      await page.goto(baseURL + '/app/xp');
      await xpDisplayed(page, 20, 4, false);
      await fits(page, scenario);
      await expect(page.locator('.xp-file-policy')).toContainText('25');
      if (user === 'xp.desktop') {
        await uploadThroughUI(page, user, 5);
        resources.push((await env.db.prepare('SELECT id FROM resources WHERE author_id=? ORDER BY id DESC LIMIT 1').get(users[user].id)));
      } else {
        resources.push(await upload(user, 5));
        await refreshVisiblePage(page);
      }
      await xpDisplayed(page, 25, 5, true);
      await page.screenshot({ path: `test-results/xp-contribution/${scenario}-earned.png`, fullPage: true });
      const reported = resources.at(-1);
      const report = await request('/reports', { user: 'xp.peer', method: 'POST', body: { target_type: 'resource', target_id: reported.id, reason: 'Please check this file contribution', details: 'Isolated regression case' } });
      assert.equal(report.status, 201, JSON.stringify(report.data));
      await refreshVisiblePage(page);
      await xpDisplayed(page, 25, 5, true);
      assert.equal((await request('/xp', { user })).data.xp, 25, 'An unconfirmed report cannot penalize the uploader.');
      if (user === 'xp.desktop') await confirmThroughAdminUI(report.data.id);
      else {
        const confirmed = await request(`/admin/reports/${report.data.id}`, { user: 'admin', method: 'PATCH', body: { status: 'resolved', note: 'Reviewed and confirmed by administration.' } });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
      }
      await refreshVisiblePage(page);
      await xpDisplayed(page, 20, 4, false);
      await fits(page, scenario + '-revoked');
      await expect(page.locator('.xp-events .is-revoked, .xp-event.is-revoked, [data-xp-status="revoked"]')).toHaveCount(1);
      if (language === 'ar') {
        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        assert.ok(!(await page.locator('body').innerText()).includes('الحرم'), 'Arabic navigation must use the neutral Campus label.');
      }
      await page.screenshot({ path: `test-results/xp-contribution/${scenario}-revoked.png`, fullPage: true });
      passed.push(`${scenario}: actual upload raises total/bar/badge; pending report preserves XP; confirmed report revokes XP and badge without reload`);
    } catch (error) {
      await page.screenshot({ path: `test-results/xp-contribution/${scenario}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(`test-results/xp-contribution/${engine}-results.json`, JSON.stringify({ passed, errors }, null, 2));
  console.log(JSON.stringify({ passed }, null, 2));
} finally {
  await browser?.close();
  app?.locals.endStreams();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await app?.locals.close();
  await env.close();
}
