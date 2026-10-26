import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, firefox, expect as browserExpect } from '@playwright/test';

// All account and chat traffic is intercepted. These scenarios exercise the real
// frontend without touching campus accounts, messages, databases, or file storage.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const engine = process.env.CAMPUSLINK_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox'].includes(engine));
const browser = await ({ chromium, firefox })[engine].launch({ headless: true,
  ...(engine === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const expect = browserExpect.configure({ timeout: 15000 });
const output = `test-results/chat-backgrounds/${engine}`;
await mkdir(output, { recursive: true });
const report = { engine, passed: [], layouts: [], errors: [] };
const facultyNames = {
  fsa: 'Faculté des Sciences Appliquées', flaa: 'Faculté des Langues, des Lettres et des Arts',
  feg: 'Faculté d’Économie et de Gestion', fsjp: 'Faculté des Sciences Juridiques et Politiques',
};

async function fixture({ width = 1440, height = 960, language = 'fr', theme = 'dark', facultyId = 'fsa', filiereId = 'data_science', empty = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1100,
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(({ theme, language }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { theme, language });
  const user = { id: 2, username: 'background-fixture', name: 'Sara Benali', role: 'student',
    account_status: 'approved', faculty_id: facultyId, filiere_id: filiereId, current_semester: 1, language };
  const messages = [];
  if (!empty) for (const [channelIndex, channel] of ['general', 'important', 'filiere'].entries()) {
    const semesters = channel === 'filiere' ? [1, 3, 5] : [null];
    for (const semester of semesters) for (let index = 0; index < 30; index++) messages.push({
      id: 1000 + channelIndex * 1000 + (semester || 0) * 100 + index,
      faculty_id: facultyId,
      // General messages intentionally come from a different program. The
      // current chat, rather than its most recent author, owns the wallpaper.
      filiere_id: channel === 'general' ? 'biology' : filiereId,
      channel, semester, content: `${index + 1} — ${language === 'ar' ? 'نتشارك الملاحظات ونراجع الدروس معاً.' : 'On partage nos notes et nos questions de révision.'}`,
      author: index % 3 ? { id: 3, username: 'yassine', name: 'Yassine El Amrani' } : user,
      reactions: {}, attachments: [],
      created_at: new Date(Date.UTC(2026, 9, 23, 12, index * 6)).toISOString(),
    });
  }
  const errors = [], writes = [], assetResponses = [];
  const payload = () => ({ user, faculty: { id: facultyId, code: facultyId.toUpperCase(), name: facultyNames[facultyId] || 'Future faculty' },
    resources: [], announcements: [], messages, notifications: [], events: [], saved: [], history: [], members: [],
    channels: ['general', 'important', 'filiere'].map(id => ({ id, read_only: false })),
    realtime_capabilities: { presence: false }, messages_complete: true });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const send = json => route.fulfill({ json });
    if (path === '/api/session') return send({ user });
    if (path === '/api/bootstrap' || path === '/api/live') return send(payload());
    if (path === '/api/messages/read') return send({ discussion_unread_count: 0, discussion_unread_counts: [] });
    if (path === '/api/chat/blocks') return send({ blocks: [] });
    if (path === '/api/messages' && method === 'POST') {
      const body = request.postDataJSON();
      writes.push(body);
      const message = { ...body, id: 9000 + writes.length, author: user, faculty_id: facultyId, filiere_id: filiereId,
        reactions: {}, attachments: [], created_at: new Date().toISOString() };
      messages.push(message);
      return send({ message });
    }
    errors.push(`Unexpected fixture API request: ${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected chat background fixture request' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`Console: ${message.text()}`); });
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/chat-backgrounds/')) assetResponses.push({
      url: response.url(), status: response.status(), type: response.headers()['content-type'] || '',
    });
  });
  page.on('requestfailed', request => {
    if (!request.failure()?.errorText?.includes('ABORTED')) errors.push(`Failed request: ${request.url()} ${request.failure()?.errorText}`);
  });
  await page.goto(`${origin}/app/community?channel=general`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.community-history-wrap')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, writes, assetResponses, user, width, language };
}

async function background(f, id, scope) {
  const wrap = f.page.locator('.community-history-wrap');
  await expect(wrap).toHaveAttribute('data-chat-background', id);
  await expect(wrap).toHaveAttribute('data-chat-background-scope', scope);
  const css = await wrap.evaluate(node => {
    const style = getComputedStyle(node, '::before');
    return { image: style.maskImage || style.webkitMaskImage, size: style.maskSize,
      opacity: style.opacity, position: style.position, pointerEvents: style.pointerEvents,
      isolation: getComputedStyle(node).isolation, zIndex: style.zIndex,
      animation: style.animationName, color: style.backgroundColor };
  });
  assert.ok(css.image.includes(`/chat-backgrounds/${id}.svg`), `${id}: the actual CSS mask uses this academic asset`);
  assert.equal(css.pointerEvents, 'none', 'Decoration cannot intercept message gestures');
  assert.equal(css.position, 'absolute');
  assert.equal(css.isolation, 'isolate');
  assert.equal(css.zIndex, '-1');
  assert.equal(css.animation, 'none', 'Decoration needs no animation or frame loop');
  assert.ok(Number(css.opacity) > 0 && Number(css.opacity) <= 0.65, 'Decorative layer stays behind readable messages');
  await expect.poll(() => f.assetResponses.some(item => item.url.endsWith(`/chat-backgrounds/${id}.svg`) && item.status === 200 && item.type.includes('image/svg+xml'))).toBe(true);
  return css;
}

async function switchChannel(f, channel) {
  const page = f.page;
  if (f.width <= 760) await page.locator('.community-mobile-back').click();
  const buttons = page.locator('.community-channel-button');
  const index = ({ general: 0, important: 1, 'year-1': 2, 'year-3': 3, 'year-5': 4 })[channel];
  await buttons.nth(index).click();
  await expect(page).toHaveURL(new RegExp(`channel=${channel}`));
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map(value => Math.round(value * 1000) / 1000);
    };
    const history = document.querySelector('.community-message-history');
    return { history: rect(history), scrollHeight: history.scrollHeight, scrollTop: history.scrollTop,
      composer: rect(document.querySelector('.community-composer')),
      bubbles: [...history.querySelectorAll('.community-message-bubble')].map(rect),
      viewportWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth };
  });
}

async function fitsWithoutReflow(page, label) {
  const before = await geometry(page);
  assert.ok(before.scrollWidth <= before.viewportWidth + 1, `${label}: no horizontal page overflow`);
  const hidden = await page.addStyleTag({ content: '.community-history-wrap::before{content:none!important}' });
  const without = await geometry(page);
  assert.deepEqual(without, before, `${label}: wallpaper must not change bubble geometry or scrolling`);
  await hidden.evaluate(node => node.remove());
  const after = await geometry(page);
  assert.deepEqual(after, before);
  const layout = await page.evaluate(() => {
    const composer = document.querySelector('.community-composer').getBoundingClientRect();
    const history = document.querySelector('.community-message-history').getBoundingClientRect();
    const bottom = document.querySelector('.mobile-bottom-nav');
    const nav = bottom && getComputedStyle(bottom).display !== 'none' ? bottom.getBoundingClientRect() : null;
    return { composerBottom: composer.bottom, composerTop: composer.top, historyBottom: history.bottom,
      height: innerHeight, navTop: nav?.top ?? innerHeight };
  });
  assert.ok(layout.composerTop >= layout.historyBottom - 1, `${label}: composer remains outside the history`);
  assert.ok(layout.composerBottom <= layout.navTop + 1 && layout.composerBottom <= layout.height + 1, `${label}: composer remains reachable`);
  report.layouts.push({ label, ...layout, scrollHeight: before.scrollHeight, messages: before.bubbles.length });
}

async function interactions(f) {
  const { page } = f;
  const history = page.locator('.community-message-history');
  await history.evaluate(node => { node.scrollTop = 100; });
  await expect(page.locator('.community-latest-button')).toBeVisible();
  await page.locator('.community-latest-button').click();
  await expect.poll(() => history.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2);
  const message = page.locator('.community-message').last();
  const id = await message.getAttribute('data-message-id');
  await message.focus();
  await message.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Répondre', exact: true }).click();
  await expect(page.locator('.community-composer-reply')).toBeVisible();
  await page.locator('.community-composer-input textarea').fill('Une réponse avec le décor académique.');
  await page.locator('.community-composer-input button[type="submit"]').click();
  await expect(page.locator('[data-message-id="9001"]')).toBeVisible();
  assert.equal(f.writes[0].reply_to, id);
  assert.equal(f.writes[0].channel, 'general');
  await page.getByRole('button', { name: 'Rechercher dans la conversation', exact: true }).click();
  await page.locator('.community-search-bar input').fill('décor académique');
  await expect(page.locator('.community-message')).toHaveCount(1);
  await expect(page.locator('[data-message-id="9001"]')).toBeVisible();
  await page.locator('.community-search-bar input').fill('absent-research-term-xyz');
  await expect(page.locator('.community-message-history > .empty-state')).toBeVisible();
  await expect(page.locator('.community-history-wrap')).toHaveAttribute('data-chat-background', 'fsa');
  await page.getByRole('button', { name: 'Fermer la recherche', exact: true }).click();
  await expect(page.locator('.community-message')).toHaveCount(31);
  await page.locator('.community-composer-attach').click();
  await expect(page.locator('.community-attachment-menu')).toBeVisible();
  await page.locator('.community-composer-attach').click();
  await expect(page.locator('.community-attachment-menu')).toHaveCount(0);
}

try {
  const desktop = await fixture();
  try {
    await background(desktop, 'fsa', 'faculty');
    await fitsWithoutReflow(desktop.page, 'desktop-general-dark');
    await desktop.page.screenshot({ path: `${output}/desktop-fsa-general-dark.png` });
    for (const year of ['year-1', 'year-3', 'year-5']) {
      await switchChannel(desktop, year);
      await background(desktop, 'data_science', 'filiere');
    }
    await fitsWithoutReflow(desktop.page, 'desktop-data-science-dark');
    await desktop.page.screenshot({ path: `${output}/desktop-data-science-dark.png` });
    const current = await background(desktop, 'data_science', 'filiere');
    const assetUrls = new Set(desktop.assetResponses.map(item => item.url));
    await desktop.page.getByRole('button', { name: 'Changer de thème', exact: true }).click();
    await expect(desktop.page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await background(desktop, 'data_science', 'filiere');
    assert.notEqual(light.color, current.color, 'Existing theme switch recolors the same vector mask');
    assert.equal(light.image, current.image, 'Light/dark reuse the same vector asset');
    assert.ok(desktop.assetResponses.every(item => assetUrls.has(item.url)), 'Switching light/dark introduces no extra asset variant');
    await desktop.page.screenshot({ path: `${output}/desktop-data-science-light.png` });
    await switchChannel(desktop, 'important');
    await background(desktop, 'fsa', 'faculty');
    await switchChannel(desktop, 'general');
    await background(desktop, 'fsa', 'faculty');
    await interactions(desktop);
    await fitsWithoutReflow(desktop.page, 'desktop-after-send-reply-search');
    assert.deepEqual(desktop.errors, []);
    report.passed.push('Same-page faculty/program/year/important switching; live light/dark recolor; reply/send/search/attachment controls; scrolling; exact no-reflow comparison');
  } finally { report.errors.push(...desktop.errors); await desktop.context.close(); }

  const cases = [
    { width: 320, height: 700, theme: 'dark', language: 'ar', facultyId: 'fsa', filiereId: 'mathematics' },
    { width: 390, height: 844, theme: 'light', language: 'fr', facultyId: 'feg', filiereId: 'economics' },
    { width: 768, height: 1024, theme: 'light', language: 'ar', facultyId: 'flaa', filiereId: 'arabic_studies' },
    { width: 1440, height: 960, theme: 'dark', language: 'fr', facultyId: 'fsjp', filiereId: 'public_law' },
  ];
  for (const settings of cases) {
    const f = await fixture(settings), label = `${settings.width}-${settings.theme}-${settings.language}-${settings.filiereId}`;
    try {
      await background(f, settings.facultyId, 'faculty');
      await fitsWithoutReflow(f.page, `${label}-general`);
      await switchChannel(f, 'year-1');
      await background(f, settings.filiereId, 'filiere');
      await fitsWithoutReflow(f.page, `${label}-program`);
      await f.page.screenshot({ path: `${output}/${label}.png` });
      await switchChannel(f, 'important');
      await background(f, settings.facultyId, 'faculty');
      assert.deepEqual(f.errors, []);
      report.passed.push(`${label}: authentic faculty/program scope, responsive layout, unchanged message geometry`);
    } finally { report.errors.push(...f.errors); await f.context.close(); }
  }

  for (const settings of [
    { facultyId: 'fsa', filiereId: 'future_program', expected: 'fsa', scope: 'faculty' },
    { facultyId: 'future_faculty', filiereId: 'future_program', expected: 'academic', scope: 'academic' },
  ]) {
    const f = await fixture({ ...settings, empty: true, width: 390, height: 844, theme: 'light' });
    try {
      await switchChannel(f, 'year-1');
      await background(f, settings.expected, settings.scope);
      await expect(f.page.locator('.community-message-history > .empty-state')).toBeVisible();
      await f.page.locator('.community-message-history > .empty-state button').click();
      await expect(f.page.locator('.community-composer-input textarea')).toBeFocused();
      await fitsWithoutReflow(f.page, `${settings.expected}-empty-fallback`);
      assert.deepEqual(f.errors, []);
      report.passed.push(`${settings.expected}: safe fallback and empty chat focus stay functional`);
    } finally { report.errors.push(...f.errors); await f.context.close(); }
  }
  console.log(JSON.stringify({ engine, passed: report.passed.length, errors: report.errors }, null, 2));
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
