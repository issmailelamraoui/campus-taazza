import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// Deferred API replies exercise the actual AppProvider and document controls.
// This suite neither authenticates against providers nor writes remote data.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const errors = [];
let heldBootstrap;
try {
  await context.addInitScript(() => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
  });
  const user = { id: 2, username: 'sync-fixture', name: 'Fixture Student', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language: 'fr' };
  const resources = [{ id: 41, title: 'Snapshot consistency', filename: 'snapshot.pdf', faculty_id: 'flaa', filiere_id: 'french_studies', size: 1000, semester: 1, category: 'courses', part_number: 'complete', created_at: '2026-10-09T10:00:00Z', library_visible: true, author: { name: 'Fixture' }, module: 'Snapshot' }];
  const saved = [];
  let bootstrapCount = 0;
  const payload = () => ({ user, faculty: { id: 'flaa', code: 'FLAA', name: 'Fixture faculty' }, resources, messages: [], announcements: [], notifications: [], events: [], saved, history: [], channels: [], members: [] });
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') {
      bootstrapCount++;
      // Serialize at request time, before the later server-confirmed mutation.
      const body = JSON.stringify(payload());
      if (bootstrapCount === 2) { heldBootstrap = () => route.fulfill({ contentType: 'application/json', body }); return; }
      return route.fulfill({ contentType: 'application/json', body });
    }
    if (path === '/api/saved') {
      const body = route.request().postDataJSON();
      assert.equal(body.type, 'resource');
      assert.equal(Number(body.id), 41);
      saved.push({ type: 'resource', id: 41 });
      return route.fulfill({ json: { saved: true } });
    }
    errors.push(`Unexpected API request: ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected test fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseURL}/app`);
  const button = page.locator('.document-card .save-btn').first();
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => bootstrapCount).toBe(2);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    window.__savedStateTransitions = [];
    window.__savedStateObserver = new MutationObserver(records => {
      for (const record of records) {
        if (record.target.matches('.document-card .save-btn')) window.__savedStateTransitions.push(record.target.getAttribute('aria-pressed'));
      }
    });
    window.__savedStateObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  });
  await heldBootstrap(); heldBootstrap = null;
  await expect.poll(() => bootstrapCount, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(300);
  const transitions = await page.evaluate(() => { window.__savedStateObserver.disconnect(); return window.__savedStateTransitions; });
  assert.equal(transitions.includes('false'), false, 'A snapshot begun before the save must never erase confirmed bookmark state.');
  assert.equal(saved.length, 1, 'The mutation must be sent only once.');
  assert.deepEqual(errors, []);
  console.log('PASS stale bootstrap snapshots preserve confirmed bookmark state and request a fresh snapshot');
} finally {
  if (heldBootstrap) await heldBootstrap().catch(() => {});
  await context.close();
  await browser.close();
}
