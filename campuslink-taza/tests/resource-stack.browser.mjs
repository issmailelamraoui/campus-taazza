import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDemoPdf } from '../src/utils.js';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = join(process.cwd(), 'test-results');
const prefix = 'campuslink-prototype-v1:';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(output, { recursive: true });
const passed = [], problems = [], performance = {};
let activePage;

function resources(count, { long = false } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `stack-file-${index}`, title: long && index === 1 ? 'Analyse des documents littéraires et interprétation des textes — دراسة النصوص الأدبية وطرق فهمها بالتفصيل'.repeat(2) : `Document récent ${String(index + 1).padStart(4, '0')}`,
    originalName: long && index === 1 ? `${'Notes détaillées — ملاحظات مفصلة '.repeat(3)}.pdf` : `Document-${index + 1}.pdf`,
    module: long && index === 1 ? 'Méthodes de lecture et d’analyse des documents littéraires — طرق التحليل'.repeat(2) : `Module ${index + 1}`,
    semester: index % 6 + 1, category: ['courses', 'exercises', 'exams', 'rattrapage'][index % 4], part: index % 3 === 0 ? 'complete' : String(index + 1),
    author: 'Équipe pédagogique', uploader: 'Sara Benali', date: new Date(Date.UTC(2026, 9, 9, 12) - index * 60000).toISOString(),
    size: '1.4 Mo', fileType: 'PDF', facultyId: 'flaa', filiereId: 'french_studies', status: 'approved', sample: true,
  }));
}

async function setup({ count = 8, width = 390, height = 844, theme = 'dark', language = 'fr', long = false, reducedMotion = 'no-preference', legacyAPIs = false } = {}) {
  const fixtures = resources(count, { long });
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, reducedMotion, locale: 'fr-FR' });
  await context.addInitScript(({ prefix, theme, language, legacyAPIs }) => {
    const set = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    set('theme', theme); set('language', language);
    const raf = window.requestAnimationFrame.bind(window);
    window.__stackRafRequests = 0;
    window.requestAnimationFrame = callback => { window.__stackRafRequests++; return raf(callback); };
    if (legacyAPIs) {
      window.ResizeObserver = undefined;
      Object.defineProperty(MediaQueryList.prototype, 'addEventListener', { configurable: true, value: undefined });
      Object.defineProperty(MediaQueryList.prototype, 'removeEventListener', { configurable: true, value: undefined });
      delete HTMLElement.prototype.inert;
    }
  }, { prefix, theme, language, legacyAPIs });
  let fixtureLoaded = false, bootstrapLoads = 0;
  const saved = [];
  const user = { id: 1, username: 'sara.demo', name: 'Sara Benali', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language };
  const apiDocument = file => ({ ...file, faculty_id: file.facultyId, filiere_id: file.filiereId, filename: file.originalName, size: 1468006, part_number: file.part, teacher_name: file.author, created_at: file.date, author: { id: 1, name: file.uploader }, resource_type: file.category, library_visible: true });
  let documents = fixtures.map(apiDocument);
  const payload = () => ({ user, faculty: {id:'flaa',code:'FLAA',name:'Faculté des Langues, des Lettres et des Arts'}, resources:documents, messages:[{id:101,faculty_id:'flaa',channel:'general',content:'Échanges autour des ressources du campus.',created_at:'2026-10-09T09:00:00Z',author:{id:2,name:'Yassine',username:'yassine'}},{id:102,faculty_id:'flaa',filiere_id:'french_studies',channel:'filiere',semester:1,content:'Un espace pour préparer les cours ensemble.',created_at:'2026-10-09T09:00:00Z',author:{id:2,name:'Yassine',username:'yassine'}}], announcements:[{id:201,faculty_id:'flaa',title:'Actualités de votre faculté',content:'Retrouvez les dates et informations utiles du campus.',created_at:'2026-10-09T09:00:00Z',author:{name:'Administration'}},{id:202,faculty_id:'flaa',title:'Les ressources de votre filière',content:'Consultez les cours et les documents partagés.',created_at:'2026-10-09T09:00:00Z',author:{name:'Administration'}}], notifications:[], events:[], saved, history:[], channels:[], members:[] });
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/bootstrap') { fixtureLoaded = true; bootstrapLoads++; return route.fulfill({json:payload()}); }
    if (path === '/api/session') return route.fulfill({json:{user}});
    if (path === '/api/saved') {
      const body = route.request().postDataJSON(), at = saved.findIndex(item => item.type === body.type && item.id === body.id);
      if(at < 0) saved.push({type:body.type,id:body.id}); else saved.splice(at,1);
      return route.fulfill({json:{saved:at<0}});
    }
    if (path === '/api/history') return route.fulfill({json:{ok:true}});
    if (path.startsWith('/api/files/')) {
      const file=fixtures.find(file=>path.endsWith('/'+file.id));
      return route.fulfill({contentType:'application/pdf',body:makeDemoPdf(file?.title||'Document',file?.module||'Module')});
    }
    throw new Error('Unexpected fixture API request: '+path);
  });
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => problems.push(`Runtime: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`Console: ${message.text()}`); });
  page.on('request', request => { if (/neon\.tech|r2\.dev/.test(request.url())) problems.push(`Backend: ${request.url()}`); });
  await page.goto(`${baseURL}/app`);
  await expect(page.locator('.home-welcome')).toBeVisible();
  assert.ok(fixtureLoaded, 'The test must exercise injected resources rather than unrelated seed documents');
  const refreshFixtures = async (next = fixtures) => {
    documents = next.map(apiDocument);
    const before = bootstrapLoads;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => bootstrapLoads).toBeGreaterThan(before);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  return { context, page, fixtures, saved, refreshFixtures };
}

const stack = page => page.locator('.resource-stack');
const viewport = page => page.locator('.resource-stack-scroll');
const layer = (page, index) => page.locator(`.resource-stack [data-stack-index="${index}"]`);
const recentSection = page => page.locator('.home-section').filter({ has: page.locator('.section-heading h2', { hasText: /Ressources récentes|Recent resources|الموارد الحديثة/ }) });
async function index(page) { return Number(await stack(page).getAttribute('data-active-index')); }
async function screenshot(page, name) { await page.screenshot({ path: join(output, `resource-stack-${name}.png`), animations: 'disabled' }); }
async function scenario(name, run) {
  const filter = process.env.CAMPUSLINK_STACK_TEST_FILTER;
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  await run(); passed.push(name); console.log(`PASS ${name}`);
}
async function settled(page) {
  let previous = -1, repeats = 0;
  await expect.poll(async () => {
    const position = await viewport(page).evaluate(node => node.scrollTop);
    if (Math.abs(position - previous) < 0.5) repeats++; else repeats = 0;
    previous = position; return repeats;
  }, { intervals: [70, 70, 100, 150], timeout: 10000 }).toBeGreaterThanOrEqual(3);
  const alignment = await viewport(page).evaluate(node => {
    const root = node.closest('.resource-stack');
    return { position: node.scrollTop, target: Number(root.dataset.activeIndex) * Number(root.dataset.scrollStep) };
  });
  assert.ok(Math.abs(alignment.position - alignment.target) <= 1, `Settled file must be fully aligned: ${JSON.stringify(alignment)}`);
}
async function bringStack(page) {
  await stack(page).evaluate(node => {
    const header = document.querySelector('.app-header')?.getBoundingClientRect().bottom || 0;
    window.scrollBy({ top: node.getBoundingClientRect().top - header - 15, behavior: 'instant' });
  });
  await page.waitForTimeout(80);
}
async function touchSwipe(page, distance, { target = viewport(page), duration = 380, during, beforeEnd } = {}) {
  const box = await target.boundingBox();
  assert.ok(box, 'Touch target must be rendered');
  const windowSize = page.viewportSize();
  const top = Math.max(box.y, 78), bottom = Math.min(box.y + box.height, windowSize.height - 85);
  const center = (top + bottom) / 2;
  const travel = Math.min(Math.abs(distance), bottom - top - 20);
  assert.ok(travel > 20, `Touch target does not leave a usable gesture area: ${JSON.stringify(box)}`);
  const actual = Math.sign(distance) * travel;
  const point = { x: box.x + box.width * 0.55, y: center + actual / 2, radiusX: 3, radiusY: 3, force: 1, id: 1 };
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  const steps = 14;
  for (let step = 1; step <= steps; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y - actual * step / steps }] });
    if (step === 7 && during) await during({ distance: actual * step / steps });
    await page.waitForTimeout(duration / steps);
  }
  if (beforeEnd) await beforeEnd({ distance: actual });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}
async function goTo(page, position) {
  await viewport(page).evaluate((node, position) => { node.scrollTop = position; }, position);
  await settled(page);
}
async function heldTouch(page, run) {
  const box = await viewport(page).boundingBox();
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: Math.max(90, box.y + 45), radiusX: 3, radiusY: 3, force: 1, id: 1 }] });
  try { await run(); }
  finally {
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await session.detach();
  }
  await settled(page);
}
async function fit(page) {
  const bounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(bounds.scrollWidth <= bounds.width + 1, `Horizontal overflow: ${JSON.stringify(bounds)}`);
  const active = layer(page, await index(page));
  const result = await active.evaluate(node => {
    const card = node.querySelector('.document-card'), scroll = node.closest('.resource-stack-scroll');
    const r = card.getBoundingClientRect(), v = scroll.getBoundingClientRect();
    return { card: { top: r.top, bottom: r.bottom, height: r.height }, viewport: { top: v.top, bottom: v.bottom, height: v.height }, innerWidth: card.clientWidth, scrollWidth: card.scrollWidth };
  });
  assert.ok(result.card.top >= result.viewport.top - 2 && result.card.bottom <= result.viewport.bottom + 2, `Active file information is clipped: ${JSON.stringify(result)}`);
  assert.ok(result.scrollWidth <= result.innerWidth + 1, `File card content overflows: ${JSON.stringify(result)}`);
  return result;
}

try {
  await scenario('Mobile shows a compact overlapping pile with original file information and actions', async () => {
    const { context, page, fixtures, saved } = await setup();
    await expect(stack(page)).toHaveAttribute('data-count', '8');
    await expect(stack(page)).toHaveAttribute('data-active-index', '0');
    await bringStack(page); await fit(page);
    const front = layer(page, 0).locator('.document-card');
    const metadata = await front.innerText();
    for (const value of [fixtures[0].title, fixtures[0].originalName, fixtures[0].module, 'S1', fixtures[0].author, fixtures[0].uploader, 'PDF', '1.4 Mo', 'Complet']) assert.ok(metadata.includes(value), `Missing original file information: ${value}`);
    await expect(front.locator('.document-category')).toHaveText('Cours');
    await expect(front.locator('.document-date')).not.toBeEmpty();
    const geometry = await stack(page).evaluate(root => {
      const cards = [...root.querySelectorAll('[data-stack-index] .document-card')].map(node => {
        const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height };
      });
      return { cards, stackHeight: root.getBoundingClientRect().height };
    });
    assert.ok(geometry.cards.length >= 2, 'More than one resource should be visible as a document pile');
    assert.ok(geometry.cards[1].top < geometry.cards[0].bottom - 20, 'The second card must overlap the first rather than form a vertical list');
    assert.ok(geometry.stackHeight < geometry.cards[0].height + 110, 'Pile framing must stay compact');
    await front.locator('.save-btn').tap();
    await expect(front.locator('.save-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await front.locator('.document-main').tap();
    await expect(page.locator('.preview-modal')).toBeVisible();
    await expect(page.locator('.preview-modal')).toContainText(fixtures[0].title);
    await expect(page.locator('.preview-meta')).toContainText(fixtures[0].module);
    await page.keyboard.press('Escape');
    assert.deepEqual(saved.map(item=>item.id), [fixtures[0].id]);
    await screenshot(page, 'mobile-dark-front'); await context.close();
  });

  await scenario('Native finger swipes progressively move documents, advance beyond three and return', async () => {
    const { context, page } = await setup({ count: 8, theme: 'light' });
    await bringStack(page);
    const before = await layer(page, 0).locator('.document-card').boundingBox();
    let progressive;
    await touchSwipe(page, 130, { duration: 500, during: async ({ distance }) => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const moved = await layer(page, 0).locator('.document-card').boundingBox();
      progressive = { before: before.y, during: moved?.y, fingerDistance: distance, position: await viewport(page).evaluate(node => node.scrollTop) };
      assert.equal(await index(page), 0, 'The accessible selection changes when the gesture settles');
    } });
    await settled(page);
    assert.ok(progressive.position > 0 && progressive.during < progressive.before - 5, `Card should follow the native finger scroll before release: ${JSON.stringify(progressive)}`);
    assert.ok(Math.abs(progressive.before - progressive.during - progressive.fingerDistance) <= 3, `The departing card must track the finger one pixel per pixel: ${JSON.stringify(progressive)}`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => index(page)).toBeGreaterThan(0);
    let forward = await index(page);
    for (let attempt = 0; attempt < 15 && forward < 7; attempt++) {
      await touchSwipe(page, 135, { duration: 470 }); await settled(page);
      forward = await index(page); await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    assert.equal(forward, 7, 'Touch interaction must reach every available file, including those beyond the old three-file limit');
    await fit(page); await screenshot(page, 'mobile-light-last');
    const reverseBefore = await layer(page, 6).locator('.document-card').boundingBox();
    await touchSwipe(page, -135, { duration: 470, during: async ({ distance }) => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const reversed = await layer(page, 6).locator('.document-card').boundingBox();
      assert.ok(Math.abs(reversed.y - reverseBefore.y + distance) <= 3, `The returning previous card must track the reverse finger motion: ${JSON.stringify({ before: reverseBefore.y, during: reversed.y, distance })}`);
      assert.equal(await index(page), 7, 'Reverse motion preserves the selection until rest');
    } });
    await settled(page);
    for (let attempt = 0; attempt < 15 && await index(page) > 0; attempt++) {
      await touchSwipe(page, -135, { duration: 470 }); await settled(page);
    }
    assert.equal(await index(page), 0, 'Inverse touch motion must reach previous files and restore the first');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await fit(page); await context.close();
  });

  await scenario('The pile leaves ordinary Home scrolling intact and chains at its ends', async () => {
    const { context, page } = await setup({ count: 5, height: 600 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const outside = page.locator('.home-welcome');
    const outsideBefore = await page.evaluate(() => window.scrollY);
    await touchSwipe(page, 115, { target: outside });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(outsideBefore + 10);
    assert.equal(await index(page), 0, 'Page scrolling outside the pile must not advance a file');
    await bringStack(page); await goTo(page, 0);
    const topBefore = await page.evaluate(() => window.scrollY);
    await touchSwipe(page, -120);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(topBefore - 10);
    await bringStack(page);
    await viewport(page).evaluate(node => { node.scrollTop = node.scrollHeight; }); await settled(page);
    assert.equal(await index(page), 4);
    const bottomBefore = await page.evaluate(() => window.scrollY);
    const bottomRoom = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight - window.scrollY);
    assert.ok(bottomRoom > 30, `End chaining needs actual outer-page scroll room; available ${bottomRoom}px`);
    await touchSwipe(page, 120);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(bottomBefore + 10);
    assert.equal(await index(page), 4);
    const behavior = await viewport(page).evaluate(node => ({ overflow: getComputedStyle(node).overflowY, overscroll: getComputedStyle(node).overscrollBehaviorY, body: document.body.style.overflow }));
    assert.notEqual(behavior.overscroll, 'contain'); assert.notEqual(behavior.overscroll, 'none'); assert.notEqual(behavior.body, 'hidden');
    await expect(page.getByRole('dialog')).toHaveCount(0); await context.close();
  });

  await scenario('Empty and single-file states retain existing content and naturally scroll the page', async () => {
    const empty = await setup({ count: 0, width: 320, height: 600 });
    await expect(stack(empty.page)).toHaveCount(0);
    await expect(recentSection(empty.page)).toContainText('La bibliothèque attend vos premiers documents');
    await expect(recentSection(empty.page).locator('.document-card')).toHaveCount(0);
    await empty.context.close();
    const { context, page } = await setup({ count: 1, width: 320, height: 600, theme: 'light' });
    await expect(stack(page)).toHaveAttribute('data-count', '1');
    await bringStack(page); await fit(page);
    await expect(stack(page).locator('.document-card')).toHaveCount(1);
    const before = await page.evaluate(() => window.scrollY);
    const room = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight - window.scrollY);
    assert.ok(room > 30, `Single-file chaining needs actual outer-page scroll room; available ${room}px`);
    await touchSwipe(page, 95);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 10);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await context.close();
  });

  for (const theme of ['dark', 'light']) await scenario(`Small Arabic ${theme} cards adapt to long metadata and reduced motion`, async () => {
    const { context, page, fixtures } = await setup({ count: 5, width: 320, height: 760, theme, language: 'ar', long: true, reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await bringStack(page);
    const short = await fit(page);
    await viewport(page).focus(); await page.keyboard.press('ArrowDown'); await settled(page);
    assert.equal(await index(page), 1);
    const tall = await fit(page);
    assert.ok(tall.card.height > short.card.height + 25, 'Long metadata should expand the readable card rather than be hidden or truncated');
    const front = layer(page, 1).locator('.document-card');
    await expect(front.locator('.document-copy h3')).toHaveText(fixtures[1].title);
    await expect(front.locator('.document-filename')).toHaveText(fixtures[1].originalName);
    await expect(front.locator('.document-meta bdi')).toHaveText(fixtures[1].module);
    await viewport(page).focus(); await page.keyboard.press('End'); await settled(page);
    assert.equal(await index(page), 4);
    await page.keyboard.press('Home'); await settled(page); assert.equal(await index(page), 0);
    await viewport(page).focus(); await page.keyboard.press('ArrowDown'); await settled(page);
    await front.locator('.save-btn').click();
    await expect(front.locator('.save-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await bringStack(page); await screenshot(page, `320-${theme}-ar-long`);
    await context.close();
  });

  await scenario('Desktop remains the original three-card grid; resize and other pages remain correct', async () => {
    const { context, page } = await setup({ count: 8, width: 1440, height: 900 });
    await expect(stack(page)).toHaveCount(0);
    await expect(recentSection(page).locator('.document-grid > .document-card')).toHaveCount(3);
    await expect(recentSection(page).locator('.document-card h3')).toHaveText(['Document récent 0001', 'Document récent 0002', 'Document récent 0003']);
    await screenshot(page, 'desktop-original-grid');
    await page.setViewportSize({ width: 760, height: 844 });
    await expect(stack(page)).toHaveAttribute('data-count', '8'); await bringStack(page); await fit(page);
    await page.setViewportSize({ width: 761, height: 844 });
    await expect(stack(page)).toHaveCount(0); await expect(recentSection(page).locator('.document-card')).toHaveCount(3);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(stack(page)).toHaveAttribute('data-count', '8'); await bringStack(page);
    await layer(page, 0).locator('.save-btn').tap();
    await page.locator('.mobile-bottom-nav a[href="/app/library"]').tap();
    await expect(page).toHaveURL(/\/app\/library$/);
    await expect(stack(page)).toHaveCount(0); await expect(page.locator('.library-document-grid')).toBeVisible();
    await page.goto(`${baseURL}/app/saved`);
    await expect(stack(page)).toHaveCount(0); await expect(page.locator('.document-card')).toHaveCount(1);
    await context.close();
  });

  await scenario('Older browser API fallbacks mount, resize, navigate and keep hidden actions out of Tab order', async () => {
    const { context, page } = await setup({ count: 8, width: 390, height: 844, legacyAPIs: true, reducedMotion: 'reduce' });
    const support = await page.evaluate(() => ({ resizeObserver: typeof ResizeObserver, mediaEvents: typeof matchMedia('(max-width: 760px)').addEventListener, inert: 'inert' in HTMLElement.prototype }));
    assert.deepEqual(support, { resizeObserver: 'undefined', mediaEvents: 'undefined', inert: false });
    await expect(stack(page)).toHaveAttribute('data-count', '8'); await bringStack(page); await fit(page);
    await viewport(page).focus(); await page.keyboard.press('ArrowDown'); await settled(page);
    assert.equal(await index(page), 1);
    const hiddenTabStops = await stack(page).locator('.resource-stack-card:not(.is-active)').evaluateAll(nodes => nodes.flatMap(node => [...node.querySelectorAll('button, a, input, select, textarea')].filter(control => control.tabIndex !== -1).map(control => control.outerHTML)));
    assert.deepEqual(hiddenTabStops, [], 'Hidden documents must remain inaccessible through Tab when inert is unavailable');
    await page.setViewportSize({ width: 320, height: 760 }); await settled(page); await fit(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(stack(page)).toHaveCount(0); await expect(recentSection(page).locator('.document-card')).toHaveCount(3);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(stack(page)).toHaveAttribute('data-count', '8'); await bringStack(page);
    await viewport(page).focus(); await page.keyboard.press('End'); await settled(page);
    assert.equal(await index(page), 7); await fit(page);
    await context.close();
  });

  await scenario('Held fractional positions preserve natural card heights, continuous geometry and a bounded pinned target', async () => {
    const { context, page } = await setup({ count: 12, width: 320, height: 1000, long: true });
    await bringStack(page);
    const initial = await stack(page).evaluate(root => {
      const cards = [0, 1].map(index => root.querySelector(`[data-stack-index="${index}"] .document-card`).offsetHeight);
      window.__stackTouchTarget = root.querySelector('[data-stack-index="0"]');
      return { cards, frameHeight: root.querySelector('.resource-stack-scroll').clientHeight };
    });
    assert.ok(initial.cards[1] > initial.cards[0] + 25, 'The incoming document must have meaningfully taller metadata');
    const samples = [];
    await heldTouch(page, async () => {
      for (const fraction of [0.25, 0.5, 0.75, 0.99, 1.01]) {
        await viewport(page).evaluate((node, fraction) => { node.scrollTop = fraction * 160; }, fraction);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const sample = await stack(page).evaluate(root => {
          const viewport = root.querySelector('.resource-stack-scroll'), v = viewport.getBoundingClientRect();
          const cards = [0, 1].map(index => {
            const card = root.querySelector(`[data-stack-index="${index}"] .document-card`), r = card.getBoundingClientRect();
            return { naturalHeight: card.offsetHeight, top: r.top - v.top };
          });
          return { position: viewport.scrollTop, frameHeight: viewport.clientHeight, cards, active: Number(root.dataset.activeIndex) };
        });
        assert.deepEqual(sample.cards.map(card => card.naturalHeight), initial.cards, 'Fractional movement must keep every plane at its own natural height');
        assert.equal(sample.active, 0, 'Crossing a virtual window while held must preserve the accessible selection');
        samples.push(sample);
      }
      assert.ok(samples[0].frameHeight > initial.frameHeight + 15 && samples[2].frameHeight > samples[0].frameHeight + 15, 'The viewport must grow continuously as the taller document enters');
      assert.ok(Math.abs(samples[3].cards[1].top - samples[4].cards[1].top) < 25, 'Crossing an index boundary must not pop the incoming document');
      await viewport(page).evaluate(node => { node.scrollTop = 5.25 * 160; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const pinned = await stack(page).evaluate(root => ({ cards: root.querySelectorAll('.document-card').length, retained: root.querySelector('[data-stack-index="0"]') === window.__stackTouchTarget }));
      assert.ok(pinned.retained, 'Virtualization must retain the exact original DOM touch target');
      assert.ok(pinned.cards <= 6, 'A remote pinned touch target may add only one card to the five-plane window');
    });
    assert.equal(await index(page), 5);
    await expect(layer(page, 0)).toHaveCount(0);
    assert.ok(await stack(page).locator('.document-card').count() <= 5, 'Cancelling touch must release the remote retained plane');
    await fit(page); await expect(page.getByRole('dialog')).toHaveCount(0);
    performance.fractionalGeometry = { shortNaturalHeight: initial.cards[0], tallNaturalHeight: initial.cards[1], samples };
    await context.close();
  });

  await scenario('Identical and prefixed refreshes preserve the active document and held fractional position', async () => {
    const { context, page, fixtures, refreshFixtures } = await setup({ count: 8 });
    await bringStack(page); await goTo(page, 3 * 160);
    const activeId = fixtures[3].id;
    await heldTouch(page, async () => {
      await viewport(page).evaluate(node => { node.scrollTop = 3.35 * 160; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await refreshFixtures(fixtures.map(file => ({ ...file })));
      assert.equal(await index(page), 3);
      assert.equal(await layer(page, 3).getAttribute('data-resource-id'), activeId);
      assert.ok(Math.abs(await viewport(page).evaluate(node => node.scrollTop) - 3.35 * 160) <= 1, 'Identical refresh data must preserve the held fractional position');
      const newest = { ...fixtures[0], id: 'stack-new-prefix', title: 'Nouveau document', date: '2026-10-09T13:00:00Z' };
      await refreshFixtures([newest, ...fixtures]);
      await expect(stack(page)).toHaveAttribute('data-count', '9');
      assert.equal(await index(page), 4);
      assert.equal(await layer(page, 4).getAttribute('data-resource-id'), activeId);
      assert.ok(Math.abs(await viewport(page).evaluate(node => node.scrollTop) - 4.35 * 160) <= 1, 'A prepended document must shift the rail while retaining the same held document and fraction');
    });
    assert.equal(await index(page), 4);
    assert.equal(await layer(page, 4).getAttribute('data-resource-id'), activeId);
    await fit(page); await expect(page.getByRole('dialog')).toHaveCount(0); await context.close();
  });

  await scenario('A thousand resources keep a bounded DOM and respond to throttled native touch', async () => {
    const { context, page } = await setup({ count: 1000 });
    await expect(stack(page)).toHaveAttribute('data-count', '1000'); await bringStack(page);
    const maxCards = async () => stack(page).locator('.document-card').count();
    assert.ok(await maxCards() <= 5, 'Rendering cost must remain bounded independently of total resources');
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const start = Date.now();
    const frameProbe = page.evaluate(() => new Promise(resolve => {
      const times = []; let previous = performance.now();
      const frame = now => { times.push(now - previous); previous = now; if (times.length >= 45) resolve(times); else requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    }));
    await touchSwipe(page, 130); await settled(page);
    assert.ok(await index(page) > 0, 'The throttled gesture must still advance a document');
    const intervals = (await frameProbe).sort((a, b) => a - b);
    performance.throttledGesture = { cpuThrottle: 6, latencyMs: Date.now() - start, frameP50Ms: intervals[Math.floor(intervals.length * 0.5)], frameP95Ms: intervals[Math.floor(intervals.length * 0.95)], mountedCards: await maxCards(), total: 1000, caveat: 'Headless Chromium with CPU throttling is a regression proxy, not a physical-device frame-rate guarantee.' };
    assert.ok(performance.throttledGesture.frameP95Ms <= 50, `CPU6 gesture frame p95 must stay within 50ms: ${JSON.stringify(performance.throttledGesture)}`);
    await viewport(page).focus(); await page.keyboard.press('End'); await settled(page);
    assert.equal(await index(page), 999); assert.ok(await maxCards() <= 5);
    await fit(page); await expect(layer(page, 999).locator('.document-copy h3')).toHaveText('Document récent 1000');
    await page.keyboard.press('Home'); await settled(page); assert.equal(await index(page), 0);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await session.detach();
    await page.waitForTimeout(350);
    const before = await page.evaluate(() => window.__stackRafRequests);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => window.__stackRafRequests);
    assert.equal(after, before, 'An idle stack must not run a perpetual requestAnimationFrame loop');
    performance.throttledGesture.idleRafDelta = after - before;
    await expect(page.getByRole('dialog')).toHaveCount(0); await context.close();
  });

  await scenario('A continuous long pan retains its initial touch target and settles after virtualization', async () => {
    const { context, page } = await setup({ count: 12, width: 320, height: 1000, long: true });
    await viewport(page).focus(); await page.keyboard.press('ArrowDown'); await settled(page);
    assert.equal(await index(page), 1); await bringStack(page); await fit(page);
    const start = await viewport(page).evaluate(node => node.scrollTop);
    const original = layer(page, 1);
    let during;
    const naturalHeight = await original.locator('.document-card').evaluate(node => node.offsetHeight);
    await touchSwipe(page, 350, { duration: 600, beforeEnd: async ({ distance }) => {
      const scrollTop = await viewport(page).evaluate(node => node.scrollTop);
      const mounted = await stack(page).locator('.document-card').count();
      during = { scrollTop, start, mounted, distance, originalPresent: await original.count() };
      assert.ok(scrollTop - start > 35, `A held pan must advance along the logical rail: ${JSON.stringify(during)}`);
      assert.ok(Math.abs((scrollTop - start) / 160 * (naturalHeight + 12) - distance) <= 3, `A tall card advances according to its physical height: ${JSON.stringify(during)}`);
      assert.equal(during.originalPresent, 1, 'The original touch target must remain mounted until native touchend');
      assert.ok(mounted <= 6, 'The normal five-plane window may retain one remote touch target');
    } });
    await settled(page);
    assert.ok(await index(page) >= 2, 'The long pan must reach the next resource');
    assert.ok(await stack(page).locator('.document-card').count() <= 5, 'Touchend must restore the normal previous/current/three-next window');
    await fit(page); await expect(page.getByRole('dialog')).toHaveCount(0);
    performance.longPan = { ...during, settledIndex: await index(page), settledScrollTop: await viewport(page).evaluate(node => node.scrollTop) };
    await context.close();
  });

  await scenario('A new touch interrupts a snap continuously and reversal follows the finger without opening files', async () => {
    const { context, page } = await setup({ count: 8 });
    await bringStack(page); await viewport(page).focus();
    const session = await context.newCDPSession(page);
    const box = await viewport(page).boundingBox();
    const point = { x: box.x + box.width * 0.55, y: box.y + Math.min(140, box.height - 30), radiusX: 3, radiusY: 3, force: 1, id: 1 };
    await viewport(page).evaluate(node => {
      node.addEventListener('touchstart', () => {
        window.__stackInterruptedY = node.querySelector('[data-stack-index="0"] .document-card').getBoundingClientRect().y;
      }, { once: true, capture: true });
    });
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => viewport(page).evaluate(node => node.scrollTop), { intervals: [10] }).toBeGreaterThan(5);
    assert.ok(await viewport(page).evaluate(node => node.scrollTop) < 155, 'The new touch must interrupt a running snap');
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const frozenY = await layer(page, 0).locator('.document-card').evaluate(node => node.getBoundingClientRect().y);
    const caughtY = await page.evaluate(() => window.__stackInterruptedY);
    assert.ok(Math.abs(frozenY - caughtY) <= 1, `Taking over a snap must not jump the card: ${JSON.stringify({ frozenY, caughtY })}`);
    await page.waitForTimeout(100);
    assert.ok(Math.abs((await layer(page, 0).locator('.document-card').boundingBox()).y - frozenY) <= 1, 'Holding a new touch must stop the old animation');
    let fingerY = point.y;
    for (let step = 1; step <= 7; step++) {
      fingerY = point.y - step * 10;
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: fingerY }] });
      await page.waitForTimeout(24);
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const forwardY = (await layer(page, 0).locator('.document-card').boundingBox()).y;
    assert.ok(Math.abs(frozenY - forwardY - 70) <= 3, 'The interrupted card must follow the subsequent upward finger movement');
    for (let step = 1; step <= 6; step++) {
      fingerY = point.y - 70 + step * 10;
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: fingerY }] });
      await page.waitForTimeout(24);
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const reversedY = (await layer(page, 0).locator('.document-card').boundingBox()).y;
    assert.ok(Math.abs(reversedY - forwardY - 60) <= 3, 'A direction reversal must follow the finger without continuing the earlier snap');
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach(); await settled(page);
    assert.equal(await index(page), 0, 'A reverse release should settle back to the original document');
    await expect(page.getByRole('dialog')).toHaveCount(0); await fit(page);
    performance.interruptedSnap = { caughtY, frozenY, forwardTravel: frozenY - forwardY, reverseTravel: reversedY - forwardY, settledIndex: await index(page) };
    await context.close();
  });

  assert.deepEqual(problems, [], 'Resource stack runtime, console and backend isolation');
  await writeFile(join(output, 'resource-stack-report.json'), JSON.stringify({ passed, problems, performance, baseURL }, null, 2));
  console.log(`\n${passed.length} resource stack scenarios passed. Artifacts: ${output}`);
} catch (error) {
  if (activePage && !activePage.isClosed()) await screenshot(activePage, 'failure').catch(() => {});
  await writeFile(join(output, 'resource-stack-report.json'), JSON.stringify({ passed, problems, performance, failure: String(error.stack || error), baseURL }, null, 2));
  throw error;
} finally { await browser.close(); }
