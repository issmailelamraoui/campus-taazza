import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';

// Route every API call locally: these touch regressions never write to a database.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
mkdirSync('test-results', { recursive: true });

async function fixture(viewport, theme, mobile = true) {
  const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, reducedMotion: 'reduce' });
  const errors = [], writes = [];
  await context.addInitScript(theme => {
    window.EventSource = undefined;
    // These regressions exercise returning visitors; installation has its own suite.
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    window.__copies = [];
    window.__touchTrace = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__copies.push(text) } });
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) {
      document.addEventListener(type, event => window.__touchTrace.push({ type, pointerId: event.pointerId, pointerType: event.pointerType, detail: event.detail, action: event.target.closest?.('[role^="menuitem"]')?.textContent || '' }), true);
    }
  }, theme);
  const user = { id: 2, username: 'student-fixture', name: 'Fixture Student', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language: 'fr' };
  const author = { id: 3, name: 'Other Student', username: 'other' };
  const messages = [
    { id: 101, content: 'Un message court.', author, created_at: '2026-10-10T09:00:00Z' },
    { id: 102, content: 'Une autre ligne.', author, created_at: '2026-10-10T09:01:00Z' },
    { id: 103, content: 'Ma réponse, facile à lire.', author: user, reply_to: 101, created_at: '2026-10-10T09:02:00Z' },
  ].map(message => ({ ...message, channel: 'general', faculty_id: 'flaa', filiere_id: 'french_studies', reactions: {} }));
  await context.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'flaa', code: 'FLAA', name: 'Fixture faculty' }, resources: [], announcements: [], messages, notifications: [], events: [], saved: [], history: [], channels: [{ id: 'general', read_only: false }], members: [] } });
    writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseURL}/app/community?channel=general`);
  await expect(page.locator('[data-message-id="101"]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  return { context, page, errors, writes };
}

async function hold(page, cdp, message, handoff = false) {
  await message.scrollIntoViewIfNeeded();
  const box = await message.locator('.community-message-content').boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await expect(page.getByRole('menu')).toBeVisible();
  if (handoff) {
    const pointerId = await page.evaluate(() => window.__touchTrace.filter(event => event.type === 'pointerdown').at(-1).pointerId);
    await page.getByRole('menuitem', { name: 'Copier le message', exact: true }).evaluate((node, pointerId) => node.setPointerCapture(pointerId), pointerId);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(80);
  await expect(page.getByRole('menu')).toBeVisible();
}

async function compatibilityClicks(page, writes) {
  // Chrome normally retains the original touch target. Other mobile browsers
  // can retarget its compatibility click to the newly mounted portal. Exercise
  // that branch without a fresh pointerdown, after an actual native touch hold.
  const copies = await page.evaluate(() => [...window.__copies]);
  for (const item of await page.getByRole('menu').locator('button:not(:disabled)').all()) {
    await item.dispatchEvent('click', { bubbles: true, detail: 1 });
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.__copies), copies, 'Opening release must not copy any text or link.');
    assert.deepEqual(writes, [], 'Opening release must not react, report, pin, or delete.');
  }
}

try {
  for (const viewport of [{ width: 320, height: 600 }, { width: 390, height: 844 }]) {
    for (const theme of ['dark', 'light']) {
      const { context, page, errors, writes } = await fixture(viewport, theme);
      try {
        const cdp = await context.newCDPSession(page);
        const source = page.locator('[data-message-id="101"]');
        const own = page.locator('[data-message-id="103"]');
        await hold(page, cdp, source, true);
        const menuBox = await page.getByRole('menu').boundingBox();
        const navBox = await page.locator('.mobile-bottom-nav').boundingBox();
        assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= viewport.width + 1);
        assert.ok(menuBox.y >= 0 && menuBox.y + menuBox.height <= navBox.y + 1, 'Menu must fit above mobile navigation.');
        await compatibilityClicks(page, writes);
        await page.getByRole('menuitem', { name: 'Copier le message', exact: true }).tap();
        await expect(page.getByRole('menu')).toHaveCount(0);
        assert.deepEqual(await page.evaluate(() => window.__copies), ['Un message court.']);

        await hold(page, cdp, own);
        await expect(page.getByRole('menuitem', { name: 'Supprimer le message', exact: true })).toBeVisible();
        await compatibilityClicks(page, writes);
        await page.touchscreen.tap(2, 160);
        await expect(page.getByRole('menu')).toHaveCount(0);
        await expect(own).toBeVisible();

        const reference = page.locator('.community-reply-reference');
        await reference.tap();
        await expect(source).toHaveClass(/is-highlighted/);
        const bubble = source.locator('.community-message-bubble');
        const styles = await bubble.evaluate(node => ({ padding: getComputedStyle(node).padding, height: node.getBoundingClientRect().height, shadow: getComputedStyle(node).boxShadow, outline: getComputedStyle(node).outlineStyle }));
        assert.equal(styles.padding, '6px 9px');
        assert.ok(styles.height <= 36, 'Single-line phone bubble should remain compact.');
        assert.match(styles.shadow, /inset/);
        assert.equal(styles.outline, 'none');
        assert.equal(await source.evaluate(node => document.activeElement === node), false, 'Pointer reply jump must not focus the entire message.');
        await page.screenshot({ path: `test-results/chat-touch-${viewport.width}-${theme}.png` });
        await page.waitForTimeout(900);
        await reference.tap();
        await page.waitForTimeout(900);
        await expect(source).toHaveClass(/is-highlighted/);
        await expect(source).not.toHaveClass(/is-highlighted/, { timeout: 2200 });

        const box = await bubble.boundingBox();
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y - 25 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(650);
        await expect(page.getByRole('menu')).toHaveCount(0);
        const trace = await page.evaluate(() => window.__touchTrace);
        assert.ok(trace.some(event => event.type === 'pointerdown' && event.pointerType === 'touch'));
        assert.ok(trace.some(event => event.type === 'click' && event.pointerType === 'touch' && event.action.includes('Copier le message')));
        assert.deepEqual(errors, []);
        assert.deepEqual(writes, []);
        console.log(`PASS ${viewport.width}x${viewport.height} ${theme}: native hold, all portal release actions blocked, new tap, outside dismissal, compact bubbles, temporary/resettable reply highlight, pan cancels hold`);
      } finally { await context.close(); }
    }
  }

  const compact = await fixture({ width: 320, height: 360 }, 'light');
  try {
    const cdp = await compact.context.newCDPSession(compact.page);
    await hold(compact.page, cdp, compact.page.locator('[data-message-id="103"]'));
    const menu = compact.page.getByRole('menu');
    assert.equal(await menu.evaluate(node => node.scrollHeight > node.clientHeight), true);
    await menu.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await compact.page.waitForTimeout(100);
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    const lastBox = await compact.page.getByRole('menuitem', { name: 'Supprimer le message', exact: true }).boundingBox();
    assert.ok(lastBox.y >= menuBox.y && lastBox.y + lastBox.height <= menuBox.y + menuBox.height + 1, 'Last action must remain reachable in a short viewport.');
    await compact.page.touchscreen.tap(2, 160);
    await expect(menu).toHaveCount(0);
    assert.deepEqual(compact.errors, []);
    assert.deepEqual(compact.writes, []);
    console.log('PASS short viewport: menu can scroll to its last action and dismiss outside');
  } finally { await compact.context.close(); }

  const desktop = await fixture({ width: 1280, height: 900 }, 'dark', false);
  try {
    const source = desktop.page.locator('[data-message-id="101"]');
    await source.focus();
    await source.press('Shift+F10');
    const items = desktop.page.getByRole('menu').locator('[role^="menuitem"]');
    await expect(items.first()).toBeFocused();
    await desktop.page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await desktop.page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await desktop.page.keyboard.press('Escape');
    await expect(desktop.page.getByRole('menu')).toHaveCount(0);
    await expect(source).toBeFocused();
    await source.press('Shift+F10');
    await desktop.page.getByRole('menuitem', { name: 'Copier le message', exact: true }).focus();
    await desktop.page.keyboard.press('Enter');
    await expect(source).toBeFocused();
    assert.deepEqual(await desktop.page.evaluate(() => window.__copies), ['Un message court.']);
    assert.deepEqual(desktop.errors, []);
    assert.deepEqual(desktop.writes, []);
    console.log('PASS desktop keyboard: open, navigate, dismiss/restore focus, and activate copy with Enter');
  } finally { await desktop.context.close(); }
} finally { await browser.close(); }
