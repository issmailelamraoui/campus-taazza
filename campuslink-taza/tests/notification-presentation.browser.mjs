import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

// All API traffic is intercepted. These presentation checks never read or write
// campus accounts, notifications, database rows, or private object storage.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const output = 'test-results/notification-presentation';
await mkdir(output, { recursive: true });
const passed = [], measurements = [], failures = [];
const stamp = () => new Date().toISOString();
const shortBody = 'Une nouvelle demande attend votre réponse. Consultez les détails pour retrouver le bon étudiant.';
const longBody = Array.from({ length: 38 }, (_, i) => `${i + 1}. La demande contient des informations utiles à lire entièrement, même sur un petit écran. تفاصيل الإشعار واضحة ويمكن قراءة النص بالكامل.`).join('\n') + '\nFIN DU CONTENU — نهاية المحتوى';
const admission = (id, body = shortBody) => ({ id, type: 'admin', title: 'Nouvelle demande étudiante — طلب جديد', body, path: `/app/admin?tab=accounts&registration=51#registration-51`, created_at: stamp(), registration_user_id: 51, read: false, target_available: true, popup_eligible: true });

async function fixture({ width = 390, height = 844, theme = 'dark', language = 'fr', route = '/app/announcements' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1000, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(({ theme, language }) => {
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    const streams = [];
    window.EventSource = class extends EventTarget {
      constructor() { super(); streams.push(this); }
      close() { const i = streams.indexOf(this); if (i >= 0) streams.splice(i, 1); }
    };
    window.__presentationArrival = () => streams.forEach(stream => stream.dispatchEvent(new MessageEvent('update', { data: '{"registrations":true}' })));
    window.__presentationStreams = () => streams.length;
    const native = window.visualViewport, viewport = new EventTarget();
    let keyboard = null;
    Object.defineProperties(viewport, {
      height: { get: () => keyboard?.height ?? native.height },
      width: { get: () => native.width },
      offsetTop: { get: () => keyboard?.top ?? native.offsetTop },
      offsetLeft: { get: () => native.offsetLeft },
      scale: { get: () => native.scale },
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.__presentationKeyboard = (height, top = 0) => {
      keyboard = height === null ? null : { height, top };
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
    const realVisibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    let syntheticVisibility = null;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => syntheticVisibility ?? realVisibility.get.call(document) });
    window.__presentationVisibility = value => { syntheticVisibility = value; document.dispatchEvent(new Event('visibilitychange')); };
  }, { theme, language });
  const user = { id: 2, username: 'notice-presentation-fixture', name: 'Notification fixture', role: 'global_admin', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language, preferences: {} };
  const announcement = { id: 61, title: 'Présentation des notifications', content: 'Une annonce isolée pour vérifier les retours de sauvegarde.', faculty_id: 'flaa', created_at: stamp(), author: { id: 4, name: 'Fixture teacher' }, kind: 'administration', pinned: false };
  const messages = Array.from({ length: 25 }, (_, i) => ({ id: i + 101, channel: 'general', faculty_id: 'flaa', filiere_id: 'french_studies', semester: 1, content: `Message de test ${i + 1} — L’affichage conserve la place de la discussion.`, author: { id: 4, name: 'Fixture student', username: 'fixture.student' }, created_at: stamp(), reactions: {}, attachments: [] }));
  let notices = [{ id: 10, type: 'announcements', title: 'Information de votre faculté', body: shortBody, path: '/app/announcements#announcement-61', created_at: stamp(), read: false, target_available: true, popup_eligible: false }];
  let saves = [], saved = false, saveError = null, bootstrapCount = 0;
  const reads = [];
  const errors = [], unexpected = [];
  const payload = () => ({ user, faculty: { id: 'flaa', code: 'FLAA', name: 'Fixture faculty' }, resources: [], announcements: [announcement], messages, notifications: notices, unread_count: notices.filter(n => !n.read).length, admin_unread_count: notices.filter(n => !n.read && n.popup_eligible).length, discussion_unread_count: 0, discussion_unread_counts: [], saved: saved ? [{ type: 'announcement', id: 61 }] : [], events: [], history: [], channels: [{ id: 'general', read_only: false }], members: [user] });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap' || path === '/api/live') { bootstrapCount++; return route.fulfill({ json: { ...payload(), messages_complete: true } }); }
    if (path === '/api/saved' && request.method() === 'POST') {
      saves.push(request.postDataJSON());
      if (saveError) return route.fulfill({ status: 500, json: { error: saveError } });
      saved = !saved;
      return route.fulfill({ json: { saved } });
    }
    const read = /^\/api\/notifications\/(\d+)\/read$/.exec(path);
    if (read && request.method() === 'POST') {
      reads.push(Number(read[1]));
      notices = notices.map(item => item.id === Number(read[1]) ? { ...item, read: true } : item);
      return route.fulfill({ json: payload() });
    }
    if (path === '/api/chat/blocks') return route.fulfill({ json: { blocks: [] } });
    if (path === '/api/messages/read') return route.fulfill({ json: { discussion_unread_count: 0 } });
    if (path === '/api/admin') return route.fulfill({ json: { users: [user], resources: [], announcements: [announcement], channels: [], contacts: [], reports: [] } });
    if (path === '/api/admin/registrations') return route.fulfill({ json: { requests: [{ ...user, id: 51, name: 'Pending presentation student', username: 'presentation.student', role: 'student', email: 'presentation@student.test', account_status: 'pending', registered_at: stamp() }] } });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 503, json: { error: 'Unexpected isolated presentation fixture request.' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + route);
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__presentationStreams())).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, unexpected, saves, reads,
    async arrive(item, { displayed = true } = {}) {
      const previous = bootstrapCount;
      notices = [item, ...notices];
      await page.evaluate(() => window.__presentationArrival());
      await expect.poll(() => bootstrapCount).toBeGreaterThan(previous);
      if (displayed) await expect(page.locator(`.admin-notification-popup[data-notification-id="${item.id}"]`)).toBeVisible();
    },
    failSave(message = longBody) { saveError = message; },
  };
}

async function fits(locator, label) {
  const geometry = await locator.evaluate(node => {
    const r = node.getBoundingClientRect(), v = window.visualViewport;
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, top: v.offsetTop, left: v.offsetLeft, availableWidth: v.width, availableHeight: v.height, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  assert.ok(geometry.x >= geometry.left - 1 && geometry.right <= geometry.left + geometry.availableWidth + 1 && geometry.y >= geometry.top - 1 && geometry.bottom <= geometry.top + geometry.availableHeight + 1, `${label} fits the visible viewport: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.overflow, false, label + ' causes no horizontal page overflow');
  measurements.push({ label, geometry });
}

async function contrast(locator, label, minimumSize = 14) {
  const result = await locator.evaluate(node => {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = canvas.height = 1;
    const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((n, i) => i === 3 ? n / 255 : n); };
    const over = (front, back) => [...front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3])), 1];
    const chain = []; for (let n = node; n; n = n.parentElement) chain.push(n);
    const background = chain.reverse().reduce((bg, n) => over(rgba(getComputedStyle(n).backgroundColor), bg), [255, 255, 255, 1]);
    const style = getComputedStyle(node), foreground = over(rgba(style.color), background);
    const luminance = color => color.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const a = luminance(foreground), b = luminance(background);
    return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), foreground, background, fontSize: parseFloat(style.fontSize) };
  });
  assert.ok(result.ratio >= 4.5, `${label}: text contrast >= 4.5:1: ${JSON.stringify(result)}`);
  assert.ok(result.fontSize >= minimumSize, `${label}: legible font size >= ${minimumSize}px: ${JSON.stringify(result)}`);
  measurements.push({ label, contrast: result });
}

async function controlsFit(popup, phone) {
  const close = popup.locator('.admin-notification-popup-close');
  const r = await close.boundingBox();
  if (phone) assert.ok(r.width >= 44 && r.height >= 44, `Phone notification close target >=44px: ${JSON.stringify(r)}`);
  await expect(close).toBeEnabled();
}

async function tailReadable(locator, label) {
  const result = await locator.evaluate(node => {
    const scrollers = []; for (let n = node; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (n.scrollHeight > n.clientHeight + 2 && /(auto|scroll)/.test(s.overflowY)) scrollers.push(n);
    }
    for (const n of scrollers.reverse()) n.scrollTop = n.scrollHeight;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let text, last;
    while ((text = walker.nextNode())) if (text.textContent.trim()) last = text;
    const range = document.createRange(); range.setStart(last, Math.max(0, last.length - 4)); range.setEnd(last, last.length);
    const r = range.getBoundingClientRect();
    let visibleTop = window.visualViewport.offsetTop, visibleBottom = visibleTop + window.visualViewport.height;
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n), box = n.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { visibleTop = Math.max(visibleTop, box.top); visibleBottom = Math.min(visibleBottom, box.bottom); }
    }
    return { scrollers: scrollers.length, top: r.top, bottom: r.bottom, visibleTop, visibleBottom, content: node.textContent };
  });
  assert.ok(result.content.includes('FIN DU CONTENU'), label + ' preserves the entire message');
  assert.ok(result.top >= result.visibleTop - 2 && result.bottom <= result.visibleBottom + 2, `${label}: the final text line can be read: ${JSON.stringify(result)}`);
  measurements.push({ label, tail: { ...result, content: undefined } });
}

async function checked(label, settings, run) {
  if (process.env.CAMPUSLINK_NOTIFICATION_SCENARIOS && !new RegExp(process.env.CAMPUSLINK_NOTIFICATION_SCENARIOS).test(label)) return;
  const f = await fixture(settings);
  try {
    await run(f);
    assert.deepEqual(f.errors, [], label + ' has no browser errors');
    assert.deepEqual(f.unexpected, [], label + ' uses only isolated fixture API requests');
    passed.push(label);
    console.log('PASS ' + label);
  } catch (error) {
    failures.push({ label, message: error.message });
    await f.page.screenshot({ path: `${output}/failure-${label.replace(/[^a-z0-9]+/gi, '-')}.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally { await f.context.close(); }
}

try {
  const sizes = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }];
  for (const theme of ['dark', 'light']) for (const size of sizes) {
    const label = `${size.width}-${theme}-fr`;
    await checked(label, { ...size, theme }, async ({ page, arrive }) => {
      const input = page.locator('.toolbar input');
      await input.focus();
      await arrive(admission(21));
      await expect(input).toBeFocused();
      const popup = page.locator('.admin-notification-popup');
      await fits(popup, label + ' live popup');
      await contrast(popup.locator('strong'), label + ' popup title');
      await contrast(popup.locator('p'), label + ' popup body');
      await contrast(popup.locator('.admin-notification-popup-open'), label + ' popup action');
      await controlsFit(popup, size.width <= 768);
      await page.screenshot({ path: `${output}/${label}-arrival.png`, animations: 'disabled' });
      await page.locator('.admin-notification-popup-close').click();
      await page.locator('.notification-button').click();
      const panel = page.locator('.notification-popover');
      await expect(panel).toBeVisible();
      await fits(panel, label + ' bell panel');
      await contrast(panel.locator('.notification-content strong').first(), label + ' bell title');
      await contrast(panel.locator('.notification-content p').first(), label + ' bell body');
      await page.screenshot({ path: `${output}/${label}.png`, animations: 'disabled' });
      await page.goto(origin + '/app/notifications');
      await contrast(page.locator('.notification-content p').first(), label + ' inbox body');
    });
  }
  for (const theme of ['dark', 'light']) await checked(`390-${theme}-ar`, { theme, language: 'ar' }, async ({ page, arrive }) => {
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await arrive(admission(22));
    const popup = page.locator('.admin-notification-popup');
    await fits(popup, `${theme} RTL popup`);
    await contrast(popup.locator('p'), `${theme} RTL body`);
    await controlsFit(popup, true);
    await popup.locator('.admin-notification-popup-close').click();
    await page.locator('.notification-button').click();
    await fits(page.locator('.notification-popover'), `${theme} RTL bell`);
    await page.screenshot({ path: `${output}/390-${theme}-ar.png`, animations: 'disabled' });
  });

  for (const settings of [{ width: 320, height: 568, theme: 'dark' }, { width: 1440, height: 900, theme: 'light' }]) await checked(`${settings.width}-${settings.theme}-long-modal-toast`, settings, async ({ page, arrive, failSave }) => {
    await page.locator('.announcement-body').click();
    const modal = page.locator('.modal');
    await expect(modal).toBeVisible();
    const initialFocus = await page.evaluate(() => document.activeElement === document.querySelector('.modal'));
    assert.equal(initialFocus, true);
    await arrive(admission(23, longBody));
    const popup = page.locator('.admin-notification-popup');
    await fits(popup, 'Long popup above modal');
    const above = await popup.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 20)); });
    assert.equal(above, true, 'Arrival stays visible above the modal backdrop');
    await expect(modal).toBeFocused();
    await tailReadable(popup.locator('p'), 'Long popup');
    await popup.locator('.admin-notification-popup-close').click();
    failSave();
    await modal.locator('.detail-actions .btn').first().click();
    const toast = page.locator('.toast[data-type="error"]');
    await expect(toast).toBeVisible();
    await fits(toast, 'Long error toast');
    await contrast(toast.locator('.toast-copy > strong'), 'Error toast title');
    await contrast(toast.locator('.toast-copy > p'), 'Error toast body');
    await tailReadable(toast.locator('.toast-copy > p'), 'Long error toast');
    const close = toast.locator('button');
    if (settings.width === 320) { const r = await close.boundingBox(); assert.ok(r.width >= 44 && r.height >= 44, 'Toast phone close target is 44px'); }
    await close.click();
    await expect(toast).toHaveCount(0);
    await expect(modal).toBeVisible();
  });

  for (const theme of ['dark', 'light']) await checked(`390-${theme}-chat-keyboard`, { theme, route: '/app/community?channel=general' }, async ({ page, arrive }) => {
    const composer = page.locator('.community-composer-input textarea');
    await expect(composer).toBeVisible();
    await expect(page.locator('.app-header')).toBeHidden();
    await composer.fill('Une notification ne doit pas interrompre ce brouillon.');
    await composer.focus();
    await page.evaluate(() => window.__presentationKeyboard(340, 24));
    await arrive(admission(24));
    const popup = page.locator('.admin-notification-popup');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('Une notification ne doit pas interrompre ce brouillon.');
    await fits(popup, `${theme} keyboard popup`);
    assert.equal(await popup.evaluate(node => node.closest('.app-shell--community') === null), true, 'Immersive chat cannot trap alerts in its fixed stacking context');
    await contrast(popup.locator('p'), `${theme} keyboard body`);
    await page.screenshot({ path: `${output}/390-${theme}-chat-keyboard.png`, animations: 'disabled' });
    await page.evaluate(() => window.__presentationKeyboard(null));
    await expect(composer).toBeFocused();
    await fits(popup, `${theme} restored viewport popup`);
    await popup.locator('.admin-notification-popup-close').click();
    await expect(popup).toHaveCount(0);
  });

  await checked('390-light-portal-notification-navigation', { theme: 'light' }, async ({ page, arrive, reads }) => {
    await page.locator('.announcement-body').click();
    await expect(page.locator('.modal')).toBeVisible();
    await arrive(admission(26));
    await page.locator('.admin-notification-popup-open').click();
    await expect(page).toHaveURL(url => url.pathname === '/app/admin' && url.searchParams.get('tab') === 'accounts' && url.searchParams.get('registration') === '51' && url.hash === '#registration-51');
    await expect(page.locator('.admin-notification-popup')).toHaveCount(0);
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('#registration-51')).toBeVisible();
    await expect(page.locator('#registration-51')).toHaveClass(/admin-notification-target/);
    await expect(page.locator('#registration-51')).toBeFocused();
    assert.deepEqual(reads, [26], 'Opening a portal popup preserves the existing read receipt contract');
  });

  await checked('320-dark-short-viewport-burst', { width: 320, height: 360 }, async ({ page, arrive, reads }) => {
    await page.locator('.announcement-card .announcement-controls > .icon-btn').last().click();
    const toast = page.locator('.toast[data-type="success"]');
    await expect(toast).toBeVisible();
    await toast.hover();
    for (const id of [31, 32, 33, 34]) await arrive(admission(id), { displayed: id !== 34 });
    await expect(page.locator('.admin-notification-popup')).toHaveCount(3);
    await expect(page.locator('.admin-notification-popup[data-notification-id="34"]')).toHaveCount(0);
    await fits(page.locator('.notification-overlay'), 'Short viewport shared overlay');
    await fits(toast, 'Short viewport toast');
    const stack = page.locator('.admin-notification-popups');
    await fits(stack, 'Short viewport scrollable popup stack');
    assert.equal(await stack.evaluate(node => node.scrollHeight > node.clientHeight + 1), true, 'A notification burst scrolls inside the remaining visible space');
    const toastRect = await toast.boundingBox(), stackRect = await stack.boundingBox();
    assert.ok(toastRect.y + toastRect.height <= stackRect.y + 1, 'The popup stack starts after the toast');
    await page.screenshot({ path: `${output}/320-dark-short-viewport-toast-burst.png`, animations: 'disabled' });
    await page.locator('.admin-notification-popup[data-notification-id="31"] .admin-notification-popup-close').click();
    await expect(page.locator('.admin-notification-popup[data-notification-id="34"]')).toBeVisible();
    await expect(page.locator('.admin-notification-popup')).toHaveCount(3);
    const fourthClose = page.locator('.admin-notification-popup[data-notification-id="34"] .admin-notification-popup-close');
    await fourthClose.scrollIntoViewIfNeeded();
    await fourthClose.click();
    await expect(page.locator('.admin-notification-popup[data-notification-id="34"]')).toHaveCount(0);
    const lastOpen = page.locator('.admin-notification-popup[data-notification-id="33"] .admin-notification-popup-open');
    await lastOpen.scrollIntoViewIfNeeded();
    await lastOpen.click();
    await expect(page).toHaveURL(url => url.pathname === '/app/admin' && url.searchParams.get('registration') === '51');
    assert.deepEqual(reads, [33], 'The last queued card remains actionable within the scrollable stack');
  });

  await checked('1440-dark-toast-lifetime-and-coexistence', { width: 1440, height: 900 }, async ({ page, arrive, failSave }) => {
    await page.clock.install();
    const save = page.locator('.announcement-card .announcement-controls > .icon-btn').last();
    await save.click();
    const success = page.locator('.toast[data-type="success"]');
    await expect(success).toBeVisible();
    await contrast(success.locator('.toast-copy > p'), 'Success toast body');
    await success.hover();
    await page.clock.runFor(20000);
    await expect(success).toBeVisible();
    await success.locator('button').focus();
    await page.mouse.move(10, 10);
    await page.clock.runFor(20000);
    await expect(success).toBeVisible();
    await page.evaluate(() => window.__presentationVisibility('hidden'));
    await page.locator('.toolbar input').focus();
    await page.clock.runFor(20000);
    await expect(success).toBeVisible();
    await page.evaluate(() => window.__presentationVisibility('visible'));
    await page.clock.runFor(20000);
    await expect(success).toHaveCount(0);
    failSave();
    await save.click();
    const error = page.locator('.toast[data-type="error"]');
    await expect(error).toBeVisible();
    await page.mouse.move(10, 10);
    await page.clock.runFor(60000);
    await expect(error).toBeVisible();
    await arrive(admission(25));
    const popup = page.locator('.admin-notification-popup');
    const a = await error.boundingBox(), b = await popup.boundingBox();
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'A toast and arriving popup do not overlap');
    await page.screenshot({ path: `${output}/1440-dark-error-toast-and-popup.png`, animations: 'disabled' });
    await error.locator('button').click();
    await expect(error).toHaveCount(0);
    await popup.locator('.admin-notification-popup-close').click();
  });
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify({ passed, failures, measurements }, null, 2));
  await browser.close();
}
console.log(`PASS ${passed.length} isolated notification presentation scenarios`);
