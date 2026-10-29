import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Every API transport is a synthetic fixture. No accounts, PostgreSQL or R2.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
const errors = [], writes = [], dedicatedRequests = [];
const user = { id: 2, name: 'Student X', username: 'legacy.x', role: 'student', account_status: 'approved',
  faculty_id: 'fsa', filiere_id: 'mathematics', current_semester: 3, current_academic_year: '2026/2027', language: 'fr' };
const peer = { ...user, id: 3, name: 'Student Y', username: 'legacy.y' };
const resource = (id, category, extra = {}) => ({ id, title: `Document ${id}`, filename: `document-${id}.txt`,
  relative_path: `document-${id}.txt`, category, resource_type: category, module_id: 57, module: 'Informatique C',
  faculty_id: 'fsa', filiere_id: 'mathematics', semester: 3, author: user, library_visible: true,
  academic_year: '2026/2027', created_at: '2026-10-27T12:00:00Z', part_number: String(id), size: 64, mime: 'text/plain', ...extra });
const resources = [resource(101, 'courses'), resource(102, 'courses'), resource(103, 'courses'),
  resource(201, 'tp'), resource(202, 'tp', { relative_path: 'Notes/document-202.txt' }), resource(203, 'tp', { author: peer }),
  resource(901, 'courses', { module_id: 58 }), resource(902, 'courses', { faculty_id: 'feg' }),
  resource(903, 'courses', { filiere_id: 'data_science' }), resource(904, 'courses', { semester: 5 }),
  resource(905, 'courses', { library_visible: false }), resource(906, 'courses', { status: 'removed' })];
await context.addInitScript(() => {
  window.EventSource = undefined;
  localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify('fr'));
  localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify('dark'));
  localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
});
await context.route('**/api/**', route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
  if (path === '/api/session') return route.fulfill({ json: { user } });
  if (['/api/bootstrap', '/api/live'].includes(path)) return route.fulfill({ json: { user,
    faculty: { id: 'fsa', code: 'FSA', name: 'Fixture faculty' }, resources, messages: [], announcements: [],
    notifications: [], events: [], saved: [], history: [], members: [], channels: [] } });
  if (path === '/api/modules') return route.fulfill({ json: { modules: [{ id: 57, name: 'Informatique C', faculty_id: 'fsa', filiere_id: 'mathematics', semester: 3 }] } });
  if (path.startsWith('/api/library/modules/')) {
    dedicatedRequests.push(path);
    return route.fulfill({ status: 404, json: { error: 'This endpoint is absent from the legacy backend.' } });
  }
  if (['/api/reading', '/api/knowledge'].includes(path)) return route.fulfill({ json: { positions: [], items: [] } });
  errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
  return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const url = category => `${origin}/app/library?semester=3&module=id%3A57${category ? `&category=${category}` : ''}`;
async function ids(expected) {
  await expect(page.locator('.document-card')).toHaveCount(expected.length);
  for (const id of expected) await expect(page.locator(`#resource-${id}`)).toBeVisible();
}
try {
  await page.goto(url());
  await expect(page.locator('.library-category-folder')).toHaveCount(7);
  await expect(page.locator('.library-category-folder[data-category="courses"]')).toContainText('3 fichiers');
  await expect(page.locator('.library-category-folder[data-category="tp"]')).toContainText('3 fichiers');
  await ids([]);
  await expect(page.locator('.library-contributor-folder')).toHaveCount(0);
  await expect(page.getByText('Impossible de charger ce module.', { exact: true })).toHaveCount(0);
  await page.locator('.library-category-folder[data-category="courses"]').click();
  await expect(page.locator('.library-contributor-folder')).toHaveCount(1);
  await expect(page.locator('.library-contributor-folder[data-contributor="2"]')).toContainText('3 fichiers');
  await ids([]);
  await page.locator('.library-contributor-folder[data-contributor="2"]').click();
  await expect(page).toHaveURL(value => value.searchParams.get('contributor') === '2');
  await ids([101, 102, 103]);
  await page.goto(url('tp'));
  await expect(page.locator('.library-contributor-folder')).toHaveCount(2);
  await expect(page.locator('.library-contributor-folder[data-contributor="2"]')).toContainText('2 fichiers');
  await expect(page.locator('.library-contributor-folder[data-contributor="3"]')).toContainText('1 fichier');
  await ids([]);
  await page.locator('.library-contributor-folder[data-contributor="2"]').click();
  await ids([201]);
  await page.locator('.library-uploaded-folder').click();
  await ids([202]);
  await page.goto(url('tp'));
  await page.locator('.library-contributor-folder[data-contributor="3"]').click();
  await ids([203]);
  const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(width.scroll <= width.viewport + 1, '390px library fits viewport');
  assert.deepEqual(dedicatedRequests, [], 'Browsing no longer depends on a separately deployed endpoint.');
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  const report = { passed: 6, scenarios: ['Legacy API loads categories from bootstrap', 'No files before selecting contributor',
    'Three Cours belong only to uploader 2', 'TP contributor counts are isolated', 'Nested TP stays inside uploader 2',
    'Other scopes/hidden/removed files excluded; no extra API dependency or writes'], viewport: width, errors };
  await mkdir('test-results/library-legacy-api', { recursive: true });
  await writeFile('test-results/library-legacy-api/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await context.close(); await browser.close(); }
