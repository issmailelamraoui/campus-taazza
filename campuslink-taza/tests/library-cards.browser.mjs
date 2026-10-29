import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Synthetic fixtures only: every API request is intercepted; no database or R2.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = 'C:/Users/iisma/Documents/Codex/2026-10-28/files-pasted-by-the-user-campuslink/outputs';
const browser = await chromium.launch({ headless: true });
const report = { passed: [], layouts: [], hover: [], errors: [], writes: [] };
const filename = 'TP 2 Les structures conditionnelles en langage C.pdf';
const owner = { id: 2, name: 'Étudiant de démonstration', username: 'demo.etudiant', role: 'student',
  account_status: 'approved', faculty_id: 'fsa', filiere_id: 'mathematics', current_semester: 3,
  current_academic_year: '2026/2027' };
const libraryUrl = `${origin}/app/library?semester=3&module=id%3A57&category=tp&contributor=2`;
await mkdir(output, { recursive: true });

async function fixture(width, language, theme, peer = false) {
  const user = { ...owner, language, ...(peer ? { id: 3, name: 'Autre étudiant', username: 'demo.peer' } : {}) };
  const resource = { id: 101, title: 'TP 2 Les structures conditionnelles en langage C', filename,
    relative_path: filename, category: 'tp', resource_type: 'tp', module_id: 57, module: 'Informatique C',
    faculty_id: 'fsa', filiere_id: 'mathematics', semester: 3, author: owner, library_visible: true,
    academic_year: '2026/2027', academic_years: ['2026/2027'], created_at: '2026-10-27T12:00:00Z',
    part_number: '2', size: 1024, mime: 'application/pdf', can_manage_academic_years: !peer };
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 900 : 1080 }, serviceWorkers: 'block', reducedMotion: 'reduce', hasTouch: width < 900 });
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { language, theme });
  await context.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') report.writes.push(`${request.method()} ${path}`);
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (['/api/bootstrap', '/api/live'].includes(path)) return route.fulfill({ json: { user,
      faculty: { id: 'fsa', code: 'FSA', name: 'Fixture faculty' }, resources: [resource], messages: [], announcements: [],
      notifications: [], events: [], saved: [], history: [], members: [], channels: [] } });
    if (path === '/api/modules') return route.fulfill({ json: { modules: [{ id: 57, name: 'Informatique C', faculty_id: 'fsa', filiere_id: 'mathematics', semester: 3 }] } });
    if (['/api/reading', '/api/knowledge'].includes(path)) return route.fulfill({ json: { positions: [], items: [] } });
    report.errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request.' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(libraryUrl);
  await expect(page.locator('#resource-101')).toBeVisible();
  return { page, context, width, language, theme };
}

async function fits(f, label, selectors = '.document-card,.document-footer,.document-secondary-actions,.document-actions-popover') {
  const layout = await f.page.evaluate(selectors => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
    nodes: [...document.querySelectorAll(selectors)].filter(node => node.getClientRects().length).map(node => {
      const box = node.getBoundingClientRect(); return { class: node.className, width: box.width, left: box.left, right: box.right, top: box.top, bottom: box.bottom, client: node.clientWidth, scroll: node.scrollWidth };
    }) }), selectors);
  assert.ok(layout.scroll <= layout.width + 1, `${label}: no page overflow ${JSON.stringify(layout)}`);
  for (const item of layout.nodes) assert.ok(item.left >= -1 && item.right <= layout.width + 1 && item.scroll <= item.client + 2, `${label}: unclipped ${JSON.stringify(item)}`);
  report.layouts.push({ label, ...layout });
}

async function noHover(page, locator, label) {
  const styles = node => { const css=getComputedStyle(node); return Object.fromEntries(['backgroundColor','color','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','transform','boxShadow','opacity'].map(key=>[key,css[key]])); };
  await page.mouse.move(0,0);
  const before=await locator.evaluate(styles);
  await locator.hover();
  await locator.evaluate(async node=>{getComputedStyle(node).backgroundColor;await Promise.allSettled(node.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished));});
  const after=await locator.evaluate(styles);
  assert.deepEqual(after,before,`${label}: hover must not change its appearance`);
  report.hover.push(label);
}

try {
  for (const [width, language, theme] of [[1440, 'fr', 'dark'], [1440, 'fr', 'light'], [320, 'fr', 'dark'], [320, 'fr', 'light'], [360, 'fr', 'dark'], [375, 'en', 'light'], [390, 'ar', 'light'], [412, 'ar', 'dark'], [768, 'en', 'dark']]) {
    const f = await fixture(width, language, theme), { page } = f;
    const label = `${width}-${language}-${theme}`;
    try {
      const card = page.locator('#resource-101'), trigger = card.locator('.document-actions-trigger');
      await expect(card.locator('h3')).toHaveText('INFORMATIQUE C');
      await expect(card.locator('h3')).not.toContainText('.pdf');
      await expect(page.locator('.library-edit-year')).toHaveCount(0);
      const size = await card.boundingBox();
      assert.ok(size.width <= 360.1, `${label}: single file is capped at360px`);
      const colors = await card.locator('.part-label').evaluate(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
      assert.notEqual(colors.background, 'rgb(101, 57, 24)', 'Chapter badge no longer uses hardcoded orange.');
      await fits(f, label + '-file');
      await noHover(page,card,label+'-card');
      await noHover(page,card.locator('.document-download'),label+'-download');
      await noHover(page,card.locator('.save-btn'),label+'-save');
      await noHover(page,trigger,label+'-more');
      await noHover(page,page.locator('.page-actions .btn'),label+'-primary');
      await noHover(page,page.locator('.semester-choice.selected'),label+'-semester');
      await noHover(page,page.locator('.library-module-trigger'),label+'-module-trigger');
      await trigger.focus(); await page.keyboard.press('Enter');
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.document-action-item')).toHaveCount(2);
      await fits(f, label + '-menu');
      await noHover(page,page.locator('.document-action-item').first(),label+'-menu-item');
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toBeFocused();
      await trigger.click(); await page.locator('h1').click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await trigger.click(); await page.locator('.page-actions .btn').focus();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await trigger.click(); await page.locator('.document-action-item').last().click();
      await expect(page.locator('.modal[role="dialog"]')).toBeVisible();
      await page.locator('.modal-header .close-control').click();
      await expect(page.locator('.modal')).toHaveCount(0);
      if (width === 1440 && theme === 'dark') await page.screenshot({ path: output + '/library-module-title-desktop.png', fullPage: true });
      if (width === 390 && language === 'ar') {
        await trigger.click(); await page.screenshot({ path: output + '/library-module-title-mobile.png', fullPage: true });
        await page.keyboard.press('Escape');
      }
      await page.goto(`${origin}/app/library?semester=3&module=id%3A57&category=tp`);
      await expect(page.locator('.library-contributor-folder')).toHaveCount(1);
      const folder = await page.locator('.library-contributor-folder').boundingBox();
      assert.ok(folder.width <= 360.1, `${label}: single contributor stays bounded`);
      await fits(f, label + '-folder', '.library-contributor-folder');
      await noHover(page,page.locator('.library-contributor-folder'),label+'-student-folder');
      await page.goto(`${origin}/app/library?semester=3&module=id%3A57`);
      await noHover(page,page.locator('.library-category-folder[data-category="tp"]'),label+'-category-folder');
      await page.goto(`${origin}/app/library?semester=3`);
      await expect(page.locator('.library-module-folder')).toHaveCount(1);
      const module = await page.locator('.library-module-folder').boundingBox();
      assert.ok(module.width <= 360.1, `${label}: single module stays bounded`);
      await fits(f, label + '-module', '.library-module-folder');
      await noHover(page,page.locator('.library-module-folder'),label+'-module-folder');
      report.passed.push(label + ': module title, responsive bounded cards, no hover, keyboard/click/Escape/outside/blur menu, year dialog without save');
    } finally { await f.context.close(); }
  }
  const peer = await fixture(390, 'fr', 'dark', true);
  try {
    await peer.page.locator('.document-actions-trigger').click();
    await expect(peer.page.locator('.document-action-item')).toHaveCount(1);
    await expect(peer.page.getByRole('button', { name: 'Modifier l’année universitaire', exact: true })).toHaveCount(0);
    report.passed.push('Peer sees study tools only; no academic-year management action.');
  } finally { await peer.context.close(); }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.writes, []);
  await writeFile(output + '/library-module-title-tests.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, layouts: report.layouts.length, hoverChecks: report.hover.length, errors: report.errors, writes: report.writes }, null, 2));
} finally { await browser.close(); }
