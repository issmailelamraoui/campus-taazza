import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { browserOptions, selectLanguage } from './browser-utils.mjs';

const origin = process.env.CAMPUS_BROWSER_ORIGIN || 'http://localhost:5173';
const browser = await chromium.launch(browserOptions());
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const report = message => console.log(`PASS ${message}`);

async function appearance(theme) {
  if (await page.locator('html').getAttribute('data-theme') === theme) return;
  if (await page.locator('.app-header .theme-toggle').isVisible()) {
    await page.locator('.app-header .theme-toggle').click();
  } else {
    const destination = page.url();
    await page.goto(`${origin}/app/settings`);
    await page.locator(`.study-appearance-options button[data-theme-option="${theme}"]`).click();
    await page.goto(destination);
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function assertHeader(width) {
  const metrics = await page.evaluate(() => {
    const visible = element => element && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0;
    const box = element => { const r = element.getBoundingClientRect(); return { selector: element.className, x: r.x, right: r.right, y: r.y, bottom: r.bottom }; };
    return {
      width: innerWidth,
      content: document.documentElement.scrollWidth,
      parts: [...document.querySelectorAll('.app-header .mobile-menu, .app-header .brand, .app-header .global-search, .app-header > .header-actions')].filter(visible).map(box),
      actions: [...document.querySelectorAll('.app-header .header-actions > *, .app-header .header-actions > .profile-area')].filter(visible).map(box),
    };
  });
  assert.ok(metrics.content <= width + 1, `Viewport overflows at ${width}px: ${metrics.content}px`);
  for (const group of [metrics.parts, metrics.actions]) {
    for (const box of group) {
      assert.ok(box.x >= -1 && box.right <= width + 1, `Header control ${box.selector} leaves ${width}px viewport: ${JSON.stringify(box)}`);
    }
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
        assert.ok(overlapX <= 1 || overlapY <= 1, `Header controls overlap at ${width}px: ${a.selector} and ${b.selector}`);
      }
    }
  }
}

async function assertReadableChat(width, theme) {
  // Evaluate the colors that the user sees, compositing transparent surface
  // layers, rather than checking token names or duplicating CSS declarations.
  const text = await page.evaluate(() => {
    const parse = value => { const numbers = value.match(/[\d.]+/g)?.map(Number); return numbers && numbers.length >= 3 ? [...numbers.slice(0, 3), numbers[3] ?? 1] : [0, 0, 0, 0]; };
    const composite = (front, back) => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      if (!alpha) return [0, 0, 0, 0];
      return [...front.slice(0, 3).map((channel, i) => (channel * front[3] + back[i] * back[3] * (1 - front[3])) / alpha), alpha];
    };
    const luminance = color => color.slice(0, 3).map(channel => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((total, channel, i) => total + channel * [0.2126, 0.7152, 0.0722][i], 0);
    return ['.message-text', '.message-meta b', '.message-meta > span:not(.verified-badge)', '.attachment-file b', '.chat-header h1', '.chat-header p', '.composer-caption'].flatMap(selector => {
      const element = document.querySelector(selector);
      if (!element) return [];
      let background = [0, 0, 0, 0];
      for (let ancestor = element; ancestor && background[3] < 1; ancestor = ancestor.parentElement) background = composite(background, parse(getComputedStyle(ancestor).backgroundColor));
      background = composite(background, [255, 255, 255, 1]);
      const style = getComputedStyle(element);
      const foreground = composite(parse(style.color), background);
      const a = luminance(foreground), b = luminance(background);
      return [{ selector, size: parseFloat(style.fontSize), contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), text: element.textContent.slice(0, 60) }];
    });
  });
  assert.ok(text.some(item => item.selector === '.message-text'), 'Actual chat content is available');
  for (const item of text) {
    const minimumSize = item.selector === '.composer-caption' ? 13 : 14;
    assert.ok(item.size >= minimumSize, `${theme} ${width}px: ${item.selector} is only ${item.size}px`);
    const minimumContrast = item.size >= 24 ? 3 : 4.5;
    assert.ok(item.contrast >= minimumContrast, `${theme} ${width}px: ${item.selector} contrast is ${item.contrast.toFixed(2)}:1`);
  }
  const body = text.find(item => item.selector === '.message-text');
  assert.ok(body.size >= 17, `Chat body should be comfortable to read at ${width}px`);
  const inputSize = await page.locator('.chat-composer textarea').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert.ok(inputSize >= 16, `Composer text is only ${inputSize}px at ${width}px`);
}

try {
  const login = await context.request.post(`${origin}/api/login`, { data: { username: 'admin', password: 'Admin2026!' } });
  assert.ok(login.ok());
  await context.request.patch(`${origin}/api/profile`, { data: { language: 'fr' } });
  await page.goto(`${origin}/app/chat/general`);
  await page.locator('.chat-message').first().waitFor();

  for (const width of [390, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await expect(page.locator('.mobile-menu')).toBeVisible();
    await expect(page.locator('.mobile-menu')).toHaveAttribute('aria-controls', 'campus-navigation');
    for (const theme of ['dark', 'light']) {
      await appearance(theme);
      await page.locator('.chat-message').first().waitFor();
      await assertHeader(width);
      await assertReadableChat(width, theme);
    }
    report(`${width}px header fits, hamburger remains available, light and dark text stays readable`);
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  const trigger = page.locator('.mobile-menu');
  if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click();
  const spaciousWidth = (await page.locator('.app-main').boundingBox()).width;
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.app-shell')).toHaveClass(/navigation-expanded/);
  await expect(page.locator('.navigation-columns')).toBeVisible();
  const expandedWidth = (await page.locator('.app-main').boundingBox()).width;
  assert.ok(spaciousWidth >= expandedWidth + 250, `Collapsing navigation enlarges chat (${expandedWidth}px → ${spaciousWidth}px)`);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  report('desktop hamburger releases substantial chat space and remembers collapsed navigation');

  for (const width of [390, 768, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const drawer = page.locator('.navigation-columns.drawer-open');
    await expect(drawer).toHaveAttribute('role', 'dialog');
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 18; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await drawer.evaluate(element => element.contains(document.activeElement)), true, `${width}px drawer traps keyboard focus`);
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  report('phone and tablet drawers trap keyboard focus; Escape closes and restores the trigger');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.app-header .language-selector')).toBeHidden();
  await expect(page.locator('.app-header .theme-toggle')).toBeHidden();
  await trigger.click();
  await page.locator('.navigation-columns.drawer-open a[href="/app/settings"]').click();
  await page.waitForURL('**/app/settings');
  await expect(page.locator('.study-language-options')).toBeVisible();
  await expect(page.locator('.study-appearance-options')).toBeVisible();
  await page.locator('.study-appearance-options button[data-theme-option="dark"]').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('campus-theme'))).toBe('dark');
  await selectLanguage(page, 'AR');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.goto(`${origin}/app/chat/general`);
  await page.locator('.chat-message').first().waitFor();
  await assertHeader(390);
  await assertReadableChat(390, 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.setViewportSize({ width: 1024, height: 1000 });
  await assertHeader(1024);
  await selectLanguage(page, 'FR');
  report('phone settings contain language and appearance; preferences persist and Arabic RTL remains clear');
  assert.deepEqual(errors, [], 'Browser runtime errors');
} catch (error) {
  console.error('FAILED RESPONSIVE PAGE', page.url(), error.message);
  await page.screenshot({ path: '/tmp/campuslink-responsive-test-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context.request.patch(`${origin}/api/profile`, { data: { language: 'fr' } }).catch(() => {});
  await browser.close();
}
