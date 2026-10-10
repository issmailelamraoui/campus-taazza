import { chromium, expect } from '@playwright/test';
import { chooseOption } from './ui.helpers.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = join(process.cwd(), 'test-results');
const localPrefix = 'campuslink-prototype-v1:';
const installedChromium = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const chromiumPath = process.env.CAMPUSLINK_CHROMIUM || (existsSync(installedChromium) ? installedChromium : undefined);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const problems = [];
const passed = [];
let currentPage;

const labels = {
  fr: { general: 'Chat général', important: 'Discussions importantes', help: 'Entraide', life: 'Vie étudiante', message: 'Votre message', send: 'Envoyer le message', back: 'Tous les canaux', search: 'Rechercher dans la conversation', semester: value => `Semestre ${value}` },
  en: { general: 'General chat', important: 'Important discussions', help: 'Study support', life: 'Student life', message: 'Your message', send: 'Send message', back: 'All channels', search: 'Search conversation', semester: value => `Semester ${value}` },
  ar: { general: 'الدردشة العامة', important: 'مناقشات مهمة', help: 'المساعدة المتبادلة', life: 'الحياة الطلابية', message: 'رسالتكم', send: 'إرسال الرسالة', back: 'جميع القنوات', search: 'البحث في المحادثة', semester: value => `الفصل ${value}` },
};

function observe(page) {
  currentPage = page;
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => problems.push(`Page error: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`Console error: ${message.text()}`); });
  page.on('request', request => { if (/\/api\//.test(request.url()) || /neon\.tech|r2\.dev/.test(request.url())) problems.push(`Backend request: ${request.url()}`); });
}

async function scenario(name, action) {
  await action();
  passed.push(name);
  console.log(`PASS ${name}`);
}

async function capture(page, name) {
  await page.screenshot({ path: join(output, `community-v2-${name}.png`), fullPage: false, animations: 'disabled' });
}

// This suite targets the community in an already assigned demo account. Login
// and onboarding are exercised separately by browser.mjs; these explicit local
// fixtures add long histories and forbidden-scope sentinels for scroll checks.
async function contextFor({ role = 'student', language = 'fr', theme = 'dark', width = 1440, height = 900, stress = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'fr-FR', reducedMotion: 'reduce' });
  await context.addInitScript(({ prefix, role, language, theme, stress }) => {
    const username = role === 'admin' ? 'admin.demo' : 'sara.demo';
    const set = (name, value) => localStorage.setItem(prefix + name, JSON.stringify(value));
    if (!localStorage.getItem(prefix + 'community-test-ready')) {
      set('session', { id: username, username, name: role === 'admin' ? 'Issmail' : 'Sara Benali', role, bio: '' });
      set('selections', { 'sara.demo': { facultyId: 'flaa', filiereId: 'french_studies', semester: 1 } });
      set('language', language);
      set('theme', theme);
      set('community-test-ready', true);
      if (stress) {
        const scoped = Array.from({ length: 70 }, (_, index) => ({
          id: `scroll-fixture-${index}`, facultyId: 'flaa', filiereId: 'french_studies', channel: 'general',
          author: index % 4 < 2 ? 'Sara Benali' : 'Yassine El Amrani', username: index % 4 < 2 ? 'sara' : 'yassine',
          content: `Message de révision ${index + 1}. Ce contenu de test vérifie que seuls les échanges défilent, tandis que les canaux et la zone de rédaction restent accessibles.`,
          date: `2026-10-${index < 30 ? '06' : '07'}T09:${String(index % 30).padStart(2, '0')}:00Z`, pinned: index === 4 || index === 50,
        }));
        set('messages', [...scoped,
          { ...scoped[0], id: 'other-faculty', facultyId: 'feg', filiereId: 'economics', content: 'AUTRE FACULTÉ — NE DOIT PAS APPARAÎTRE' },
          { ...scoped[0], id: 'other-program', filiereId: 'arabic_studies', content: 'AUTRE FILIÈRE — MÊME CHAT DE FACULTÉ' },
        ]);
      }
    }
  }, { prefix: localPrefix, role, language, theme, stress });
  const page = await context.newPage();
  observe(page);
  return { context, page };
}

async function community(page, query = '') {
  await page.goto(`${baseURL}/app/community${query}`);
  await expect(page.locator('.community-page')).toBeVisible();
}

async function channel(page, id, language = 'fr') {
  const name = ({ 'year-1': 'S1–S2', 'year-3': 'S3–S4', 'year-5': 'S5–S6' })[id] || labels[language][id];
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page).toHaveURL(url => (url.searchParams.get('channel') || 'general') === id);
  await expect(page.locator('.community-chat')).toBeVisible();
}

async function send(page, text, language = 'fr') {
  await page.getByLabel(labels[language].message, { exact: true }).fill(text);
  await page.getByRole('button', { name: labels[language].send, exact: true }).click();
  await expect(page.locator('.community-message-content').filter({ hasText: text })).toBeVisible();
}

async function messageMenu(page, message) {
  await message.focus();
  await message.press('Shift+F10');
  await expect(page.getByRole('menu')).toBeVisible();
}

async function viewportFits(page, name, conversation = true, stress = false) {
  const geometry = await page.evaluate(({ conversation, stress }) => {
    const html = document.documentElement;
    const history = document.querySelector('.community-message-history');
    const composer = document.querySelector('.community-composer');
    const nav = document.querySelector('.community-channel-panel');
    const rect = element => element ? { top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, height: element.getBoundingClientRect().height } : null;
    return { width: html.clientWidth, height: html.clientHeight, scrollWidth: html.scrollWidth, scrollHeight: html.scrollHeight, scrollY: window.scrollY, composer: rect(composer), nav: rect(nav), history: rect(history), historyScrollable: history ? history.scrollHeight > history.clientHeight : false, historyOverflow: history ? getComputedStyle(history).overflowY : null, conversation, stress };
  }, { conversation, stress });
  assert.ok(geometry.scrollWidth <= geometry.width + 1, `${name}: page horizontal overflow ${JSON.stringify(geometry)}`);
  assert.ok(geometry.scrollHeight <= geometry.height + 2, `${name}: outer page scroll ${JSON.stringify(geometry)}`);
  assert.equal(geometry.scrollY, 0, `${name}: outer page moved`);
  if (conversation) {
    assert.ok(geometry.composer && geometry.composer.height > 0, `${name}: composer missing`);
    assert.ok(geometry.composer.bottom <= geometry.height + 1, `${name}: composer below viewport`);
    assert.ok(geometry.composer.top >= 0, `${name}: composer above viewport`);
    assert.ok(geometry.composer.left >= -1 && geometry.composer.right <= geometry.width + 1, `${name}: composer horizontally clipped`);
    assert.ok(geometry.history?.height > 100, `${name}: message history has no usable space`);
    assert.ok(geometry.history.left >= -1 && geometry.history.right <= geometry.width + 1, `${name}: history horizontally clipped`);
    assert.ok(['auto', 'scroll'].includes(geometry.historyOverflow), `${name}: message history must scroll internally`);
    if (stress) assert.ok(geometry.historyScrollable, `${name}: long history should overflow internally`);
  }
}

try {
  const { context, page } = await contextFor();
  await context.tracing.start({ snapshots: true, screenshots: true });
  await scenario('Faculty general and exactly three direct program-year conversations', async () => {
    await community(page);
    await expect(page.locator('.community-context')).toContainText('FLAA');
    await expect(page.locator('.community-context')).toContainText('مسلك الدراسات الفرنسية');
    await expect(page.getByRole('button', { name: 'Entraide', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Vie étudiante', exact: true })).toHaveCount(0);
    await expect(page.locator('.community-channel-panel')).not.toContainText('Discussions par semestre');
    for (const id of ['general', 'important', 'year-1', 'year-3', 'year-5']) {
      await channel(page, id);
      await expect(page.locator('.community-message')).not.toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /^Semestre [1-6]$/ })).toHaveCount(0);
    await community(page, '?channel=filiere');
    await expect(page).toHaveURL(url => url.searchParams.get('channel') === 'year-1');
    await channel(page, 'general');
    await expect(page.locator('.community-date-divider')).not.toHaveCount(0);
    await viewportFits(page, 'Desktop functional community');
    await capture(page, 'desktop-dark-fr');
  });

  await scenario('Send, grouped authors, replies, mentions and accessible student actions', async () => {
    await send(page, 'Message de test pour la nouvelle communauté.');
    await send(page, 'Second message rapproché du même auteur.');
    const last = page.locator('.community-message').last();
    await expect(last).toHaveClass(/is-grouped/);
    await messageMenu(page, last);
    await page.keyboard.press('ArrowDown');
    assert.match(await page.evaluate(() => document.activeElement?.getAttribute('role')), /^menuitem/, 'Message menu should support keyboard navigation');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(last).toBeFocused();
    await messageMenu(page, last);
    await expect(page.getByRole('menuitem', { name: /Épingler|Publier une annonce/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: /^Répondre/ }).click();
    await expect(page.locator('.community-composer-reply')).toBeVisible();
    await send(page, 'Une réponse de test avec une référence discrète.');
    await expect(page.locator('.community-reply-reference')).not.toHaveCount(0);
    await messageMenu(page, page.locator('.community-message').last());
    await page.getByRole('menuitem', { name: /^Mentionner/ }).click();
    await expect(page.getByLabel('Votre message', { exact: true })).toHaveValue(/@sara\.demo/);
    await page.getByLabel('Votre message', { exact: true }).fill('');
    const savedTarget = page.locator('.community-message').last();
    const savedId = await savedTarget.getAttribute('id');
    await messageMenu(page, savedTarget);
    await page.getByRole('menuitem', { name: /Enregistrer/ }).click();
    await expect.poll(() => page.evaluate(prefix => JSON.parse(localStorage.getItem(prefix + 'saved'))['sara.demo'], localPrefix)).toContainEqual(expect.objectContaining({ id: savedId, type: 'discussion' }));
    await messageMenu(page, savedTarget);
    await page.getByRole('menuitem', { name: /Signaler/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await chooseOption(page.getByRole('dialog').getByLabel('Motif'), 'other');
    await page.getByRole('dialog').getByLabel('Précisions').fill('Signalement de test, conservé uniquement dans le navigateur.');
    await page.getByRole('dialog').getByRole('button', { name: /Envoyer le signalement/ }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => page.evaluate(({ prefix, id }) => JSON.parse(localStorage.getItem(prefix + 'reports')).some(item => item.messageId === id), { prefix: localPrefix, id: savedId })).toBeTruthy();
  });

  await scenario('Conversation search, empty results and clearing', async () => {
    const search = page.locator(`input[aria-label="${labels.fr.search}"]`);
    if (!await search.isVisible()) await page.getByRole('button', { name: /Rechercher dans la conversation/ }).click();
    await search.fill('Second message rapproché');
    await expect(page.locator('.community-message-content')).toContainText('Second message rapproché');
    await search.fill('query-no-message-987654');
    await expect(page.locator('.community-chat .empty-state')).toBeVisible();
    await search.fill('');
    await expect(search).toHaveValue('');
    await expect(page.locator('.community-message')).not.toHaveCount(0);
  });

  await scenario('Pinned sidebar, jump highlighting and direct message links', async () => {
    await page.getByRole('button', { name: /Messages épinglés|Épinglés/ }).click();
    const pins = page.locator('.community-pins-modal');
    await expect(pins).toBeVisible();
    await viewportFits(page, 'Desktop pinned sidebar');
    await capture(page, 'desktop-pins-dark-fr');
    const pin = pins.locator('.community-pin-item').first().getByRole('button', { name: 'Voir dans la conversation', exact: true });
    await expect(pin).toBeVisible();
    await pin.click();
    await expect(page.locator('.community-message.is-highlighted')).toHaveCount(1);
    const target = await page.locator('.community-message.is-highlighted').getAttribute('id');
    await capture(page, 'desktop-pinned-jump-dark-fr');
    await community(page, `?channel=general&message=${encodeURIComponent(target)}`);
    await expect(page.locator(`[id="${target}"]`)).toHaveClass(/is-highlighted/);
    await viewportFits(page, 'Direct message link');
  });
  await context.tracing.stop({ path: join(output, 'community-v2-functional-trace.zip') });
  await context.close();

  await scenario('Administrator menu pins and promotes useful discussions locally', async () => {
    const { context: admin, page } = await contextFor({ role: 'admin' });
    await community(page, '?channel=year-3');
    const messageId = await page.locator('.community-message:not(.is-pinned)').last().getAttribute('id');
    const message = page.locator(`[data-message-id="${messageId}"]`);
    await messageMenu(page, message);
    await page.getByRole('menuitem', { name: /^Épingler$/ }).click();
    await expect(message).toHaveClass(/is-pinned/);
    await messageMenu(page, message);
    await page.getByRole('menuitem', { name: /Publier une annonce/ }).click();
    await page.getByRole('dialog').getByLabel('Titre de l’annonce').fill('Une discussion utile, mise en avant dans la démo.');
    await page.getByRole('dialog').getByRole('button', { name: 'Publier dans la démo', exact: true }).click();
    await expect(message.locator('.community-promoted')).toBeVisible();
    const persisted = await page.evaluate(prefix => JSON.parse(localStorage.getItem(prefix + 'announcements')), localPrefix);
    assert.ok(persisted.some(item => item.title === 'Une discussion utile, mise en avant dans la démo.' && item.messageId), 'Promotion should create a related local announcement');
    await capture(page, 'admin-actions-dark-fr');
    await admin.close();
  });

  const viewports = [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 390, height: 600 }, { width: 768, height: 900 }, { width: 1024, height: 900 }, { width: 1440, height: 900 }];
  for (const language of ['fr', 'en', 'ar']) for (const theme of ['dark', 'light']) {
    await scenario(`${language.toUpperCase()} ${theme} viewport and single-scroll geometry`, async () => {
      const { context, page } = await contextFor({ language, theme, stress: true });
      for (const size of viewports) {
        await page.setViewportSize(size);
        await community(page);
        await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('.community-page')).not.toContainText('AUTRE FACULTÉ');
        const mobile = size.width <= 760;
        if (mobile) {
          await expect(page.locator('.community-channel-panel')).toBeVisible();
          await expect(page.locator('.community-chat')).not.toBeVisible();
          await viewportFits(page, `${language} ${theme} ${size.width}×${size.height} channels`, false);
          await capture(page, `channels-${size.width}x${size.height}-${theme}-${language}`);
        }
        await channel(page, 'general', language);
        await expect(page.locator('.community-message').filter({ hasText: 'AUTRE FILIÈRE — MÊME CHAT DE FACULTÉ' })).toHaveCount(1);
        await expect(page.locator('.community-date-divider')).toHaveCount(2);
        if (mobile) {
          await expect(page.locator('.community-channel-panel')).not.toBeVisible();
          await expect(page.getByRole('button', { name: labels[language].back, exact: true })).toBeVisible();
        }
        await viewportFits(page, `${language} ${theme} ${size.width}×${size.height} conversation`, true, true);
        const history = page.locator('.community-message-history');
        await history.evaluate(element => { element.scrollTop = 0; });
        await history.hover();
        await page.mouse.wheel(0, 480);
        await expect.poll(() => history.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        await history.evaluate(element => { element.scrollTop = 0; });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const trigger = page.locator('.community-message').first();
        if (mobile) {
          await trigger.focus();
          await trigger.press('Shift+F10');
          await expect(page.getByRole('menu')).toBeVisible();
          const bounds = await page.getByRole('menuitem').first().boundingBox();
          assert.ok(bounds?.width >= 44 && bounds.height >= 44, `Mobile message actions need a 44px touch target: ${language} ${size.width}`);
          await page.keyboard.press('Escape');
          await expect(page.getByRole('menu')).toHaveCount(0);
        }
        await capture(page, `conversation-${size.width}x${size.height}-${theme}-${language}`);
        if (mobile) {
          await page.getByRole('button', { name: labels[language].back, exact: true }).click();
          await expect(page.locator('.community-channel-panel')).toBeVisible();
          await expect(page.locator('.community-chat')).not.toBeVisible();
          await channel(page, 'year-3', language);
          await expect(page.getByLabel(labels[language].message, { exact: true })).toBeVisible();
        }
      }
      await context.close();
    });
  }

  assert.deepEqual(problems, [], 'Community browser console, runtime and backend isolation');
  await writeFile(join(output, 'community-v2-report.json'), JSON.stringify({ passed, problems, baseURL }, null, 2));
  console.log(`\n${passed.length} community scenarios passed. Artifacts: ${output}`);
} catch (error) {
  if (currentPage && !currentPage.isClosed()) await capture(currentPage, 'failure').catch(() => {});
  await writeFile(join(output, 'community-v2-report.json'), JSON.stringify({ passed, problems, failure: String(error.stack || error), baseURL }, null, 2));
  throw error;
} finally {
  await browser.close();
}
