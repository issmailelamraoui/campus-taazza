import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chooseOption } from './ui.helpers.mjs';

// All requests are intercepted: no campus accounts or tickets are changed.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const problems = [];
mkdirSync('test-results/phase1', { recursive: true });

async function fixture(width = 1280, role = 'global_admin') {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  });
  const user = { id: 2, username: 'feedback-test', name: 'Feedback test', role, faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language: 'fr' };
  const tickets = [
    { id: 91, assigned_to:2, assigned:{id:2,name:'Administration',username:'feedback-test'}, title: 'First conversation', description: 'First private request', name: 'Ticket student', email: 'student@example.test', created_at: '2026-10-15T09:00:00Z', category: 'improvement', status: 'planned', replies: [], attachments: [] },
    { id: 92, assigned_to:2, assigned:{id:2,name:'Administration',username:'feedback-test'}, title: 'Second conversation', description: 'Second private request', status: 'reviewing', replies: [], attachments: [] },
  ];
  const calls = [], held = [];
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user, resources: [], messages: [], announcements: [], notifications: [], events: [], channels: [], members: [], saved: [], history: [] } });
    if (path === '/api/admin/registrations') return route.fulfill({ json: { requests: [] } });
    if (path === '/api/chat/blocks') return route.fulfill({ json: { blocks: [] } });
    if (path === '/api/feedback' && method === 'GET') return route.fulfill({ json: { tickets } });
    const match = /^\/api\/(?:admin\/)?feedback\/(91|92)(\/replies|\/attachments)?$/.exec(path);
    if (match) {
      const ticket = tickets.find(item => item.id === Number(match[1]));
      if (method === 'GET') return route.fulfill({ json: { ticket } });
      const call = { path, body: match[2] === '/attachments' ? null : request.postDataJSON() };
      calls.push(call);
      held.push(async () => {
        if (match[2] === '/replies') {
          if (call.body.status) ticket.status = call.body.status;
          ticket.replies.push({ id: calls.length, author: { name: 'Administration' }, content: call.body.content, created_at: '2026-10-15T10:00:00Z' });
        }
        await route.fulfill({ json: { ticket } });
      });
      return;
    }
    problems.push(`Unexpected request: ${method} ${path}`);
    return route.fulfill({ status: 503, json: { error: 'Unknown feedback fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => problems.push(error.message));
  const path = id => `/app/feedback?ticket=${id}${role === 'global_admin' ? '&admin=1' : ''}`;
  // Browser back/forward changes the query without remounting FeedbackPage.
  await page.goto(baseURL + path(92));
  await page.locator('#feedback-92').waitFor({ timeout: 30000 });
  await page.evaluate(next => { history.pushState(null, '', next); dispatchEvent(new PopStateEvent('popstate')); }, path(91));
  await expect(page.locator('#feedback-91')).toBeVisible();
  return { context, page, calls, held, tickets };
}

const draft = page => page.getByLabel('Ajouter une précision', { exact: true });
const submit = page => page.locator('.campus-detail form');

try {
  for (const width of [1280, 320]) {
    const f = await fixture(width);
    try {
      await expect(f.page.getByRole('combobox', { name: 'Statut', exact: true })).toContainText('Prévue');
      await draft(f.page).fill('Keep the planned status');
      await submit(f.page).evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
      await expect.poll(() => f.calls.length).toBe(1);
      assert.equal(f.calls[0].body.status, undefined, 'An unchanged status must be preserved by the server');
      await expect(f.page.getByRole('button', { name: 'Répondre', exact: true })).toBeDisabled();
      await draft(f.page).fill('Continue writing while the first reply is sent');
      await f.held.shift()();
      await expect(draft(f.page)).toHaveValue('Continue writing while the first reply is sent');
      await expect(f.page.locator('.feedback-person')).toContainText('Ticket student');
      await expect(f.page.locator('.feedback-person')).toContainText('student@example.test');
      await expect(f.page.locator('.feedback-ticket-labels')).toContainText('Amélioration');
      await f.page.screenshot({ path: `test-results/phase1/feedback-${width}.png`, fullPage: true });
      await expect(f.page.locator('.campus-thread').first()).toContainText('Keep the planned status');
      assert.equal(f.tickets[0].status, 'planned');

      await draft(f.page).fill('A draft for ticket 91');
      await f.page.goBack();
      await expect(f.page.locator('#feedback-92')).toBeVisible();
      await expect(draft(f.page)).toHaveValue('');
      await expect(f.page.getByRole('combobox', { name: 'Statut', exact: true })).toContainText('En cours d’examen');
      await chooseOption(f.page.getByRole('combobox', { name: 'Statut', exact: true }), 'done');
      await draft(f.page).fill('An explicit status change');
      await submit(f.page).evaluate(form => form.requestSubmit());
      await expect.poll(() => f.calls.length).toBe(2);
      assert.equal(f.calls[1].body.status, 'done');
      await f.held.shift()();
      await expect(draft(f.page)).toHaveCount(0);
      assert.equal(f.tickets[1].status, 'done');
      assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Feedback fits a ${width}px screen`);
      console.log(`PASS ${width}px: existing ticket status, explicit status change, duplicate prevention and separate drafts`);
    } finally { await f.context.close(); }
  }

  for (const action of ['reply', 'attachment']) {
    const f = await fixture(390, 'student');
    try {
      if (action === 'reply') {
        await draft(f.page).fill('An old ticket reply');
        await submit(f.page).evaluate(form => form.requestSubmit());
      } else {
        await f.page.locator('input[type="file"]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('Private attachment fixture') });
      }
      await expect.poll(() => f.calls.length).toBe(1);
      await f.page.goBack();
      await expect(f.page.locator('#feedback-92')).toBeVisible();
      await draft(f.page).fill('Keep this new conversation draft');
      await submit(f.page).evaluate(form => form.requestSubmit());
      await expect.poll(() => f.calls.length).toBe(2);
      await f.held.shift()();
      await expect(draft(f.page)).toHaveValue('Keep this new conversation draft');
      await expect(f.page.getByRole('button', { name: 'Répondre', exact: true })).toBeDisabled();
      await f.held.shift()();
      await expect(draft(f.page)).toHaveValue('');
      assert.match(f.calls[0].path, /\/91\//);
      assert.match(f.calls[1].path, /\/92\/replies$/);
      console.log(`PASS late ${action} response cannot reset or unlock another conversation`);
    } finally { await f.context.close(); }
  }
  const validation = await fixture(320, 'student');
  try {
    const input = validation.page.locator('input[type="file"]');
    await input.setInputFiles({ name: 'unsupported.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('unsupported') });
    await expect(validation.page.locator('.feedback-reply [role="alert"]')).toContainText('pris en charge');
    await input.setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.from('') });
    await expect(validation.page.locator('.feedback-reply [role="alert"]')).toContainText('non vide');
    assert.equal(validation.calls.length, 0, 'Invalid files must be rejected before any upload');
    validation.tickets[0].attachments = [{ id: 7, filename: 'prior.zip', size: 49 * 1024 * 1024, url: '/api/feedback/attachments/7/file' }];
    await validation.page.reload();
    await validation.page.locator('#feedback-91').waitFor({ timeout: 30000 });
    await input.setInputFiles({ name: 'over-quota.txt', mimeType: 'text/plain', buffer: Buffer.alloc(2 * 1024 * 1024, 'x') });
    await expect(validation.page.locator('.feedback-reply [role="alert"]')).toContainText('50 Mo');
    assert.equal(validation.calls.length, 0, 'The total quota must be checked before uploading');
    let fail = true;
    await validation.context.route('**/api/feedback', route => fail ? route.fulfill({ status: 503, json: { error: 'Feedback fixture unavailable' } }) : route.fulfill({ json: { tickets: validation.tickets } }));
    await validation.page.goto(baseURL + '/app/feedback');
    await expect(validation.page.getByRole('alert')).toContainText('Feedback fixture unavailable');
    await expect(validation.page.getByText('Aucune demande', { exact: true })).toHaveCount(0);
    fail = false;
    await validation.page.getByRole('button', { name: 'Réessayer', exact: true }).click();
    await expect(validation.page.locator('.feedback-ticket')).toHaveCount(2);
    console.log('PASS author/date/category, in-flight draft preservation, local attachment validation, quota and recoverable read error');
  } finally { await validation.context.close(); }
  assert.deepEqual(problems, []);
} finally { await browser.close(); }
