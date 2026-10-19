import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { makePdf } from '../server/seed.js';
import { chooseOption } from './ui.helpers.mjs';
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5192';
const executablePath = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(executablePath) ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = []; let activePage;
mkdirSync('test-results', { recursive: true });
async function fixture({ width = 390, manager = false, changed = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 800, hasTouch: width < 800, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const user = { id: 3, name: 'Student fixture', username: 'relations-fixture', role: 'student', account_status: 'approved', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, language: 'fr' };
  const pdf = makePdf('Actual reader fixture', ['birefringence anisotropy polarization']);
  const base = { faculty_id: 'flaa', filiere_id: 'french_studies', semester: 1, module: 'Optics fixture', version: 1, filename: 'lesson.pdf', mime: 'application/pdf', size: pdf.length, library_visible: true, author: user, academic_year: '2026/2027', academic_years: ['2026/2027'], created_at: '2026-10-11T00:00:00Z' };
  const exercise = { ...base, id: 41, title: 'TD Optics', category: 'td', resource_type: 'td', part_number: '1' }, course = { ...base, id: 42, title: 'Course Optics', category: 'courses', resource_type: 'courses', part_number: '2' }, excluded = { ...course, id: 43, title: 'Different module', module: 'History fixture' };
  const resources = [exercise, course, excluded], mappings = [], writes = [], errors = [];
  const source = (resource, page = 1) => ({ resourceId: resource.id, version: 1, page, title: resource.title, filename: resource.filename, part: resource.part_number, href: `/app/library?document=${resource.id}&page=${page}&version=1` });
  await context.addInitScript(() => { window.EventSource = undefined; localStorage.setItem('campuslink-prototype-v1:language', '"fr"'); localStorage.setItem('campuslink-prototype-v1:theme', '"dark"'); localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true'); });
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'flaa', name: 'Faculty fixture' }, resources, messages: [], announcements: [], notifications: [], saved: [], history: [], channels: [], members: [] } });
    if (/^\/api\/reading\/\d+\/file$/.test(path) || /^\/api\/files\/\d+$/.test(path)) return route.fulfill({ contentType: 'application/pdf', body: pdf });
    const reading = /^\/api\/reading\/(\d+)$/.exec(path);
    if (reading) { const resource = resources.find(item => item.id === Number(reading[1])); return route.fulfill({ json: { document: { ...resource, currentVersion: 1, url: `/api/reading/${resource.id}/file?version=1` }, position: null, previousPositions: [], recovery: [] } }); }
    if (path.endsWith('/position')) { const body = request.postDataJSON(); return route.fulfill({ json: { position: { ...body, revision: 1 } } }); }
    if (path === '/api/knowledge') return route.fulfill({ json: { items: [] } });
    if (path === '/api/reading') return route.fulfill({ json: { positions: [] } });
    if (path.startsWith('/api/document-index/')) { writes.push({ path, method: request.method() }); return route.fulfill({ status: 201, json: { index: { resourceId: Number(path.split('/').pop()), version: 1, status: 'ready', pageCount: 1, searchable: true } } }); }
    if (path === '/api/document-relations/41' && request.method() === 'GET') return route.fulfill({ json: { resourceId: 41, version: 1, state: 'suggestions', canVerify: manager, suggestions: [{ status: 'suggested', exercise: source(exercise), course: source(course), evidence: { lexicalScore: 9999, terms: ['birefringence', 'anisotropy', 'polarization'].map(term => ({ term, locallyRare: true })), phrases: ['birefringence anisotropy polarization'] } }], mappings, limited: false } });
    if (path === '/api/document-relations/41' && request.method() === 'POST') {
      const body = request.postDataJSON(); writes.push({ path, method: 'POST', body });
      if (changed) return route.fulfill({ status: 409, json: { error: 'Une version du document a changé. Rouvrez les versions actuelles.' } });
      const mapping = { id: 51, status: 'proposed', revision: 1, reason: body.reason, proposerId: 3, exercise: source(exercise, body.exercise_page), course: source(course, body.course_page) }; mappings.push(mapping); return route.fulfill({ status: 201, json: { mapping } });
    }
    if (path === '/api/document-relations/41/51' && request.method() === 'PATCH') { const body = request.postDataJSON(); writes.push({ path, method: 'PATCH', body }); const mapping = mappings[0]; mapping.revision++; if (body.status) mapping.status = body.status; if (body.reason) mapping.reason = body.reason; return route.fulfill({ json: { mapping } }); }
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage(); activePage = page; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/app/library?mode=study&document=41&page=1&version=1');
  await expect(page.locator('.reader-pane-active canvas')).toBeVisible();
  await page.locator('.reader-pane-active .reader-tools-toggle').click();
  const panel = page.locator('.document-relations').first(); await panel.locator('summary').click(); await expect(panel.locator('.document-relation-suggestions')).toBeVisible();
  return { page, context, panel, writes, errors, mappings };
}
async function fits(page) { const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })); assert.ok(size.scroll <= size.width + 1, JSON.stringify(size)); }
async function run(name, callback) { await callback(); passed.push(name); console.log('PASS ' + name); }
try {
  await run('Mobile page evidence, explicit preparation and scoped proposals stay separate from verification', async () => {
    const f = await fixture(); try {
      await expect(f.panel).toContainText('birefringence'); await expect(f.panel).not.toContainText('9999');
      assert.deepEqual(f.writes, [], 'Opening suggestions never indexes or proposes automatically.');
      await f.panel.getByRole('button', { name: 'Préparer la recherche de ce PDF', exact: true }).first().click();
      await expect(f.panel).toContainText('1 pages indexées');
      await f.panel.getByRole('button', { name: 'Préparer une proposition', exact: true }).click();
      const select = f.panel.getByLabel('Cours du même module', { exact: true }); await chooseOption(select, '42');
      await select.click(); await expect(f.page.getByRole('option', { name: /Different module/ })).toHaveCount(0); await f.page.keyboard.press('Escape');
      await f.panel.getByRole('button', { name: 'Préparer la recherche de ce PDF', exact: true }).last().click();
      await f.panel.getByLabel('Pourquoi ces pages sont liées', { exact: true }).fill('The course explains the shared technical terms on this page.');
      await f.panel.getByRole('button', { name: 'Envoyer la proposition', exact: true }).click();
      await expect(f.panel.locator('.document-relation-mappings')).toContainText('Proposition');
      await expect(f.panel.getByRole('button', { name: 'Vérifier le lien', exact: true })).toHaveCount(0);
      const submitted = f.writes.find(write => write.path === '/api/document-relations/41'); assert.equal(submitted.body.exercise_version, 1); assert.equal(submitted.body.course_version, 1); assert.equal(submitted.body.course_resource_id, 42);
      assert.deepEqual(f.writes.filter(write => write.path.startsWith('/api/document-index/')).map(write => write.path).sort(), ['/api/document-index/41', '/api/document-index/42']);
      await f.panel.getByRole('button', { name: 'Corriger mon explication', exact: true }).click(); await f.panel.getByLabel('Explication corrigée', { exact: true }).fill('Corrected reference to the same exact source pages.'); await f.panel.getByRole('button', { name: 'Enregistrer la correction', exact: true }).click();
      await expect(f.panel).toContainText('Corrected reference'); await fits(f.page); assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await run('Reviewer controls follow fresh server capabilities even when the displayed account role is student', async () => {
    const f = await fixture({ manager: true, width: 1280 }); try {
      await f.panel.getByRole('button', { name: 'Préparer une proposition', exact: true }).click(); await f.panel.getByLabel('Pourquoi ces pages sont liées', { exact: true }).fill('The course contains the required explanation of these technical terms.'); await f.panel.getByRole('button', { name: 'Envoyer la proposition', exact: true }).click();
      await f.panel.getByRole('button', { name: 'Vérifier le lien', exact: true }).click(); await expect(f.panel.locator('.document-relation-status')).toHaveText('Vérifiée');
      await f.panel.getByRole('button', { name: 'Rejeter le lien', exact: true }).click(); await expect(f.panel.locator('.document-relation-status')).toHaveText('Rejetée');
      assert.deepEqual(f.writes.filter(write => write.method === 'PATCH').map(write => write.body.status), ['verified', 'rejected']); assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await run('Version-change errors preserve the proposal explanation and never show a fabricated saved mapping', async () => {
    const f = await fixture({ changed: true }); try {
      await f.panel.getByRole('button', { name: 'Préparer une proposition', exact: true }).click(); const reason = 'Keep this explanation after a source version conflict.'; await f.panel.getByLabel('Pourquoi ces pages sont liées', { exact: true }).fill(reason); await f.panel.getByRole('button', { name: 'Envoyer la proposition', exact: true }).click();
      await expect(f.panel.getByRole('alert')).toContainText('version du document a changé'); await expect(f.panel.getByLabel('Pourquoi ces pages sont liées', { exact: true })).toHaveValue(reason); await expect(f.panel.locator('.document-relation-mappings')).toHaveCount(0); assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  writeFileSync('test-results/document-relations-browser-report.json', JSON.stringify({ passed }, null, 2));
} catch (error) { if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: 'test-results/document-relations-browser-failure.png', fullPage: true }).catch(() => {}); writeFileSync('test-results/document-relations-browser-report.json', JSON.stringify({ passed, error: error.message }, null, 2)); throw error; }
finally { await browser.close(); }
