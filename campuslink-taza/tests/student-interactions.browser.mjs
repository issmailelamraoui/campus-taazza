import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// Every API request is answered locally. Deferred responses exercise the real
// provider without authenticating with or writing to any remote service.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
const errors = [], heldMessages = [], messageRequests = [];
let heldRead;
try {
  await context.addInitScript(() => {
    window.EventSource = undefined;
    // These regressions exercise returning visitors; installation has its own suite.
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied in fixture'); } } });
    document.execCommand = command => {
      if (command !== 'copy') return false;
      window.__copiedText = document.querySelector('textarea[readonly]')?.value;
      return true;
    };
  });
  const user = { id: 2, username: 'student-fixture', name: 'Fixture Student', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language: 'fr' };
  const initialText = 'Message à copier.\nUne seconde ligne avec العربية.';
  const messages = [{ id: 101, faculty_id: 'flaa', filiere_id: 'french_studies', channel: 'general', content: initialText, author: { id: 3, username: 'other', name: 'Other Student' }, created_at: '2026-10-09T09:00:00Z', reactions: {} }];
  const notifications = [
    { id: 1, type: 'mentions', title: 'Notification non lue', body: 'Ouvrir la discussion immédiatement.', path: '/app/chat/general#message-101', read: false, created_at: '2026-10-09T10:00:00Z' },
    { id: 2, type: 'mentions', title: 'Notification déjà lue', body: 'Historique.', path: '/app/chat/general#message-101', read: true, created_at: '2026-10-09T09:00:00Z' },
    { id: 3, type: 'calendar', title: 'Calendrier retiré', body: 'Ne doit pas apparaître.', path: '/app/calendar#event-5', read: false, created_at: '2026-10-09T08:00:00Z' },
  ];
  const payload = () => ({ user, faculty: { id: 'flaa', code: 'FLAA', name: 'Fixture faculty' }, resources: [], announcements: [], messages, notifications, events: [], saved: [], history: [], channels: [{ id: 'general', read_only: false }], members: [] });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: payload() });
    if (path === '/api/notifications/read') {
      const body = request.postDataJSON();
      heldRead = async () => { notifications.forEach(item => { if (!body.ids || body.ids.map(String).includes(String(item.id))) item.read = true; }); await route.fulfill({ json: { ok: true } }); };
      return;
    }
    if (path === '/api/messages' && request.method() === 'POST') {
      const body = request.postDataJSON();
      messageRequests.push(body);
      heldMessages.push({ route, body });
      return;
    }
    errors.push(`Unexpected API request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));

  await page.goto(`${baseURL}/app/notifications`);
  await expect(page.getByRole('tab', { name: /^Non lu/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.notification-item')).toHaveCount(1);
  await expect(page.locator('.notification-item')).toContainText('Notification non lue');
  await expect(page.getByText('Calendrier retiré', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: /^Lu/ }).click();
  await expect(page.locator('.notification-item')).toContainText('Notification déjà lue');
  await page.locator('.notification-button').click();
  await expect(page.locator('.notification-popover .notification-item')).toHaveCount(1);
  await expect(page.locator('.notification-popover .notification-item')).toContainText('Notification non lue');
  await page.locator('.notification-popover .notification-filter-tabs').getByRole('button', { name: 'Lu', exact: true }).click();
  await expect(page.locator('.notification-popover .notification-item')).toContainText('Notification déjà lue');
  await page.locator('.notification-button').click();
  await page.getByRole('tab', { name: /^Non lu/ }).click();
  await page.locator('.notification-content').click();
  await expect(page).toHaveURL(url => url.pathname === '/app/community' && url.searchParams.get('message') === '101');
  await expect.poll(() => Boolean(heldRead)).toBe(true);
  await expect(page.locator('.app-write-status')).toBeVisible();
  await heldRead(); heldRead = null;
  await expect(page.locator('.app-write-status')).toHaveCount(0);
  console.log('PASS unread notification defaults, explicit read history, and navigation before read acknowledgment');

  const source = page.locator('.community-message').filter({ hasText: 'Message à copier.' });
  await source.focus();
  await source.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Copier le message', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__copiedText), initialText);
  await expect(source).toBeFocused();
  await expect(page.locator('textarea[readonly]')).toHaveCount(0);
  await source.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Copier le lien', exact: true }).click();
  assert.match(await page.evaluate(() => window.__copiedText), /\/app\/community\?channel=general&message=101$/);
  console.log('PASS message text and link actions use the clipboard fallback and preserve focus');

  const composer = page.getByLabel('Votre message', { exact: true });
  await composer.fill('Livraison différée');
  await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
  const pending = page.locator('.community-message[data-delivery-status="sending"]');
  await expect(pending).toContainText('Livraison différée');
  await expect(composer).toHaveValue('');
  await expect(composer).toBeEnabled();
  await composer.fill('Le prochain brouillon reste disponible.');
  await pending.dispatchEvent('contextmenu', { clientX: 700, clientY: 400 });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect.poll(() => heldMessages.length).toBe(1);
  const first = heldMessages.shift();
  await first.route.fulfill({ status: 503, json: { error: 'Échec de livraison simulé.' } });
  const failed = page.locator('.community-message[data-delivery-status="failed"]');
  await expect(failed).toContainText('Échec de livraison simulé.');
  await expect(failed.getByRole('button', { name: 'Retirer', exact: true })).toBeVisible();
  await failed.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await expect(pending).toContainText('Livraison différée');
  await expect.poll(() => heldMessages.length).toBe(1);
  const retry = heldMessages.shift();
  assert.equal(retry.body.client_id, first.body.client_id, 'Retry must reuse its idempotency key.');
  const confirmed = { ...messages[0], id: 102, client_id: retry.body.client_id, content: retry.body.content, author: user, created_at: new Date().toISOString() };
  messages.push(confirmed);
  await retry.route.fulfill({ json: { message: confirmed } });
  await expect(page.locator('.community-message[data-delivery-status]')).toHaveCount(0);
  await expect(page.locator('.community-message').filter({ hasText: 'Livraison différée' })).toHaveCount(1);
  await expect(composer).toHaveValue('Le prochain brouillon reste disponible.');
  assert.equal(messageRequests.length, 2);
  console.log('PASS immediate chat bubbles, available composer, failed delivery, and idempotent retry');

  await page.goto(`${baseURL}/app/calendar`);
  await expect(page).toHaveURL(url => url.pathname === '/app');
  await expect(page.locator('a[href="/app/calendar"]')).toHaveCount(0);
  await page.goto(`${baseURL}/app/profile`);
  await expect(page.locator('#preferences')).not.toContainText('Calendrier');
  await page.goto(`${baseURL}/app/announcements`);
  await expect(page.locator('a[href="/app/calendar"]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseURL}/app/community?channel=help`);
  await expect(page).toHaveURL(url => url.searchParams.get('channel') === 'general');
  await expect(page.getByRole('button', { name: 'Entraide', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Vie étudiante', exact: true })).toHaveCount(0);
  const mobileMessage = page.locator('.community-message').first();
  assert.equal(await mobileMessage.evaluate(node => getComputedStyle(node).webkitTapHighlightColor), 'rgba(0, 0, 0, 0)');
  await mobileMessage.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 190, clientY: 300 });
  await expect(page.getByRole('menu')).toBeVisible();
  await mobileMessage.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true });
  await expect(page.getByRole('menuitem', { name: 'Copier le message', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await composer.fill('Message mobile en attente');
  await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
  await expect(page.locator('.community-delivery-status.is-sending')).toBeVisible();
  await expect(page.locator('.app-write-status')).toBeHidden();
  await expect(composer).toBeEnabled();
  const geometry = await page.locator('.community-composer').boundingBox();
  assert.ok(geometry && geometry.y + geometry.height <= 844, 'Mobile composer must remain inside the viewport during delivery.');
  await expect.poll(() => heldMessages.length).toBe(1);
  await heldMessages.shift().route.fulfill({ status: 503, json: { error: 'Échec mobile simulé.' } });
  await page.locator('.community-message[data-delivery-status="failed"]').getByRole('button', { name: 'Retirer', exact: true }).click();
  await expect(page.locator('.community-message[data-delivery-status]')).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('PASS removed calendar/support channels, mobile long-press copy, transparent taps, and unobscured pending composer');
} finally {
  if (heldRead) await heldRead().catch(() => {});
  for (const pending of heldMessages) await pending.route.fulfill({ status: 503, json: { error: 'Fixture cleanup' } }).catch(() => {});
  await context.close();
  await browser.close();
}
