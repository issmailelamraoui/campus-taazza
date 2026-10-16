import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, firefox, expect } from '@playwright/test';

// No campus credentials, database, or object storage: all API calls are mocked.
// Headless browsers have no OS keyboard. Model its visual-only resize and pan
// separately from a real layout-viewport resize, and assert rendered geometry
// and native pointer/focus behavior rather than merely checking CSS classes.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const engine = process.env.CAMPUSLINK_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox'].includes(engine));
const browser = await ({ chromium, firefox })[engine].launch({ headless: true,
  ...(engine === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const output = `test-results/community-keyboard/${engine}`;
await mkdir(output, { recursive: true });
const scenarios = [
  { width: 320, height: 700, language: 'fr', theme: 'dark' },
  { width: 320, height: 568, language: 'ar', theme: 'dark' },
  { width: 390, height: 844, language: 'ar', theme: 'light' },
  { width: 768, height: 1024, language: 'fr', theme: 'light' },
  { width: 844, height: 390, language: 'fr', theme: 'light' },
  { width: 1024, height: 900, language: 'ar', theme: 'dark' },
  { width: 1440, height: 1000, language: 'fr', theme: 'dark' },
];

async function fixture(settings) {
  const { width, height, language, theme } = settings;
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1100,
    ...(engine === 'chromium' ? { isMobile: width < 1100 } : {}), reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    const native = window.visualViewport;
    const viewport = new EventTarget();
    let keyboard = null, scale = 1;
    Object.defineProperties(viewport, {
      height: { get: () => keyboard?.height ?? native.height },
      width: { get: () => native.width },
      offsetTop: { get: () => keyboard?.top ?? native.offsetTop },
      offsetLeft: { get: () => native.offsetLeft },
      scale: { get: () => scale },
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.__keyboardViewport = (height, top = 0) => {
      keyboard = height === null ? null : { height, top };
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
    window.__pinch = value => { scale = value; viewport.dispatchEvent(new Event('resize')); };
    window.__composerFocusEvents = [];
    for (const type of ['focus', 'blur']) document.addEventListener(type, event => {
      if (event.target.matches?.('.community-composer-input textarea')) window.__composerFocusEvents.push(type);
    }, true);
  }, { language, theme });
  const user = { id: 2, username: 'keyboard-fixture', name: 'Keyboard fixture', role: 'student',
    account_status: 'approved', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, language };
  const messages = Array.from({ length: 45 }, (_, index) => ({ id: index + 101,
    content: `Message ${index + 1} — Conversation de révision avec suffisamment de texte pour tester le défilement.`,
    author: { id: 3, username: 'other-student', name: 'Other student' },
    faculty_id: 'flaa', filiere_id: 'french_studies', channel: 'general', reactions: {},
    created_at: new Date(Date.UTC(2026, 9, 15, 12, index)).toISOString() }));
  const errors = [], writes = [];
  let pending;
  const payload = () => ({ user, faculty: { id: 'flaa', code: 'FLAA', name: 'Fixture faculty' },
    resources: [], announcements: [], messages, notifications: [], events: [], saved: [], history: [],
    channels: [{ id: 'general', read_only: false }], members: [] });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: payload() });
    if (path === '/api/messages' && request.method() === 'POST') {
      const body = request.postDataJSON();
      writes.push(body);
      pending = async () => {
        const message = { ...messages[0], ...body, id: 500 + writes.length, author: user, created_at: new Date().toISOString() };
        messages.push(message);
        await route.fulfill({ json: { message } });
        pending = null;
      };
      return;
    }
    errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected keyboard fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/app/community?channel=general`);
  await expect(page.locator('[data-message-id="145"]')).toBeVisible();
  return { context, page, errors, writes, acknowledge: async () => { await expect.poll(() => Boolean(pending)).toBe(true); await pending(); } };
}

async function fits(page, follow = true) {
  await expect.poll(() => page.evaluate(follow => {
    const viewport = window.visualViewport;
    const composer = document.querySelector('.community-composer').getBoundingClientRect();
    const input = document.querySelector('.community-composer-input textarea').getBoundingClientRect();
    const history = document.querySelector('.community-message-history');
    const bottom = viewport.offsetTop + viewport.height;
    const last = history.querySelector('.community-message:last-child')?.getBoundingClientRect();
    return composer.bottom <= bottom + 1 && input.top >= viewport.offsetTop && input.bottom <= bottom + 1 &&
      input.left >= -1 && input.right <= innerWidth + 1 &&
      (!follow || (history.scrollHeight - history.scrollTop - history.clientHeight <= 2 && last?.bottom <= history.getBoundingClientRect().bottom + 1));
  }, follow), { message: 'Composer and latest message should fit above the keyboard' }).toBe(true);
}
async function activate(page, locator, touch) {
  if (touch) await locator.tap();
  else await locator.click();
}

try {
  for (const settings of scenarios.filter(item => !process.env.CAMPUSLINK_KEYBOARD_TEST_WIDTH || item.width === Number(process.env.CAMPUSLINK_KEYBOARD_TEST_WIDTH))) {
    const { width, height, language, theme } = settings;
    const f = await fixture(settings);
    const { page, context, errors, writes } = f;
    const label = `${width}-${language}-${theme}`;
    const keyboardHeight = Math.max(250, Math.min(height - 280, 470));
    const textarea = page.locator('.community-composer-input textarea');
    const send = page.locator('.community-composer-input button[type="submit"]');
    const plus = page.locator('.community-composer-attach');
    const history = page.locator('.community-message-history');
    try {
      await fits(page);
      await activate(page, textarea, width < 1100);
      await textarea.fill('Premier message pendant la saisie');
      await page.evaluate(height => window.__keyboardViewport(height), keyboardHeight);
      await fits(page);
      await expect(textarea).toBeFocused();
      const lines = Array.from({ length: 8 }, (_, i) => `${i + 1}: Saisie multiligne — كتابة رسالة`).join('\n');
      await textarea.fill(lines);
      await textarea.press('End');
      await fits(page);
      // Firefox may leave a few pixels of bottom padding below the caret;
      // the last text line must be visible, not necessarily all that padding.
      await expect.poll(() => textarea.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight - parseFloat(getComputedStyle(node).paddingBottom))).toBeLessThanOrEqual(1);
      await page.evaluate(height => window.__keyboardViewport(height, 28), keyboardHeight - 30);
      await fits(page);
      await page.evaluate(() => { window.__composerFocusEvents = []; });
      await activate(page, send, width < 1100);
      await expect(textarea).toHaveValue('');
      await expect(textarea).toBeFocused();
      await expect(textarea).toBeEnabled();
      await fits(page);
      await f.acknowledge();
      await expect(page.locator('[data-message-id="501"]')).toBeVisible();
      await expect(textarea).toBeFocused();
      assert.deepEqual(await page.evaluate(() => window.__composerFocusEvents), [], 'Sending must never blur/refocus the composer');
      assert.equal(writes[0].content, lines);
      await textarea.fill('Deuxième message, clavier toujours ouvert');
      await textarea.press('Enter');
      await f.acknowledge();
      await expect(textarea).toBeFocused();
      await fits(page);
      assert.equal(writes.length, 2);
      assert.deepEqual(await page.evaluate(() => window.__composerFocusEvents), []);

      // Open while typing, then exercise the viewport transition that used to
      // immediately dismiss the upload menu and require a second tap.
      await textarea.fill('Brouillon conservé');
      await activate(page, plus, width < 1100);
      await expect(page.locator('.community-attachment-menu')).toBeVisible();
      await expect(textarea).toBeFocused();
      await page.evaluate(height => window.__keyboardViewport(height, 12), keyboardHeight + 20);
      await expect(page.locator('.community-attachment-menu')).toBeVisible();
      await expect.poll(() => page.locator('.community-attachment-menu').evaluate(node => {
        const box = node.getBoundingClientRect(), vv = window.visualViewport;
        return box.top >= vv.offsetTop && box.bottom <= vv.offsetTop + vv.height && box.left >= 0 && box.right <= innerWidth;
      })).toBe(true);
      const chooser = page.waitForEvent('filechooser');
      await activate(page, page.locator('.community-attachment-menu [role="menuitem"]').first(), width < 1100);
      await chooser;
      await expect(page.locator('.community-attachment-menu')).toHaveCount(0);
      await expect(textarea).toHaveValue('Brouillon conservé');
      await textarea.focus();
      await fits(page);
      await page.screenshot({ path: `${output}/${label}-keyboard.png` });

      // Opening the keyboard must not drag someone reading older messages down.
      await history.evaluate(node => { node.scrollTop = 120; });
      await expect(page.locator('.community-latest-button')).toBeVisible();
      await page.evaluate(height => window.__keyboardViewport(height, 0), keyboardHeight - 30);
      await fits(page, false);
      assert.ok(await history.evaluate(node => node.scrollTop < node.scrollHeight - node.clientHeight - 65));
      await page.locator('.community-latest-button').click();
      await fits(page);

      // An ordinary outside tap can dismiss typing; no queued send callback
      // should reopen it. Resizing back restores normal navigation and height.
      await activate(page, page.locator('.community-chat-heading'), width < 1100);
      await expect(textarea).not.toBeFocused();
      await page.evaluate(() => window.__keyboardViewport(null));
      await fits(page);
      if (width <= 760) await expect(page.locator('.mobile-bottom-nav')).toBeVisible();
      await page.screenshot({ path: `${output}/${label}-closed.png` });

      // Pinch zoom must keep the workspace size stable and leave panning to
      // the browser, rather than treating magnification as an OS keyboard.
      const normalHeight = await page.locator('.app-shell').evaluate(node => node.getBoundingClientRect().height);
      await page.evaluate(() => { window.__pinch(2); window.__keyboardViewport(220); });
      await page.waitForTimeout(60);
      assert.equal(await page.locator('.app-shell').evaluate(node => node.getBoundingClientRect().height), normalHeight);
      await page.evaluate(() => { window.__keyboardViewport(null); window.__pinch(1); });
      await fits(page);

      // Keyboard users retain normal menu focus and Escape behavior.
      await plus.focus();
      await plus.press('Enter');
      await expect(page.locator('.community-attachment-menu [role="menuitem"]').first()).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.community-attachment-menu [role="menuitem"]').last()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(plus).toBeFocused();
      await expect(page.locator('.community-attachment-menu')).toHaveCount(0);

      // Actual layout viewport resizing (e.g. resize-content browsers) also
      // keeps the latest message in view without relying on the simulated OSK.
      await textarea.focus();
      await page.setViewportSize({ width, height: Math.min(height - 200, 500) });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await fits(page);
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await fits(page);

      // A route change must release all viewport sizing and keyboard state.
      await page.evaluate(() => { document.querySelector('.skip-link').focus(); });
      await page.locator('a[href="/app/library"]').filter({ visible: true }).first().click();
      await expect(page.locator('.library-page')).toBeVisible();
      await expect(page.locator('.app-shell')).not.toHaveClass(/app-shell--community/);
      assert.equal(await page.locator('.app-shell').evaluate(node => node.style.getPropertyValue('--community-viewport-height')), '');
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine} ${label}: viewport, latest/multiline, continuous send focus, upload first tap, history, keyboard menu, cleanup`);
    } catch (error) {
      await page.screenshot({ path: `${output}/${label}-failure.png` }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
