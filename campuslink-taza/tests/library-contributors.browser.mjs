import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { chooseOption } from './ui.helpers.mjs';

const connection = process.env.CAMPUS_TEST_DATABASE_URL;
assert.ok(connection && ['127.0.0.1', 'localhost'].includes(new URL(connection).hostname), 'This integration suite requires an explicit local PostgreSQL database.');
Object.assign(process.env, { DATABASE_URL: connection, GOOGLE_OAUTH_ENABLED: 'false', WEB_PUSH_PUBLIC_KEY: '', WEB_PUSH_PRIVATE_KEY: '', CRON_SECRET: '', COOKIE_SECURE: 'false' });
const { createTestApp } = await import('./backend-helpers.mjs');
const { createServer } = await import('vite');
const { makePdf } = await import('../server/seed.js');
const env = await createTestApp({ appOrigin: 'http://127.0.0.1:5184' });
const server = env.app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:5184';
const vite = await createServer({ server: { host: '127.0.0.1', port: 5184, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${server.address().port}`, changeOrigin: false } } } });
await vite.listen();
const browser = await chromium.launch({ headless: true });
const output = 'test-results/library-contributors';
await mkdir(output, { recursive: true });
const report = { passed: [], layouts: [], errors: [] };
const recordPass = report.passed.push.bind(report.passed);
report.passed.push = value => { console.log(`PASS: ${value}`); return recordPass(value); };
const apiOrigin = `http://127.0.0.1:${server.address().port}/api`;
async function request(path, cookie, options = {}) {
  const multipart = options.body instanceof FormData;
  const response = await fetch(apiOrigin + path, { ...options, headers: { cookie: cookie || '', ...(options.body && !multipart ? { 'content-type': 'application/json' } : {}), ...options.headers }, body: options.body && !multipart ? JSON.stringify(options.body) : options.body });
  const data = await response.json();
  return { response, data };
}
async function login(username, password = 'Campus2026!') {
  const { response, data } = await request('/login', '', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200, JSON.stringify(data));
  return response.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session=')).split(';')[0];
}
async function contextFor(cookie, width = 1440, language = 'fr', theme = 'dark') {
  const session = env.auth.sessions.get(cookie.slice(cookie.indexOf('=') + 1));
  await env.db.prepare('UPDATE users SET language=? WHERE auth_user_id=?').run(language, session.authUserId);
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', hasTouch: width < 900 });
  const split = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin }]);
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { language, theme });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  return { context, page };
}
async function fits(page, label) {
  const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
    controls: [...document.querySelectorAll('.library-module-folder,.library-category-folder,.library-contributor-folder,.catalog-module-row,.catalog-scope-controls,.upload-modal,.official-module-selector')].filter(node => node.getClientRects().length).map(node => {
      const rect = node.getBoundingClientRect(); return { class: node.className, left: rect.left, right: rect.right, width: rect.width, scroll: node.scrollWidth, client: node.clientWidth };
    }) }));
  assert.ok(geometry.scroll <= geometry.width + 1, `${label}: horizontal overflow ${JSON.stringify(geometry)}`);
  for (const item of geometry.controls) assert.ok(item.left >= -1 && item.right <= geometry.width + 1 && item.scroll <= item.client + 2, `${label}: clipped control ${JSON.stringify(item)}`);
  report.layouts.push({ label, width: geometry.width, scroll: geometry.scroll, controls: geometry.controls.length });
}
async function expectIds(page, ids) {
  await expect(page.locator('.document-card')).toHaveCount(ids.length);
  for (const id of ids) await expect(page.locator(`#resource-${id}`)).toBeVisible();
}
try {
  const users = {};
  for (const [username, name] of [['catalog.x', 'Student X'], ['catalog.y', 'Student Y'], ['catalog.z', 'Student X']]) {
    users[username] = await env.db.prepare("INSERT INTO users(username,name,faculty_id,filiere_id,current_semester,account_status) VALUES (?,?,'fsa','data_science',5,'approved') RETURNING *").get(username, name);
    await env.auth.bindUser(users[username].id);
  }
  const cookies = {};
  for (const username of Object.keys(users)) cookies[username] = await login(username);
  const adminCookie = await login('admin', 'Admin2026!');
  const modules = [];
  for (const name of ['Probabilités et Statistiques', 'Analyse numérique', 'Analyse 1', 'Analyse 4']) {
    const result = await request('/admin/modules', adminCookie, { method: 'POST', body: { faculty_id: 'fsa', filiere_id: 'data_science', semester: 5, name, curriculum_source: 'Synthetic local test curriculum; not a real official curriculum', confirmed: true } });
    assert.equal(result.response.status, 201, JSON.stringify(result.data)); modules.push(result.data.module);
  }
  const main = modules[0], ids = { courses: [], tp: [], peer: [] };
  async function upload(username, category, part, path, pdf = false) {
    const form = new FormData();
    for (const [key, value] of Object.entries({ title: path.split('/').at(-1), category, resource_type: category, module_id: main.id, semester: 5, filiere_id: 'data_science', part_number: part, relative_path: path, library_visible: true, publish_message: false, academic_year: '2026/2027' })) form.set(key, String(value));
    form.set('file', new Blob([pdf ? makePdf('Synthetic library preview', [randomUUID()]) : Buffer.from(`Synthetic local test ${randomUUID()}`)], { type: pdf ? 'application/pdf' : 'text/plain' }), path.split('/').at(-1));
    const result = await request('/uploads', cookies[username], { method: 'POST', body: form });
    assert.equal(result.response.status, 201, JSON.stringify(result.data)); return result.data.resource.id;
  }
  ids.courses.push(await upload('catalog.x', 'courses', '1', 'Chapitre 1.pdf', true));
  ids.courses.push(await upload('catalog.x', 'courses', '2', 'Notes/Chapitre 2.txt'));
  ids.courses.push(await upload('catalog.x', 'courses', '3', 'Notes/Suite/Cours complet.txt'));
  ids.tp.push(await upload('catalog.x', 'tp', '1', 'TP 01.txt'));
  ids.tp.push(await upload('catalog.x', 'tp', '2', 'Notes/TP 02.txt'));
  ids.peer.push(await upload('catalog.y', 'courses', '1', 'Chapitre 1.txt'));
  const onlyTP = await upload('catalog.z', 'tp', '1', 'TP 01.txt');
  report.passed.push('Real upload API stores 3 Cours + 2 TP under canonical module ID; independent students can use matching chapter/path metadata.');
  const url = (category = '', contributor = '', folder = '') => origin + '/app/library?' + new URLSearchParams({ semester: '5', module: `id:${main.id}`, ...(category ? { category } : {}), ...(contributor ? { contributor: String(contributor) } : {}), ...(folder ? { folder } : {}) });
  const { page, context } = await contextFor(cookies['catalog.y']);
  await page.goto(url());
  await expect(page.locator('.library-category-folder')).toHaveCount(7);
  await expect(page.locator('.document-card')).toHaveCount(0);
  await page.locator('.library-category-folder[data-category="courses"]').click();
  await expect(page.locator('.library-contributor-folder')).toHaveCount(2);
  await expect(page.locator(`.library-contributor-folder[data-contributor="${users['catalog.x'].id}"]`)).toContainText('3');
  await expect(page.locator(`.library-contributor-folder[data-contributor="${users['catalog.z'].id}"]`)).toHaveCount(0);
  await page.locator(`.library-contributor-folder[data-contributor="${users['catalog.x'].id}"]`).click();
  await expectIds(page, [ids.courses[0]]);
  await expect(page.locator(`#resource-${ids.courses[0]} h3`)).toHaveText('PROBABILITÉS ET STATISTIQUES');
  await page.locator('.library-uploaded-folder').click();
  await expectIds(page, [ids.courses[1]]);
  await page.locator('.library-uploaded-folder').click();
  await expectIds(page, [ids.courses[2]]);
  await page.goBack(); await expectIds(page, [ids.courses[1]]);
  await page.goForward(); await expectIds(page, [ids.courses[2]]);
  await page.reload(); await expectIds(page, [ids.courses[2]]);
  report.passed.push('Cours contributors/counts isolated; TP-only contributor absent; nested folders and Back/Forward/reload retain category and real uploader ID.');
  await page.goto(url('tp'));
  await expect(page.locator('.library-contributor-folder')).toHaveCount(2);
  await page.locator(`.library-contributor-folder[data-contributor="${users['catalog.x'].id}"]`).click();
  await expectIds(page, [ids.tp[0]]);
  await page.locator('.library-uploaded-folder').click(); await expectIds(page, [ids.tp[1]]);
  const denied = await request(`/resources/${ids.tp[0]}`, cookies['catalog.y'], { method: 'DELETE' });
  assert.ok([403, 404].includes(denied.response.status));
  const stored = await env.db.prepare('SELECT removed,author_id,module_id FROM resources WHERE id=?').get(ids.tp[0]);
  assert.equal(stored.removed, 0); assert.equal(stored.author_id, users['catalog.x'].id); assert.equal(stored.module_id, main.id);
  report.passed.push('Peer browses another student’s TP; peer delete denied and ownership/canonical association preserved.');
  await page.goto(url('courses', users['catalog.x'].id));
  await expectIds(page, [ids.courses[0]]);
  await page.locator(`#resource-${ids.courses[0]} .document-main`).click();
  await expect(page.locator('.modal[role="dialog"]')).toBeVisible();
  await page.locator('.modal-header .close-control').click();
  await expectIds(page, [ids.courses[0]]);
  await expect(page).toHaveURL(value => value.searchParams.get('category') === 'courses' && value.searchParams.get('contributor') === String(users['catalog.x'].id));
  report.passed.push('Opening and closing the existing PDF preview preserves module/category/contributor navigation.');
  await page.locator('.page-actions .btn').click();
  const modal = page.locator('.upload-modal');
  await modal.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: 'Fuzzy selector.txt', mimeType: 'text/plain', buffer: Buffer.from(`Synthetic explicit selection ${randomUUID()}`) });
  await modal.getByRole('button', { name: /^Classer les documents/ }).click();
  const batch = modal.locator('.upload-batch');
  const moduleInput = batch.getByRole('combobox', { name: /^Module/ });
  await moduleInput.fill('analyse nimeriqe');
  await expect(batch.getByRole('option', { name: 'Analyse numérique', exact: true })).toBeVisible();
  assert.equal((await env.db.prepare("SELECT COUNT(*) AS n FROM modules WHERE faculty_id='fsa' AND filiere_id='data_science' AND semester=5").get()).n, 4);
  await batch.getByRole('option', { name: 'Analyse numérique', exact: true }).click();
  await batch.getByRole('button', { name: /Appliquer aux/ }).click();
  const row = modal.locator('.upload-file');
  if (!(await row.locator('.upload-file-editor').count())) await row.getByRole('button', { name: /^Modifier / }).click();
  await chooseOption(row.locator('.upload-file-editor').getByLabel(/^Part\/Chapitre/), '1');
  await modal.getByRole('button', { name: /^Vérifier/ }).click();
  await expect(modal.locator('.upload-review-list')).toContainText('Analyse numérique');
  await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
  await expect(modal.getByRole('heading', { name: 'Documents ajoutés', exact: true })).toBeVisible();
  const fuzzyUpload = await env.db.prepare("SELECT module_id,module FROM resources WHERE filename='Fuzzy selector.txt'").get();
  assert.equal(fuzzyUpload.module_id, modules[1].id);
  assert.equal(fuzzyUpload.module, 'Analyse numérique');
  await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
  report.passed.push('Typing analyse nimeriqe suggests Analyse numérique; explicit confirmation uploads to its existing ID with no module creation.');
  const directoryPath = resolve(process.env.CAMPUS_TEST_WORK_DIR || 'work/library-contributors', 'Dossier complet');
  await mkdir(resolve(directoryPath, 'Suite'), { recursive: true });
  await writeFile(resolve(directoryPath, 'A.txt'), `Synthetic folder ${randomUUID()}`);
  await writeFile(resolve(directoryPath, 'Suite', 'B.txt'), `Synthetic nested folder ${randomUUID()}`);
  await page.goto(url('courses', users['catalog.x'].id));
  await page.locator('.page-actions .btn').click();
  const folderModal = page.locator('.upload-modal');
  await folderModal.locator('input[webkitdirectory]').setInputFiles(directoryPath);
  await folderModal.getByRole('button', { name: /^Classer les documents/ }).click();
  await folderModal.locator('.upload-batch').getByRole('button', { name: /Appliquer aux/ }).click();
  for (let index = 0; index < 2; index++) {
    const fileRow = folderModal.locator('.upload-file').nth(index);
    if (!(await fileRow.locator('.upload-file-editor').count())) await fileRow.getByRole('button', { name: /^Modifier / }).click();
    await chooseOption(fileRow.locator('.upload-file-editor').getByLabel(/^Part\/Chapitre/), String(index + 11));
  }
  await folderModal.getByRole('button', { name: /^Vérifier/ }).click();
  await folderModal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
  await expect(folderModal.getByRole('heading', { name: 'Documents ajoutés', exact: true })).toBeVisible();
  const uploadedFolder = await env.db.prepare("SELECT author_id,module_id,category,relative_path FROM resources WHERE relative_path LIKE 'Dossier complet/%' ORDER BY relative_path").all();
  assert.deepEqual(uploadedFolder.map(item => item.relative_path), ['Dossier complet/A.txt', 'Dossier complet/Suite/B.txt']);
  assert.ok(uploadedFolder.every(item => item.author_id === users['catalog.y'].id && item.module_id === main.id && item.category === 'courses'));
  await folderModal.getByRole('button', { name: 'Terminer', exact: true }).click();
  report.passed.push('Complete-folder UI upload retains nested paths and gives ownership to the current uploader, including when opened from another student’s folder.');
  for (const width of [320, 360, 375, 390, 412, 768, 1440]) for (const [language, theme] of [['fr', 'dark'], ['ar', 'light'], ['en', 'light']]) {
    const f = await contextFor(cookies['catalog.y'], width, language, theme);
    await f.page.goto(url()); await expect(f.page.locator('.library-category-folder')).toHaveCount(7); await fits(f.page, `${width}-${language}-${theme}-categories`);
    if ([320, 1440].includes(width) && language !== 'en') await f.page.screenshot({ path: `${output}/${width}-${language}-${theme}-categories.png`, fullPage: true });
    await f.page.goto(url('tp')); await expect(f.page.locator('.library-contributor-folder')).toHaveCount(2); await fits(f.page, `${width}-${language}-${theme}-contributors`);
    if ([320, 1440].includes(width) && language !== 'en') await f.page.screenshot({ path: `${output}/${width}-${language}-${theme}-contributors.png`, fullPage: true });
    await f.page.goto(url('tp', users['catalog.x'].id)); await expectIds(f.page, [ids.tp[0]]); await fits(f.page, `${width}-${language}-${theme}-files`);
    await expect(f.page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
    if ([320, 390, 1440].includes(width) && language !== 'en') await f.page.screenshot({ path: `${output}/${width}-${language}-${theme}.png`, fullPage: true });
    await f.context.close();
  }
  report.passed.push('63 responsive hierarchy views at all requested mobile widths, tablet and desktop; FR/EN/Arabic RTL; both themes; no horizontal overflow.');
  await page.goto(url('td'));
  await expect(page.locator('.library-contributor-folder')).toHaveCount(0);
  await expect(page.locator('.document-card')).toHaveCount(0);
  await page.goto(url('tp') + '&q=Chapitre+1');
  await expect(page.locator('.library-contributor-folder')).toHaveCount(0);
  await expect(page.locator('.document-card')).toHaveCount(0);
  const endpoint = `**/api/library/modules/${main.id}`;
  let moduleRequests = 0;
  await page.route(endpoint, route => { moduleRequests++; return route.fulfill({ status: 404, json: { error: 'Optional endpoint not deployed' } }); });
  await page.goto(url());
  await expect(page.locator('.library-category-folder')).toHaveCount(7);
  assert.equal(moduleRequests, 0, 'Browsing uses the complete authorized bootstrap, independent of optional API rollout.');
  await page.unroute(endpoint);
  await page.locator('.library-category-folder[data-category="tp"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.library-contributor-folder')).toHaveCount(2);
  await page.locator(`.library-contributor-folder[data-contributor="${users['catalog.x'].id}"]`).focus();
  await page.keyboard.press('Enter');
  await expectIds(page, [ids.tp[0]]);
  report.passed.push('Category-scoped search, empty states and keyboard navigation work; an undeployed module endpoint cannot block authorized bootstrap folders.');
  await context.close();
  const admin = await contextFor(adminCookie, 320, 'fr', 'dark');
  const legacyModule = await env.db.prepare("INSERT INTO modules(faculty_id,filiere_id,semester,name) VALUES('fsa','data_science',5,'Historical verification fixture') RETURNING *").get();
  await admin.page.goto(origin + '/app/admin?tab=modules');
  await expect(admin.page.locator('.module-catalog-admin')).toBeVisible();
  await fits(admin.page, '320-admin-catalog');
  const panel = admin.page.locator('.module-catalog-admin');
  await chooseOption(panel.getByLabel('Établissement', { exact: true }), 'fsa');
  await chooseOption(panel.getByLabel('Filière', { exact: true }), 'data_science');
  await chooseOption(panel.getByLabel('Semestre', { exact: true }), '5');
  await panel.locator(`[data-module-id="${legacyModule.id}"]`).getByRole('button', { name: 'Vérifier', exact: true }).click();
  const verify = admin.page.locator('.catalog-module-modal');
  await expect(verify.getByRole('button', { name: 'Enregistrer le module vérifié' })).toBeDisabled();
  await verify.getByLabel('Source du programme officiel', { exact: true }).fill('Synthetic local verification source; not a real curriculum.');
  await verify.getByRole('checkbox').check();
  await fits(admin.page, '320-admin-verification');
  await verify.getByRole('button', { name: 'Enregistrer le module vérifié' }).click();
  await expect(verify).toHaveCount(0);
  const verified = await env.db.prepare('SELECT * FROM modules WHERE id=?').get(legacyModule.id);
  assert.equal(verified.catalog_status, 'official'); assert.equal(verified.name, legacyModule.name);
  await panel.locator(`[data-module-id="${legacyModule.id}"]`).getByRole('button', { name: 'Consulter', exact: true }).focus();
  await expect(panel.locator(`[data-module-id="${legacyModule.id}"]`).getByRole('button')).toBeFocused();
  await admin.context.close();
  report.passed.push('Administrator catalog and verification fit 320px; crossfaculty selection, required source/confirmation, keyboard focus and ID-preserving verification work.');
  assert.deepEqual(report.errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close(); await vite.close(); env.app.locals.endStreams(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); await env.close();
}
