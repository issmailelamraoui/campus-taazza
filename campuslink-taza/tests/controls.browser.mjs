import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseOption, autocompleteValues } from './ui.helpers.mjs';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = join(process.cwd(), 'test-results');
const prefix = 'campuslink-prototype-v1:';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [], problems = [];
let activePage;
await mkdir(output, { recursive: true });

async function setup({ width = 1440, height = 1000, theme = 'dark', language = 'fr', role = 'student', onboarding = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: width <= 760 });
  await context.addInitScript(({ prefix, theme, language, role, onboarding }) => {
    if (localStorage.getItem(prefix + 'controls-ready')) return;
    const set = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
    set('session', { id: role === 'admin' ? 'admin.demo' : 'sara.demo', username: role === 'admin' ? 'admin.demo' : 'sara.demo', name: role === 'admin' ? 'Administration' : 'Sara Benali', role });
    if (!onboarding) set('selections', { [role === 'admin' ? 'admin.demo' : 'sara.demo']: { facultyId: 'flaa', filiereId: 'french_studies', semester: 1 } });
    set('theme', theme); set('language', language); set('controls-ready', true);
  }, { prefix, theme, language, role, onboarding });
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => problems.push(`Runtime: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`Console: ${message.text()}`); });
  page.on('request', request => { if (/\/api\/|neon\.tech|r2\.dev/.test(request.url())) problems.push(`Backend: ${request.url()}`); });
  return { context, page };
}
async function scenario(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }
async function capture(page, name) { await page.screenshot({ path: join(output, `controls-${name}.png`), fullPage: false, animations: 'disabled' }); }
async function noNative(page) { await expect(page.locator('select,datalist')).toHaveCount(0); }
async function popupFits(page, name) {
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  const box = await list.boundingBox(), viewport = page.viewportSize();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${name}: popup outside viewport ${JSON.stringify(box)}`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${name}: horizontal overflow`);
  assert.equal(await list.evaluate(element => element.closest('.modal-body') !== null), false, `${name}: popup must escape the scrolling modal body`);
  const footer = page.locator('.modal-footer');
  if (await footer.isVisible()) {
    const bounds = await footer.boundingBox();
    assert.ok(box.y + box.height <= bounds.y + 1, `${name}: popup covers the modal footer ${JSON.stringify({ box, footer: bounds })}`);
  }
}
async function activeValue(trigger) {
  const id = await trigger.getAttribute('aria-activedescendant');
  return id ? trigger.page().locator(`[id=${JSON.stringify(id)}]`).getAttribute('data-value') : null;
}
async function hasRing(target) {
  return target.evaluate(element => { const style = getComputedStyle(element); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0; });
}

try {
  await scenario('Public language and onboarding semester use themed keyboard-accessible lists', async () => {
    const { context, page } = await setup({ onboarding: true });
    await page.goto(`${baseURL}/onboarding`);
    await noNative(page);
    await chooseOption(page.locator('.public-language-control').getByRole('combobox'), 'en');
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    await chooseOption(page.locator('.public-language-control').getByRole('combobox'), 'fr');
    await page.locator('.onboarding-faculty').filter({ has: page.locator('small', { hasText: /^FLAA$/ }) }).click();
    await page.getByRole('button', { name: 'Continuer', exact: true }).click();
    await page.locator('.onboarding-filieres button').filter({ hasText: 'مسلك الدراسات الفرنسية' }).click();
    const semester = page.getByRole('combobox', { name: 'Votre semestre actuel', exact: true });
    await expect(semester).toHaveAttribute('role', 'combobox');
    await semester.focus(); await semester.press('End');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(6);
    await expect.poll(() => activeValue(semester)).toBe('6');
    await semester.press('Enter'); await expect(semester).toContainText('S6');
    await semester.press('Home'); await semester.press('Enter'); await expect(semester).toContainText('S1');
    await semester.press('ArrowDown'); await semester.press('ArrowDown');
    await expect.poll(() => activeValue(semester)).toBe('2');
    await semester.press('Escape');
    await expect(semester).toBeFocused(); await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(semester).toContainText('S1');
    await semester.click(); await page.locator('.onboarding-heading h1').click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await capture(page, 'onboarding-dark-fr'); await context.close();
  });

  await scenario('Library sort typeahead and author filters preserve their behavior', async () => {
    const { context, page } = await setup();
    await page.goto(`${baseURL}/app/library`); await noNative(page);
    const sort = page.getByRole('combobox', { name: 'Trier', exact: true });
    await sort.focus(); await sort.press('t');
    await expect.poll(() => activeValue(sort)).toBe('title');
    await sort.press('Enter'); await expect(sort).toContainText('Titre A–Z');
    await expect(page.locator('.document-card')).toHaveCount(9);
    await page.getByRole('button', { name: 'Filtres', exact: true }).click();
    await chooseOption(page.locator('#library-filters').getByLabel('Auteur / enseignant'), 'Sara Benali');
    await expect(page.locator('.document-card')).not.toHaveCount(0);
    await expect(page.locator('.document-card')).not.toHaveCount(9);
    await noNative(page); await capture(page, 'library-dark-fr'); await context.close();
  });

  await scenario('Upload suggestions accept free text and portal lists respect the modal keyboard trap', async () => {
    const { context, page } = await setup();
    await page.goto(`${baseURL}/app/library`);
    await page.locator('.page-actions button').click();
    const modal = page.getByRole('dialog');
    await modal.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: 'Classement.txt', mimeType: 'text/plain', buffer: Buffer.from('Actual local text') });
    await modal.getByRole('button', { name: /Classer les documents/ }).click();
    await noNative(page);
    const module = modal.locator('.upload-batch').getByLabel(/^Module/);
    await module.fill('méth');
    await expect.poll(() => autocompleteValues(module)).toEqual(['Méthodologie']);
    await popupFits(page, 'Scoped module suggestions');
    await module.press('ArrowDown'); await module.press('Enter'); await expect(module).toHaveValue('Méthodologie');
    await module.fill('Un module inventé sans catalogue');
    await expect(module).toHaveValue('Un module inventé sans catalogue');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    const semester = modal.locator('.upload-batch').getByLabel(/^Semestre/);
    await semester.click(); await popupFits(page, 'Semester in classification modal');
    await semester.press('Escape'); await expect(modal).toBeVisible(); await expect(semester).toBeFocused();
    await semester.click(); await semester.press('Tab');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), 'Tab must remain inside the modal after a popup');
    const row = modal.locator('.upload-file').first();
    if (!(await row.locator('.upload-file-editor').count())) await row.getByRole('button', { name: /^Modifier / }).click();
    const part = row.locator('.upload-file-editor').getByLabel(/^Part\/Chapitre/);
    await chooseOption(part, 'Complet'); await expect(part).toHaveValue('Complet');
    await part.fill('999999999999999999999999999999'); await expect(part).toHaveValue('999999999999999999999999999999');
    for (let index = 0; index < 20; index++) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), 'Keyboard focus escaped the upload modal');
    }
    await modal.locator('.modal-header button').click();
    await expect(modal).toHaveCount(0); await context.close();
  });

  await scenario('Administration forms and profile settings reuse custom controls without native widgets', async () => {
    const { context, page } = await setup({ role: 'admin' });
    await page.goto(`${baseURL}/app/admin`); await noNative(page);
    await page.getByRole('tab', { name: 'Comptes', exact: true }).click();
    await chooseOption(page.getByRole('combobox', { name: 'Filtrer par établissement', exact: true }), 'feg');
    await page.getByRole('button', { name: 'Ajouter un compte', exact: true }).click();
    const modal = page.getByRole('dialog');
    await chooseOption(modal.getByLabel('Rôle', { exact: true }), 'admin');
    await chooseOption(modal.getByLabel('Statut', { exact: true }), 'disabled');
    await chooseOption(modal.getByLabel('Établissement', { exact: true }), 'feg');
    await modal.getByLabel('Filière', { exact: true }).click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(2);
    await popupFits(page, 'Scoped program in account modal');
    await page.keyboard.press('Escape'); await expect(modal).toBeVisible();
    await noNative(page); await modal.locator('.modal-header button').click();
    await page.goto(`${baseURL}/app/profile`); await noNative(page);
    await chooseOption(page.locator('.settings-card').getByRole('combobox', { name: 'Langue', exact: true }), 'en');
    await expect(page.locator('.settings-card').getByRole('combobox', { name: 'Language', exact: true })).toContainText('English');
    await expect(page.locator('.language-select')).toContainText('EN');
    await context.close();
  });

  await scenario('Pointer clicks and text entry stay clean while keyboard navigation remains visible', async () => {
    const { context, page } = await setup();
    await page.goto(`${baseURL}/app/library`);
    const search = page.getByLabel('Rechercher des documents', { exact: true });
    const wrapper = page.locator('.library-search');
    await search.click(); await search.pressSequentially('Méthodologie');
    assert.equal(await hasRing(search), false, 'Pointer text entry must not draw an input focus ring');
    assert.equal(await hasRing(wrapper), false, 'Pointer text entry must not draw a search-field focus ring');
    const sort = page.getByRole('combobox', { name: 'Trier', exact: true });
    await sort.click(); assert.equal(await hasRing(sort), false, 'Pointer dropdown selection must not draw a focus ring');
    await sort.press('Escape');
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await expect(sort).toBeFocused();
    assert.equal(await hasRing(sort), true, 'Keyboard navigation must keep a visible focus indicator');
    await page.goto(`${baseURL}/app/community?channel=general`);
    const message = page.getByLabel('Votre message', { exact: true });
    await message.click(); await message.pressSequentially('Saisie avec la souris');
    assert.equal(await hasRing(message), false, 'Pointer chat typing must stay clean');
    assert.equal(await hasRing(page.locator('.community-composer-input')), false, 'Pointer composer focus must stay clean');
    await page.goto(`${baseURL}/app/profile`);
    const name = page.getByLabel('Nom affiché', { exact: true });
    await name.click(); assert.equal(await hasRing(name), false, 'Pointer form focus must stay clean');
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await expect(name).toBeFocused();
    assert.equal(await hasRing(name), true, 'Keyboard form navigation must remain visible');
    await context.close();
  });

  await scenario('Small mobile RTL and both themes keep scrolling popup options visible and dismissible', async () => {
    for (const theme of ['dark', 'light']) {
      const { context, page } = await setup({ width: 320, height: 600, language: 'ar', theme });
      await page.goto(`${baseURL}/app/library`); await noNative(page);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const sort = page.locator('.library-sort').getByRole('combobox');
      await sort.click(); await popupFits(page, `Mobile ${theme} RTL sort`);
      await capture(page, `mobile-${theme}-rtl-sort`);
      await page.getByRole('listbox').locator('[role="option"][data-value="part"]').tap();
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await page.locator('.page-actions button').click();
      const modal = page.getByRole('dialog');
      await modal.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: 'ملاحظات.txt', mimeType: 'text/plain', buffer: Buffer.from('محتوى حقيقي') });
      await modal.locator('.modal-footer .btn-primary').click();
      const semester = modal.locator('.upload-batch').getByRole('combobox').first();
      await semester.scrollIntoViewIfNeeded(); await semester.click();
      await popupFits(page, `Mobile ${theme} RTL semester`);
      await semester.press('End'); await semester.press('Enter'); await expect(semester).toContainText('S6');
      await semester.click(); await capture(page, `mobile-${theme}-rtl-classification`);
      await semester.press('Escape'); await expect(modal).toBeVisible();
      await page.setViewportSize({ width: 320, height: 480 });
      await semester.scrollIntoViewIfNeeded(); await semester.tap();
      const scrolling = page.getByRole('listbox');
      await popupFits(page, `Short ${theme} RTL scrolling semester list`);
      assert.ok(await scrolling.evaluate(element => element.scrollHeight > element.clientHeight), 'The short-screen list must scroll rather than cover surrounding controls');
      await semester.press('Home'); await semester.press('End');
      const sixth = scrolling.locator('[role="option"][data-value="6"]');
      const listBox = await scrolling.boundingBox(), sixthBox = await sixth.boundingBox();
      assert.ok(sixthBox.y >= listBox.y && sixthBox.y + sixthBox.height <= listBox.y + listBox.height + 1, 'Keyboard End must scroll the last option into the visible popup');
      await sixth.tap(); await expect(semester).toContainText('S6');
      await page.setViewportSize({ width: 320, height: 600 });
      const row = modal.locator('.upload-file').first();
      await row.locator('button[aria-expanded]').click();
      const part = row.locator('.upload-file-editor input[role="combobox"]').last();
      await part.fill('1');
      await popupFits(page, `Mobile ${theme} RTL chapter near footer`);
      await modal.locator('.modal-footer .btn-primary').click();
      await expect(modal.locator('.upload-error')).toBeVisible();
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await modal.locator('.modal-header button').click();
      await expect(page.getByRole('listbox')).toHaveCount(0); await context.close();
    }
  });

  assert.deepEqual(problems, [], 'No frontend runtime errors or backend requests');
  await writeFile(join(output, 'controls-report.json'), JSON.stringify({ passed, problems, baseURL }, null, 2));
  console.log(`\n${passed.length} custom-control scenarios passed.`);
} catch (error) {
  if (activePage && !activePage.isClosed()) await capture(activePage, 'failure').catch(() => {});
  await writeFile(join(output, 'controls-report.json'), JSON.stringify({ passed, problems, failure: String(error.stack || error), baseURL }, null, 2));
  throw error;
} finally { await browser.close(); }
