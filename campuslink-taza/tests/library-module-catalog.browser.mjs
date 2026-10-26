import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect as browserExpect } from '@playwright/test';

// The catalog is deliberately independent of document fixtures. Every API
// request is intercepted, so no campus account, metadata, or storage is changed.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = 'test-results/library-module-catalog/chromium';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const expect = browserExpect.configure({ timeout: 15000 });
const report = { passed: [], layouts: [], errors: [] };
const longName = 'Analyse avancée des données et systèmes distribués pour l’intelligence artificielle';
const algebra = 'Algèbre linéaire';
const arabic = 'الاحتمالات والإحصاء';
const rows = (semester, names) => names.map((name, index) => ({
  id: semester * 100 + index + 1, name, filiere_id: 'data_science', semester,
}));

async function fixture({ width = 1440, height = 960, language = 'fr', theme = 'dark', hold = [], failFirst = false, legacy = false, deletable = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900,
    serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(({ theme, language }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { theme, language });
  const user = { id: 3, username: 'module-catalog-fixture', name: 'Catalog fixture', role: 'student',
    account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 5,
    current_academic_year: '2026/2027', language };
  const resources = legacy || deletable ? [{ id: 701, title: 'Legacy document', module: 'Legacy uploaded module',
    filename: 'legacy.pdf', faculty_id: 'fsa', filiere_id: 'data_science', semester: 5,
    category: 'courses', resource_type: 'courses', part_number: '1', teacher_name: 'Fixture teacher',
    academic_year: '2026/2027', academic_years: ['2026/2027'], author: user, author_id: 3,
    created_at: new Date().toISOString(), size: 512, mime: 'application/pdf', library_visible: true }] : [];
  const catalogs = new Map([
    [1, rows(1, ['S1 stale module'])],
    [2, rows(2, ['S2 confirmed module'])],
    [5, rows(5, [longName, algebra, arabic])],
    [6, []],
  ]);
  if (deletable) catalogs.get(5).push({ id: 599, name: 'Legacy uploaded module', filiere_id: 'data_science', semester: 5 });
  const held = new Map(), holds = new Set(hold), requests = [], errors = [], writes = [];
  let bootstrapRequests = 0;
  let failing = failFirst;
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    if (path === '/api/session' && request.method() === 'GET') return route.fulfill({ json: { user } });
    if ((path === '/api/bootstrap' || path === '/api/live') && request.method() === 'GET') {
      bootstrapRequests++;
      return route.fulfill({ json: {
        user, faculty: { id: 'fsa', code: 'FSA', name: 'Faculté des Sciences Appliquées' }, resources,
        messages: [], announcements: [], notifications: [], saved: [], history: [], events: [], members: [], channels: [],
      } });
    }
    if (path === '/api/modules' && request.method() === 'GET') {
      const semester = Number(url.searchParams.get('semester'));
      assert.equal(url.searchParams.get('filiere_id'), 'data_science', 'Catalog requests stay inside the authenticated program');
      assert.ok([1, 2, 3, 4, 5, 6].includes(semester), 'Catalog requests use a real selected semester');
      requests.push({ semester, url: url.pathname + url.search });
      if (failing) {
        return route.fulfill({ status: 503, json: { error: 'Catalogue temporairement indisponible.' } });
      }
      if (holds.has(semester)) {
        const pending = held.get(semester) || [];
        pending.push(route); held.set(semester, pending);
        return;
      }
      return route.fulfill({ json: { modules: catalogs.get(semester) || [] } });
    }
    errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected catalog fixture request' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !(failFirst && message.text().includes('503'))) errors.push(`Console: ${message.text()}`);
  });
  await page.goto(`${origin}/app/library?semester=5`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.library-module-trigger')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const release = async semester => {
    await expect.poll(() => held.get(semester)?.length || 0).toBeGreaterThan(0);
    holds.delete(semester);
    // StrictMode can cancel its first development fetch before mounting the
    // active effect. Release both queued transports; only the live one renders.
    const pending = held.get(semester).splice(0);
    await Promise.all(pending.map(route => route.fulfill({ json: { modules: catalogs.get(semester) || [] } }).catch(error => {
      if (!/Target page, context or browser has been closed|Route is already handled/i.test(error.message)) throw error;
    })));
  };
  return { context, page, width, height, theme, language, errors, writes, requests, holds, held, catalogs, release,
    recover: () => { failing = false; }, bootstrapRequests: () => bootstrapRequests,
    removeLastResource: () => { resources.splice(0); catalogs.set(5, catalogs.get(5).filter(item => item.id !== 599)); } };
}

const picker = page => page.locator('.library-module-picker');
const trigger = page => page.locator('.library-module-trigger');
const moduleSearch = page => page.locator('.library-module-search input');
const choices = page => picker(page).locator('.module-choice');
const state = (page, value) => picker(page).locator(`.library-module-picker-state[data-state="${value}"]`);
const hasName = name => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

async function openKeyboard(page) {
  await trigger(page).focus();
  await page.keyboard.press('Enter');
  await expect(picker(page)).toBeVisible();
  await expect(picker(page)).toHaveAttribute('role', 'dialog');
  await expect(picker(page)).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.library-module-overlay')).toBeVisible();
  await expect(picker(page)).toHaveAccessibleName(/S[1-6]/);
  await expect(moduleSearch(page)).toBeFocused();
}

async function fits(f, label) {
  const geometry = await f.page.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const popup = document.querySelector('.library-module-picker');
    const bottomNav = document.querySelector('.mobile-bottom-nav');
    return { viewport: document.documentElement.clientWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      bottomNav: bottomNav && getComputedStyle(bottomNav).display !== 'none' ? rect(bottomNav) : null,
      popup: popup ? rect(popup) : null,
      rows: [...document.querySelectorAll('.library-module-trigger,.library-module-folder,.library-module-picker .module-choice')].map(node => ({ className: node.className, ...rect(node) })) };
  });
  assert.ok(geometry.scrollWidth <= geometry.viewport + 1, `${label}: no horizontal page overflow`);
  if (geometry.popup) assert.ok(geometry.popup.left >= -1 && geometry.popup.right <= geometry.viewport + 1, `${label}: picker stays within the screen`);
  if (geometry.popup) assert.ok(geometry.popup.top >= -1 && geometry.popup.bottom <= geometry.height + 1, `${label}: the entire modal stays within its viewport`);
  for (const row of geometry.rows) {
    assert.ok(row.left >= -1 && row.right <= geometry.viewport + 1, `${label}: module controls keep their own readable width`);
    assert.ok(row.height >= 39.5, `${label}: module controls remain comfortable touch targets`);
  }
  report.layouts.push({ label, ...geometry });
}

async function selectByArrow(f, name, query) {
  const { page } = f;
  await moduleSearch(page).fill(query);
  await expect(choices(page).filter({ hasText: hasName(name) })).toHaveCount(1);
  await moduleSearch(page).press('ArrowDown');
  let focused = picker(page).locator('.module-choice:focus');
  await expect(focused).toHaveCount(1);
  if (!(await focused.textContent()).match(hasName(name))) await focused.press('ArrowDown');
  focused = picker(page).locator('.module-choice:focus');
  await expect(focused).toContainText(hasName(name));
  await focused.press('Enter');
  await expect(picker(page)).toHaveCount(0);
  await expect(page.locator('.library-results-heading.is-module')).toBeFocused();
  assert.equal(new URL(page.url()).searchParams.get('module'), name.toLocaleLowerCase());
  await expect(page.locator('.document-card')).toHaveCount(0);
  await expect(page.locator('.empty-state')).toBeVisible();
}

async function finish(f) {
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.writes, [], 'Catalog browsing performs no writes');
  report.errors.push(...f.errors);
  await f.context.close();
}

try {
  const loading = await fixture({ hold: [5] });
  try {
    await expect.poll(() => loading.held.get(5)?.length || 0).toBeGreaterThan(0);
    await openKeyboard(loading.page);
    await expect(state(loading.page, 'loading')).toBeVisible();
    await expect(state(loading.page, 'empty')).toHaveCount(0);
    await loading.page.screenshot({ path: `${output}/1440-fr-dark-loading.png`, fullPage: true });
    await loading.release(5);
    await expect(loading.page.locator('.library-module-folder')).toHaveCount(3);
    await expect(state(loading.page, 'loading')).toHaveCount(0);
    await expect(loading.page.locator('.library-module-picker .library-module-share,.library-module-grid .library-module-share')).toHaveCount(0);
    await expect(loading.page.locator('.library-module-count')).toHaveText([/^0 documents? · S5$/, /^0 documents? · S5$/, /^0 documents? · S5$/]);
    await fits(loading, '1440-fr-dark-catalog-without-documents');
    await loading.page.screenshot({ path: `${output}/1440-fr-dark-picker.png`, fullPage: true });
    const sameScopeRequests = loading.requests.length;
    await selectByArrow(loading, algebra, 'algebre');
    await loading.page.screenshot({ path: `${output}/1440-fr-dark-empty-module.png`, fullPage: true });
    assert.equal(loading.requests.length, sameScopeRequests, 'Selecting a module does not refetch the unchanged academic catalog');
    report.passed.push('Catalog-only zero-document modules load independently,show truthful counts,remain selectable,and never expose inert sharing');
    report.passed.push('Loading is distinguished from empty; accent-insensitive keyboard search and arrow selection preserve module context');
  } finally { await finish(loading); }

  const retry = await fixture({ width: 320, height: 700, failFirst: true, legacy: true });
  try {
    await expect(retry.page.locator('.library-module-folder')).toHaveCount(1);
    await openKeyboard(retry.page);
    await expect(state(retry.page, 'error')).toBeVisible();
    await expect(choices(retry.page).filter({ hasText: /Legacy uploaded module/i })).toBeVisible();
    await retry.page.screenshot({ path: `${output}/320-fr-dark-error.png`, fullPage: true });
    const requestsBeforeRetry = retry.requests.length;
    retry.recover();
    await picker(retry.page).locator('.library-module-retry').click();
    await expect(retry.page.locator('.library-module-folder')).toHaveCount(4);
    await expect(state(retry.page, 'error')).toHaveCount(0);
    assert.equal(retry.requests.length, requestsBeforeRetry + 1, 'Retry makes one new catalog request');
    await expect(choices(retry.page).filter({ hasText: hasName(algebra) })).toBeVisible();
    await fits(retry, '320-fr-dark-retry-merged-catalog');
    await retry.page.screenshot({ path: `${output}/320-fr-dark-picker.png`, fullPage: true });
    await retry.page.setViewportSize({ width: 320, height: 480 });
    await expect.poll(() => picker(retry.page).evaluate(node => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
    await fits(retry, '320-fr-dark-short-viewport');
    await retry.page.setViewportSize({ width: 320, height: 700 });
    await moduleSearch(retry.page).fill('missing-catalog-module');
    await expect(picker(retry.page).locator('.library-module-empty')).toBeVisible();
    await expect(choices(retry.page)).toHaveCount(0);
    await retry.page.keyboard.press('Escape');
    await expect(trigger(retry.page)).toBeFocused();
    await expect(picker(retry.page)).toHaveCount(0);
    report.passed.push('Catalog failures offer Retry while preserving uploaded modules; successful retry merges catalog and documents without duplication');
  } finally { await finish(retry); }

  const race = await fixture({ width: 390, height: 844, language: 'ar', theme: 'light', hold: [1, 2] });
  try {
    await expect(race.page.locator('.library-module-folder')).toHaveCount(3);
    await openKeyboard(race.page);
    await fits(race, '390-ar-light-zero-document-catalog');
    await race.page.screenshot({ path: `${output}/390-ar-light-picker.png`, fullPage: true });
    await selectByArrow(race, arabic, 'الاحتمالات');
    await race.page.locator('.library-back-to-modules').click();
    await expect(race.page.locator('.library-module-folder')).toHaveCount(3);
    await race.page.locator('.semester-choice').filter({ hasText: /^S1$/ }).click();
    await expect.poll(() => race.held.get(1)?.length || 0).toBeGreaterThan(0);
    await race.page.locator('.semester-choice').filter({ hasText: /^S2$/ }).click();
    await expect.poll(() => race.held.get(2)?.length || 0).toBeGreaterThan(0);
    await race.release(2);
    await expect(race.page.locator('.library-module-name')).toHaveText(/S2 confirmed module/i);
    await race.release(1);
    await race.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(race.page.locator('.library-module-name')).toHaveText(/S2 confirmed module/i);
    assert.equal(new URL(race.page.url()).searchParams.get('semester'), '2');
    await expect(race.page.getByText('S1 stale module', { exact: true })).toHaveCount(0);
    await race.page.locator('.semester-choice').filter({ hasText: /^S6$/ }).click();
    await expect(race.page.locator('.library-module-folder')).toHaveCount(0);
    await openKeyboard(race.page);
    await expect(state(race.page, 'empty')).toBeVisible();
    await expect(state(race.page, 'loading')).toHaveCount(0);
    await race.page.screenshot({ path: `${output}/390-ar-light-empty-semester.png`, fullPage: true });
    report.passed.push('Semester-scoped requests reject stale out-of-order responses; Arabic keyboard selection and truly empty catalogs stay clear');
  } finally { await finish(race); }

  const light = await fixture({ theme: 'light' });
  try {
    await expect(light.page.locator('.library-module-folder')).toHaveCount(3);
    await light.page.screenshot({ path: `${output}/1440-fr-light-overview.png`, fullPage: true });
    await openKeyboard(light.page);
    await fits(light, '1440-fr-light-zero-document-catalog');
    await choices(light.page).last().focus();
    await light.page.keyboard.press('Tab');
    await expect(picker(light.page)).toBeVisible();
    await expect.poll(() => picker(light.page).evaluate(node => node.contains(document.activeElement))).toBe(true);
    await picker(light.page).locator('button').first().focus();
    await light.page.keyboard.press('Shift+Tab');
    await expect(choices(light.page).last()).toBeFocused();
    await light.page.mouse.click(4, 4);
    await expect(picker(light.page)).toHaveCount(0);
    await expect(trigger(light.page)).toHaveAttribute('aria-expanded', 'false');
    report.passed.push('Desktop light and phone dark/Arabic light catalogs fit their viewport and outside-click dismissal remains available');
  } finally { await finish(light); }

  const modal = await fixture({ height: 700 });
  try {
    await expect(modal.page.locator('.library-module-folder')).toHaveCount(3);
    for (const viewport of [{ width: 1440, height: 700 }, { width: 800, height: 600 }, { width: 1000, height: 700 }]) {
      await modal.page.setViewportSize(viewport);
      await modal.page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const scrollBefore = await modal.page.evaluate(() => scrollY);
      assert.ok(scrollBefore > 0, 'The overlay is tested independently of a scrolled library page');
      await trigger(modal.page).dispatchEvent('click', { detail: 0 });
      await expect(picker(modal.page)).toHaveAttribute('aria-modal', 'true');
      await fits(modal, `${viewport.width}x${viewport.height}-scrolled-page-overlay`);
      const box = await picker(modal.page).boundingBox();
      assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) <= 4, 'The desktop picker stays horizontally centered');
      assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) <= 6, 'The desktop picker stays vertically centered after page scroll and zoom-like resize');
      await modal.page.screenshot({ path: `${output}/${viewport.width}x${viewport.height}-centered-overlay.png` });
      await modal.page.keyboard.press('Escape');
      await expect(picker(modal.page)).toHaveCount(0);
    }
    report.passed.push('Desktop overlay remains fully inside and centered at1440x700,800x600,1000x700 even from a scrolled page');
  } finally { await finish(modal); }

  const deletion = await fixture({ width: 1000, height: 700, deletable: true });
  try {
    const { page } = deletion;
    await expect(page.locator('.library-module-folder')).toHaveCount(4);
    await page.locator('.library-module-folder').filter({ hasText: /Legacy uploaded module/i }).click();
    await expect(page.locator('#resource-701')).toBeVisible();
    const beforeFilter = deletion.requests.length;
    const tabs = page.locator('.library-category-tabs [role="tab"]');
    await tabs.last().click();
    await expect(page.locator('.document-card')).toHaveCount(0);
    await openKeyboard(page);
    await expect(choices(page).filter({ hasText: /Legacy uploaded module/i })).toBeVisible();
    assert.equal(deletion.requests.length, beforeFilter, 'Filtering to zero documents does not delete or refetch catalog entries');
    await page.keyboard.press('Escape');
    await page.locator('.library-clear-filters').click();
    await expect(page.locator('#resource-701')).toBeVisible();
    await page.locator('.library-back-to-modules').click();
    await expect(page.locator('.library-module-folder')).toHaveCount(4);
    const beforeRefresh = deletion.bootstrapRequests(), beforeCatalog = deletion.requests.length;
    deletion.removeLastResource();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(deletion.bootstrapRequests).toBeGreaterThan(beforeRefresh);
    await expect.poll(() => deletion.requests.length).toBeGreaterThan(beforeCatalog);
    await expect(page.locator('.library-module-folder')).toHaveCount(3);
    await expect(page.locator('.library-module-folder').filter({ hasText: /Legacy uploaded module/i })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.library-module-folder')).toHaveCount(3);
    await openKeyboard(page);
    await expect(choices(page).filter({ hasText: /Legacy uploaded module/i })).toHaveCount(0);
    await expect(choices(page).filter({ hasText: hasName(algebra) })).toBeVisible();
    const beforeLiveUpdate = deletion.requests.length;
    // A chat-only file is absent from Library resources, so its removal does
    // not change the bootstrap resource membership. The live event must still
    // refresh the authoritative catalogue while its dialog is open.
    deletion.catalogs.set(5, deletion.catalogs.get(5).filter(item => item.name !== algebra));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('campus-live-update', { detail: {} })));
    await expect.poll(() => deletion.requests.length).toBeGreaterThan(beforeLiveUpdate);
    await expect(choices(page).filter({ hasText: hasName(algebra) })).toHaveCount(0);
    await expect(page.locator('.library-module-folder')).toHaveCount(2);
    await page.reload();
    await expect(page.locator('.library-module-folder')).toHaveCount(2);
    report.passed.push('Last-file and chat-only deletion refresh/remove folders permanently; empty filters and untouched precreated modules remain independent');
  } finally { await finish(deletion); }
  console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors }, null, 2));
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
