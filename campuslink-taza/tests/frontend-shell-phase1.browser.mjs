import { chromium, firefox, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Every API response is local, including failed reads. Never use campus accounts.
const browserName = process.env.CAMPUS_TEST_BROWSER || 'chromium';
const browser = await ({ chromium, firefox }[browserName]).launch({ headless: true });
const expect = baseExpect.configure({ timeout: 25000 });
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = `test-results/frontend-shell-phase1/${browserName}`;
await mkdir(output, { recursive: true });
const errors = [], results = [];
const stamp = '2026-10-18T09:00:00Z';

async function fixture(width, language = 'fr', theme = 'dark', empty = false) {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 740 : 900 }, hasTouch: width < 761, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: { get: () => window.__keyboardHeight || innerHeight },
      width: { get: () => innerWidth },
      offsetTop: { get: () => window.__keyboardTop || 0 },
      offsetLeft: { get: () => 0 }, scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  }, { language, theme });
  const user = { id: 201, name: 'Étudiant de vérification avec un nom particulièrement long', username: 'phase1.student', role: 'global_admin', faculty_id: 'fsa', filiere_id: 'information_systems', current_semester: 1, language, account_status: 'approved', preferences: {} };
  const resources = empty ? [] : [1, 2].map(id => ({ id, title: `Titre ${id}`, filename: `original-${id}.txt`, module: 'Ingénierie des systèmes d’information', part_number: String(id), faculty_id: 'fsa', filiere_id: 'information_systems', semester: 1, category: 'courses', mime: 'text/plain', size: 100, created_at: stamp, author: user, library_visible: true }));
  const writes = [];let noticeRead=false;
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push(path);
      if(path==='/api/notifications/read'){noticeRead=true;return route.fulfill({json:{notifications:[{id:301,type:'resources',title:'Notification de contrôle',body:'Une ressource disponible',read:true,path:'/app/library',created_at:stamp}],unread_count:0,discussion_unread_count:0,admin_unread_count:0}});}
      if (path === '/api/history') return route.fulfill({ json: { ok: true } });
      errors.push(`Unexpected write ${path}`);
      return route.fulfill({ status: 503, json: { error: 'Fixture rejects unexpected writes' } });
    }
    let json;
    if (path === '/api/session') json = { user };
    else if (path === '/api/bootstrap') json = { user, faculty: { id: 'fsa', code: 'FSA', name: 'Faculté des Sciences Appliquées' }, resources, messages: [], announcements: [], notifications: [{ id: 301, type: 'resources', title: 'Notification de contrôle', body: 'Une ressource disponible', read: noticeRead, path: '/app/library', created_at: stamp }], unread_count: noticeRead?0:1234, channels: [], members: [], events: [], saved: empty ? [] : [{ type: 'resource', id: 1 }], history: empty ? [] : [{ resource_id: 1 }, { resource_id: 2 }] };
    else if(path==='/api/support/session')return route.fulfill({status:401,json:{error:'Use your private recovery code'}});
    else if (path === '/api/knowledge' || path === '/api/study-tools') json = { items: [] };
    else if (path === '/api/reading') json = { positions: [] };
    else if (/\/members\/\d+\/achievements$/.test(path)) json = { achievements: [] };
    else if (path === '/api/labs') json = { sessions: [], languages: ['javascript', 'json', 'python', 'c', 'cpp'], policy: { version: '1' } };
    else { errors.push(`Unexpected read ${path}`); return route.fulfill({ status: 503, json: { error: 'Fixture endpoint missing' } }); }
    return route.fulfill({ json });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(25000);
  return { context, page, writes };
}

async function fits(page, label) {
  const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(geometry.scroll <= geometry.width + 1, `${label}: ${JSON.stringify(geometry)}`);
}

try {
  for (const width of [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920, 2560]) {
    const language = width === 390 || width === 1024 ? 'ar' : 'fr';
    const { context, page, writes } = await fixture(width, language, width % 3 ? 'dark' : 'light');
    await page.goto(`${baseURL}/app/saved`);
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.locator('.page-loading')).toHaveCount(0);
    const documentTab = page.locator('.saved-tabs [role=tab]').nth(1);
    await expect(documentTab.locator('.tab-count')).toHaveText('1');
    await page.locator('.saved-tabs [role=tab]').last().click();
    await expect(page.locator('.document-card')).toHaveCount(2);
    await expect(documentTab.locator('.tab-count')).toHaveText('1');
    if (width < 761) await page.locator('.mobile-menu-button').click();
    await expect(page.locator('.sidebar')).toBeVisible();
    const gaps = await page.locator('.nav-item').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => {
      const icon = node.querySelector('.nav-icon-wrap').getBoundingClientRect();
      const label = node.querySelector('.nav-icon-wrap + span').getBoundingClientRect();
      return { width: icon.width, gap: Math.min(Math.abs(label.left - icon.right), Math.abs(icon.left - label.right)) };
    }));
    assert.ok(gaps.every(item => item.width <= 19 && item.gap >= 10 && item.gap <= 13), `Sidebar icon alignment at ${width}: ${JSON.stringify(gaps)}`);
    const last = page.locator('.sidebar a[href="/app/admin"]');
    await last.scrollIntoViewIfNeeded();
    assert.ok(await last.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), 'Bottom navigation reachable');
    if (width < 761) {
      await expect(page.locator('.app-main')).toHaveAttribute('inert', '');
      await page.setViewportSize({ width: 1024, height: 900 });
      await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
      await expect(page.locator('.app-main')).not.toHaveAttribute('inert');
      assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
      await page.setViewportSize({ width, height: 740 });
    }
    await page.goto(`${baseURL}/app/notifications`);
    await expect(page.locator('main .notification-mark-all')).toBeEnabled();
    await page.locator('.notification-button').click();
    await expect(page.locator('.notification-popover')).toBeVisible();
    await expect(page.locator('.notification-popover .notification-mark-all')).toBeEnabled();
    assert.deepEqual(writes, [], 'Opening notifications never marks them read');
    await fits(page, `${width} notifications`);
    await page.locator('.notification-popover .notification-mark-all').click();
    await expect(page.locator('.notification-popover .notification-mark-all')).toBeDisabled();
    assert.deepEqual(writes,['/api/notifications/read']);writes.length=0;
    await page.keyboard.press('Escape');
    await page.goto(`${baseURL}/app/profile`);
    const contact = page.locator('.settings-contact .btn');
    await contact.click();
    const modal = page.locator('.modal[role=dialog]');
    await expect(modal).toBeVisible();
    // Model keyboard resize + viewport pan without pretending to operate an OS keyboard.
    await page.evaluate(() => { window.__keyboardHeight = 360; window.__keyboardTop = 45; visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll')); });
    await expect.poll(async () => modal.evaluate(node => Math.round(node.getBoundingClientRect().bottom))).toBeLessThanOrEqual(405);
    assert.ok(await modal.evaluate(node => node.getBoundingClientRect().top >= 45));
    const field = modal.locator('textarea');
    await field.fill('Demande de contrôle isolée');
    await field.scrollIntoViewIfNeeded();
    await expect(field).toBeFocused();
    await fits(page, `${width} modal with keyboard`);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(contact).toBeFocused();
    await page.evaluate(() => { window.__keyboardHeight = 0; window.__keyboardTop = 0; visualViewport.dispatchEvent(new Event('resize')); });
    await page.goto(`${baseURL}/app/study?tab=collection`);
    await expect(page.locator('.study-page')).toBeVisible();
    await page.locator('.study-toolbar .btn-primary').click();
    await expect(page.locator('.study-collection-picker')).toHaveCount(2);
    await fits(page, `${width} study collection editor`);
    await page.keyboard.press('Escape');
    await page.goto(`${baseURL}/app/scanner`);
    await expect(page.locator('.scanner-page')).toBeVisible();
    await fits(page, `${width} scanner`);
    await page.screenshot({ path: `${output}/${width}-${language}-scanner.png` });
    results.push({ width, language, checks: ['saved counts', 'sidebar alignment and reachability', 'drawer resize', 'notifications read state', 'planned bulk action', 'modal keyboard and focus', 'collection editor', 'scanner'] });
    await context.close();
    console.log(`PASS shared UI ${width}px ${language}`);
  }
  const { context, page } = await fixture(320, 'fr', 'dark', true);
  await page.goto(`${baseURL}/app`);
  await expect(page.getByText('Aucune annonce pour le moment', { exact: true })).toBeVisible();
  await expect(page.getByText('La discussion vous attend', { exact: true })).toBeVisible();
  await fits(page, 'empty dashboard');
  await context.close();
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ results, errors, data: 'isolated API fixtures', keyboard: 'simulated visualViewport resize and pan' }, null, 2));
} finally {
  await browser.close();
}
