import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';

// Every API request is handled locally, including mutations and file contents.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
mkdirSync('test-results/phase1', { recursive: true });
const reports = [], errors = [];
const now = '2026-10-15T12:00:00Z';
const long = 'Une question de révision suffisamment détaillée avec des références et un nom de module très long';
async function fixture({ width = 390, language = 'fr', theme = 'dark', faculty = 'flaa', program = 'french_studies', role = 'student', grants, readonly = false, missingUsername = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { language, theme });
  const user = { id: 2, name: 'Student fixture', username: 'student-fixture', role, faculty_id: faculty, filiere_id: program, current_semester: 1, language, account_status: 'approved', ...(grants ? { administrative_capabilities: grants, has_admin_access: grants.some(grant => grant.capabilities.some(capability => capability !== 'resource.upload')) } : {}) };
  const peer = { id: 3, username: missingUsername ? '' : 'peer-fixture', name: 'Peer fixture', role: 'student' };
  const attachment = { id: 71, title: 'Private notes title', filename: 'private-notes.txt', faculty_id: faculty, filiere_id: program, semester: 1, category: 'courses', resource_type: 'courses', module: 'Méthodologie universitaire', part_number: '20', teacher_name: 'Professor metadata', size: 170, mime: 'text/plain', author: peer, created_at: now, library_visible: false };
  const messages = [{ id: 101, author: peer, faculty_id: faculty, filiere_id: null, channel: 'general', content: 'A community message with a classified file.', attachments: [attachment], created_at: now }, { id: 102, author: peer, faculty_id: faculty, filiere_id: program, semester: 1, channel: 'filiere', content: 'A program message', created_at: now }];
  const question = id => ({ id, title: `${long} ${id}`, body: long, module: 'Méthodologie', author: peer, author_id: 3, answer_count: 1 });
  const writes = [], held = [];
  let failRead = false, holdPreview = false;
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const fulfill = json => route.fulfill({ json });
    if (path === '/api/session') return fulfill({ user });
    if (path === '/api/bootstrap') return fulfill({ user, faculty: { id: faculty, code: faculty.toUpperCase(), name: 'Faculty fixture' }, resources: [], messages, channels: [{ id: 'general', read_only: readonly }, { id: 'filiere', read_only: readonly }], announcements: [], notifications: [], members: [], saved: [], history: [], events: [] });
    if (path === '/api/messages/read') return fulfill({ discussion_unread_count: 0 });
    if (path === '/api/admin/registrations') return fulfill({ requests: [] });
    if (path === '/api/chat/blocks') return fulfill({ blocks: [] });
    if (path === '/api/campus/forum') return failRead ? route.fulfill({ status: 503, json: { error: 'Campus fixture unavailable' } }) : fulfill({ questions: [question(81)] });
    const detail = /^\/api\/campus\/forum\/(81|82)$/.exec(path);
    if (detail) return fulfill({ question: question(Number(detail[1])), answers: [{ id: 11, body: long, author: user, author_id: 2, score: 1, my_vote: 0 }], comments: [{ id: 21, answer_id: 11, author: peer, body: long }] });
    if (/\/campus\/forum\/\d+\/attachments$/.test(path)) return fulfill({ attachments: [], can_upload: false });
    if (/\/campus\/forum\/\d+\/answers$/.test(path) && method === 'POST') { writes.push({ path, method, body: request.postDataJSON() }); held.push(() => fulfill({ answer: { id: 12 } })); return; }
    if (path === '/api/campus/groups') return fulfill({ groups: [{ id: 41, title: long, module: 'Méthodologie', member_count: 3, joined: true }] });
    if (path === '/api/campus/groups/41') return fulfill({ group: { id: 41, title: long }, members: [user, peer], messages: [{ id: 1, author: peer, body: long }] });
    if (path === '/api/campus/close-requests') return fulfill({ requests: [{ id: 31, title: long, topic: long, module: 'Méthodologie', requester_id: 3, author: peer }], rooms: [{ id: 32, title: long, closed_at: null }], expiredRequests: [{ id: 30, title: long }], expiryDays: 7 });
    if (path === '/api/campus/reports') return fulfill({ reports: [{ id: 99, target_type: 'question', target_id: 81, status: 'open', reason: long }] });
    if (path === '/api/campus/blocks') return fulfill({ blocks: [{ blocked_id: 4, user: { name: 'Blocked student fixture' } }] });
    if (path === '/api/campus/rooms/32') return fulfill({ room: { id: 32, title: long, requester_id: 2, helper_id: 3, board_revision: 1, requester_consent: false, helper_consent: false, recording: false, closed_at: null }, messages: [{ id: 1, author: peer, body: long }], board: [], participants: [user, peer], safety: { peer_id: 3, blocked: false, blocked_by_me: false } });
    if (path === '/api/campus/match') return fulfill({ offers: [{ id: 1, user: peer, user_id: 3, module: 'Méthodologie', topic: long, availability: 'Cette semaine en soirée' }], requests: [{ id: 51, status: 'pending', recipient_id: 2 }] });
    if (path === '/api/campus/market') return fulfill({ listings: [{ id: 61, title: long, body: long, status: 'available', price: 15000, seller: peer, seller_id: 3 }] });
    if (path === '/api/campus/market/61') return fulfill({ listing: { id: 61, title: long, body: long, status: 'available', price: 15000, seller: peer, seller_id: 3 }, requests: [{ id: 62, author: user, body: long, replies: [{ id: 63, author: peer, body: long }] }] });
    if (path === '/api/files/71') { if (holdPreview) { holdPreview = false; held.push(() => route.fulfill({ contentType: 'text/plain', body: 'Private file content' })); return; } return route.fulfill({ contentType: 'text/plain', body: 'Private file content' }); }
    if (path === '/api/admin/messages/101/remove' || path === '/api/messages/101' && method === 'DELETE') { writes.push({ path, method }); return fulfill({ ok: true }); }
    errors.push(`Unexpected fixture request: ${method} ${path}`);
    return route.fulfill({ status: 503, json: { error: 'Unexpected phase1 fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, writes, held, failRead: value => { failRead = value; }, holdPreview: () => { holdPreview = true; } };
}
async function go(page, path, selector) { await page.goto(origin + path); await page.locator(selector).first().waitFor({ timeout: 30000 }); await page.evaluate(() => document.fonts.ready); }
async function fit(page, label) {
  const geometry = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const outside = [...document.querySelectorAll('main .btn, main .custom-select, main textarea, main input:not([hidden])')].filter(node => node.getClientRects().length && !node.closest('.campus-tabs')).map(node => ({ text: node.getAttribute('aria-label') || node.textContent?.slice(0, 40), left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })).filter(node => node.left < -1 || node.right > width + 1);
    return { width, scroll: document.documentElement.scrollWidth, outside };
  });
  assert.ok(geometry.scroll <= geometry.width + 1, `${label}: horizontal overflow ${JSON.stringify(geometry)}`);
  assert.deepEqual(geometry.outside, [], `${label}: controls clipped`);
  reports.push({ label, ...geometry });
}
async function changeQuery(page, query) { await page.evaluate(query => { history.pushState(null, '', query); dispatchEvent(new PopStateEvent('popstate')); }, query); }
try {
  const paths = ['/app/campus', '/app/campus?tab=forum&question=81', '/app/campus?tab=rooms', '/app/campus?tab=rooms&room=32', '/app/campus?tab=groups', '/app/campus?tab=groups&group=41', '/app/campus?tab=match', '/app/campus?tab=market', '/app/campus?tab=market&listing=61'];
  for (const config of [{ width: 320, language: 'fr', theme: 'dark', faculty: 'flaa', program: 'french_studies' }, { width: 390, language: 'ar', theme: 'light', faculty: 'feg', program: 'economics' }, { width: 768, language: 'en', theme: 'light', faculty: 'fsjp', program: 'public_law' }, { width: 1440, language: 'fr', theme: 'dark', faculty: 'fsa', program: 'information_systems' }]) {
    const f = await fixture(config);
    try {
      for (const path of paths) { await go(f.page, path, '.campus-page'); await expect(f.page.locator('.campus-loading')).toHaveCount(0); await fit(f.page, `${config.width}-${config.faculty} ${path}`); }
      await f.page.screenshot({ path: `test-results/phase1/campus-market-${config.width}.png`, fullPage: true });
      assert.deepEqual(f.writes, []);
      console.log(`PASS ${config.width}px ${config.language} ${config.faculty}: nine populated Campus destinations`);
    } finally { await f.context.close(); }
  }
  const f = await fixture();
  try {
    f.failRead(true);
    await go(f.page, '/app/campus', '.campus-error');
    await expect(f.page.getByRole('alert')).toContainText('Campus fixture unavailable');
    f.failRead(false); await f.page.getByRole('button', { name: 'Réessayer', exact: true }).click();
    await expect(f.page.locator('.campus-entry')).toContainText(long);
    await go(f.page, '/app/campus?tab=forum&question=81', '.forum-attachments');
    const input = f.page.getByLabel('Votre réponse (texte ou code)', { exact: true });
    await input.fill('Reply for question81'); await input.locator('xpath=ancestor::form').evaluate(form => form.requestSubmit());
    await expect.poll(() => f.writes.length).toBe(1);
    await changeQuery(f.page, '/app/campus?tab=forum&question=82');
    await expect(f.page.locator('.campus-detail h2')).toContainText('82');
    await expect(input).toHaveValue(''); await input.fill('Draft for question82');
    await f.held.shift()(); await expect(input).toHaveValue('Draft for question82');
    await expect(f.page.locator('.campus-detail > form button[type="submit"]')).toBeEnabled();
    await go(f.page, '/app/community?channel=general', '.community-device-attachment');
    const summary = f.page.locator('.community-device-attachment');
    await expect(summary).toContainText('Méthodologie universitaire'); await expect(summary).toContainText('20'); await expect(summary).toContainText('@peer-fixture');
    await expect(summary).not.toContainText('Professor metadata'); await expect(summary).not.toContainText('private-notes.txt'); await expect(summary).not.toContainText('Private notes title');
    f.holdPreview(); await summary.locator('button').click(); await expect.poll(() => f.held.length).toBe(1);
    await changeQuery(f.page, '/app/community?channel=important'); await expect(summary).toHaveCount(0);
    await f.held.shift()(); await expect(f.page.getByRole('dialog')).toHaveCount(0);
    await changeQuery(f.page, '/app/community?channel=general'); await summary.locator('button').click();
    await expect(f.page.getByRole('dialog')).toContainText('Professor metadata'); await expect(f.page.getByRole('dialog')).toContainText('private-notes.txt'); await expect(f.page.getByRole('dialog')).toContainText('Private file content');
    console.log('PASS Campus retry, navigation-safe pending reply, four-field community summary and late preview isolation');
  } finally { await f.context.close(); }
  const noUsername = await fixture({ missingUsername: true });
  try {
    await go(noUsername.page, '/app/community?channel=general', '.community-device-attachment');
    await expect(noUsername.page.locator('.community-file-uploader')).toHaveText('Peer fixture');
    console.log('PASS missing uploader username uses the actual display name without inventing an @account');
  } finally { await noUsername.context.close(); }
  for (const permissions of [
    { label: 'feedback grant', role: 'faculty_admin', grants: [{ facultyId: 'flaa', filiereId: null, capabilities: ['feedback.manage'] }], expected: false },
    { label: 'program moderation on general chat', role: 'faculty_leader', grants: [{ facultyId: 'flaa', filiereId: 'french_studies', capabilities: ['content.moderate'] }], expected: false, yearExpected: true },
    { label: 'faculty moderation', role: 'faculty_leader', grants: [{ facultyId: 'flaa', filiereId: null, capabilities: ['content.moderate'] }], expected: true },
    { label: 'another faculty grant', role: 'faculty_admin', grants: [{ facultyId: 'feg', filiereId: null, capabilities: ['content.moderate'] }], expected: false },
  ]) {
    const scoped = await fixture({ role: permissions.role, grants: permissions.grants, readonly: true });
    try {
      await go(scoped.page, '/app/community?channel=general', '[data-message-id="101"]');
      const message = scoped.page.locator('[data-message-id="101"]');
      await message.focus(); await message.press('Shift+F10');
      await expect(scoped.page.getByRole('menuitem', { name: 'Épingler', exact: true })).toHaveCount(permissions.expected ? 1 : 0);
      await expect(scoped.page.getByRole('menuitem', { name: 'Supprimer le message', exact: true })).toHaveCount(permissions.expected ? 1 : 0);
      if (permissions.expected) {
        await scoped.page.getByRole('menuitem', { name: 'Supprimer le message', exact: true }).click();
        await expect.poll(() => scoped.writes.length).toBe(1);
        assert.deepEqual(scoped.writes[0], { path: '/api/admin/messages/101/remove', method: 'POST' });
      } else await scoped.page.keyboard.press('Escape');
      if (permissions.yearExpected) {
        await changeQuery(scoped.page, '/app/community?channel=year-1');
        const yearMessage = scoped.page.locator('[data-message-id="102"]');
        await yearMessage.focus(); await yearMessage.press('Shift+F10');
        await expect(scoped.page.getByRole('menuitem', { name: 'Épingler', exact: true })).toBeVisible();
      }
      console.log(`PASS scoped actions: ${permissions.label}`);
    } finally { await scoped.context.close(); }
  }
  assert.deepEqual(errors, []);
  writeFileSync('test-results/phase1/community-campus-report.json', JSON.stringify({ reports }, null, 2));
} finally { await browser.close(); }
