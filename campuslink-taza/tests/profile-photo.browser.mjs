import { chromium, firefox, expect as playwrightExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// All API calls, including the avatar itself, stay inside this fixture. These
// scenarios never upload a real photo or change a connected user's account.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browserName = process.env.CAMPUS_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox'].includes(browserName), 'Use CAMPUS_TEST_BROWSER=chromium or firefox');
const browser = await ({ chromium, firefox }[browserName]).launch({ headless: true, ...(browserName === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const out = `test-results/profile-photo/${browserName}`;
await mkdir(out, { recursive: true });
const errors = [], passed = [], layouts = [];
const expect = playwrightExpect.configure({ timeout: 30000 });
const portrait = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="#be9971"/><circle cx="90" cy="115" r="48" fill="#f0dec5"/><ellipse cx="90" cy="292" rx="100" ry="119" fill="#625f48"/></svg>';
const landscape = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="180"><rect width="420" height="180" fill="#9aa992"/><circle cx="210" cy="69" r="40" fill="#f0dec5"/><ellipse cx="210" cy="193" rx="85" ry="79" fill="#625f48"/></svg>';
const card = page => page.locator('.profile-card');
const editor = page => page.locator('.profile-photo-editor');
const preview = page => card(page).locator('.avatar').first();
const submit = page => card(page).getByRole('button', { name: 'Enregistrer les modifications', exact: true });
const remove = page => editor(page).getByRole('button', { name: 'Supprimer la photo', exact: true });
const input = page => page.getByLabel('Choisir une photo de profil', { exact: true });

async function fixture({ width = 390, height = 844, theme = 'dark', language = 'fr', image = portrait, empty = false } = {}) {
  const state = {
    user: { id: 2, username: 'sara.benali', name: 'Sara Benali El Amrani', bio: 'Étudiante en sciences, passionnée par les projets collectifs.', role: 'student', faculty_id: 'fsa', filiere_id: 'mathematics', current_semester: 1, account_status: 'approved', language, preferences: {}, avatar: empty ? '' : '/api/avatars/2' },
    patches: [], failedPatches: [], failNext: false,
    imageBody: image, imageType: 'image/svg+xml',
  };
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(({ theme, language }) => {
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    window.EventSource = undefined;
  }, { theme, language });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(45000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('503')) errors.push(`Console: ${message.text()}`); });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session' && method === 'GET') return send({ user: state.user });
    if (path === '/api/bootstrap' && method === 'GET') return send({ user: state.user, faculty: { id: 'fsa', code: 'FSA', name: 'Faculté des Sciences Appliquées', arabic: 'كلية العلوم التطبيقية' }, resources: [], announcements: [], messages: [], channels: [], members: [state.user], saved: [], history: [], events: [], notifications: [], unread_count: 0 });
    if (path === '/api/avatars/2' && method === 'GET') return route.fulfill({ contentType: state.imageType, body: state.imageBody });
    if (path === '/api/members/2/achievements' && method === 'GET') return send({ achievements: [] });
    if (path === '/api/chat/blocks' && method === 'GET') return send({ blocks: [] });
    if (path === '/api/profile' && method === 'PATCH') {
      const patch = request.postDataJSON();
      state.patches.push(patch);
      if (state.failNext) {
        state.failNext = false;
        state.failedPatches.push(patch);
        return send({ error: 'Enregistrement indisponible. Réessayez.' }, 503);
      }
      let avatar = state.user.avatar;
      if (Object.hasOwn(patch, 'avatar')) {
        if (patch.avatar) {
          assert.match(patch.avatar, /^data:image\/png;base64,/);
          state.imageBody = Buffer.from(patch.avatar.split(',')[1], 'base64');
          state.imageType = 'image/png';
          avatar = '/api/avatars/2';
        } else avatar = '';
      }
      state.user = { ...state.user, ...patch, avatar };
      return send({ user: state.user });
    }
    errors.push(`Unexpected API request: ${method} ${path}`);
    return send({ error: 'Unexpected browser fixture request.' }, 500);
  });
  await page.goto(`${baseURL}/app/profile`, { waitUntil: 'domcontentloaded' });
  try { await expect(card(page)).toBeVisible(); } catch (error) { console.error(JSON.stringify({ errors, url: page.url(), text: await page.locator('body').innerText() }, null, 2)); throw error; }
  await page.evaluate(() => document.fonts.ready);
  return { context, page, state };
}

async function geometry(page) {
  if (await preview(page).locator('img').count()) await expect(preview(page).locator('img')).toHaveJSProperty('complete', true);
  return preview(page).evaluate(node => {
    const rect = node.getBoundingClientRect(), styles = getComputedStyle(node), img = node.querySelector('img');
    const image = img ? { width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height, fit: getComputedStyle(img).objectFit, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight } : null;
    const controls = [...document.querySelectorAll('.profile-photo-editor button')].map(button => { const r = button.getBoundingClientRect(); return { text: button.textContent.trim(), left: r.left, right: r.right, height: r.height }; });
    return { width: rect.width, height: rect.height, innerWidth: rect.width - parseFloat(styles.borderLeftWidth) - parseFloat(styles.borderRightWidth), innerHeight: rect.height - parseFloat(styles.borderTopWidth) - parseFloat(styles.borderBottomWidth), radius: styles.borderRadius, overflow: styles.overflow, image, controls, scrollWidth: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth };
  });
}

async function assertCrop(page) {
  const value = await geometry(page);
  assert.ok(Math.abs(value.width - value.height) < 1, 'Photo preview remains square');
  assert.ok(value.width >= 64, 'Photo preview remains legible');
  assert.ok(value.radius.includes('%') ? parseFloat(value.radius) >= 50 : parseFloat(value.radius) >= value.width / 2, 'Photo preview is circular');
  assert.equal(value.overflow, 'hidden', 'Photo is clipped to its circular frame');
  assert.ok(value.image?.naturalWidth && value.image?.naturalHeight, 'Fixture photo decoded successfully');
  assert.ok(Math.abs(value.image.width - value.innerWidth) < 1 && Math.abs(value.image.height - value.innerHeight) < 1, 'Portrait and landscape photos fill the same fixed frame');
  assert.equal(value.image.fit, 'cover', 'Photo crops naturally without stretching');
  assert.ok(value.scrollWidth <= value.viewport + 1, 'Profile page does not overflow horizontally');
  for (const control of value.controls) {
    assert.ok(control.height >= 44, `Comfortable touch target: ${control.text}`);
    assert.ok(control.left >= 0 && control.right <= value.viewport, `Photo control stays onscreen: ${control.text}`);
  }
  return value;
}

async function focusPhoto(page) {
  await editor(page).evaluate(node => {
    const headerBottom = document.querySelector('.app-header')?.getBoundingClientRect().bottom || 60;
    window.scrollBy(0, node.getBoundingClientRect().top - headerBottom - 16);
  });
}

async function uploadPng(page, { width = 420, height = 180 } = {}) {
  const png = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const brush = canvas.getContext('2d'); brush.fillStyle = '#b18b61'; brush.fillRect(0, 0, width, height);
    brush.fillStyle = '#f0dec5'; brush.beginPath(); brush.arc(width / 2, height * .36, height * .22, 0, Math.PI * 2); brush.fill();
    brush.fillStyle = '#625f48'; brush.beginPath(); brush.ellipse(width / 2, height, height * .52, height * .5, 0, 0, Math.PI * 2); brush.fill();
    return canvas.toDataURL('image/png');
  }, { width, height });
  await input(page).setInputFiles({ name: 'profile-landscape.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') });
  await expect(preview(page).locator('img')).toHaveAttribute('src', png);
  return png;
}

async function scenario(name, run) {
  await run(); passed.push(name); console.log(`PASS ${name}`);
}

try {
  await scenario('Phone and desktop layouts keep portrait/landscape photos circular and controls reachable in dark, light and Arabic', async () => {
    for (const config of [
      { width: 320, height: 480, theme: 'dark', language: 'fr' },
      { width: 390, height: 844, theme: 'light', language: 'fr' },
      { width: 390, height: 844, theme: 'light', language: 'ar' },
      { width: 1440, height: 1000, theme: 'dark', language: 'fr' },
    ]) {
      for (const [shape, image] of [['portrait', portrait], ['landscape', landscape]]) {
        const { context, page, state } = await fixture({ ...config, image });
        try {
          await expect(editor(page).getByRole('button')).toHaveCount(2);
          const measures = await assertCrop(page);
          assert.equal(state.patches.length, 0, 'Viewing photo controls makes no profile writes');
          layouts.push({ ...config, shape, measures });
          await focusPhoto(page);
          await page.screenshot({ path: `${out}/${config.width}-${config.theme}-${config.language}-${shape}.png`, animations: 'disabled' });
        } finally { await context.close(); }
      }
    }
  });

  await scenario('Existing photo removal is staged, undoable, saved explicitly and persistent after reload', async () => {
    const { context, page, state } = await fixture({ width: 320, height: 480 });
    try {
      await remove(page).click();
      await expect(preview(page).locator('img')).toHaveCount(0);
      await expect(editor(page)).toContainText(/Enregistrez/);
      assert.equal(state.patches.length, 0, 'Removal remains local before Save');
      const undo = editor(page).getByRole('button', { name: 'Annuler', exact: true });
      assert.ok((await undo.boundingBox()).height >= 44, 'Undo remains comfortable to tap');
      await focusPhoto(page);
      await page.screenshot({ path: `${out}/320-dark-fr-pending-removal.png`, animations: 'disabled' });
      await editor(page).getByRole('button', { name: 'Annuler', exact: true }).click();
      await expect(preview(page).locator('img')).toHaveAttribute('src', '/api/avatars/2');
      await remove(page).click();
      await submit(page).click();
      await expect(submit(page)).toBeEnabled();
      assert.equal(state.patches.length, 1);
      assert.equal(state.patches[0].avatar, '', 'Server receives explicit empty avatar to delete the photo');
      await page.reload();
      await expect(card(page)).toBeVisible();
      await expect(preview(page).locator('img')).toHaveCount(0);
      await expect(preview(page)).toHaveText('SB');
      await expect(remove(page)).toHaveCount(0);
      await expect(editor(page)).not.toContainText(/Enregistrez/);
      await focusPhoto(page);
      await page.screenshot({ path: `${out}/320-dark-fr-removed.png`, animations: 'disabled' });
    } finally { await context.close(); }
  });

  await scenario('Upload is staged once and later name or bio edits do not upload the same photo again', async () => {
    const { context, page, state } = await fixture();
    try {
      const png = await uploadPng(page);
      await assertCrop(page);
      await expect(editor(page)).toContainText(/Enregistrez/);
      assert.equal(state.patches.length, 0, 'Selecting a file does not immediately upload it');
      await submit(page).click();
      await expect(submit(page)).toBeEnabled();
      assert.equal(state.patches.length, 1);
      assert.equal(state.patches[0].avatar, png);
      await expect(preview(page).locator('img')).toHaveAttribute('src', /^\/api\/avatars\/2\?v=.+/);
      await expect(page.locator('.header-avatar img')).toHaveAttribute('src', /^\/api\/avatars\/2\?v=.+/);
      await expect(editor(page)).not.toContainText(/Enregistrez/);
      await card(page).getByLabel('Nom affiché', { exact: true }).fill('Sara Benali');
      await card(page).getByLabel('À propos', { exact: true }).fill('Un nouveau texte sans nouvelle image.');
      await submit(page).click();
      await expect(submit(page)).toBeEnabled();
      assert.equal(state.patches.length, 2);
      assert.equal(Object.hasOwn(state.patches[1], 'avatar'), false, 'Canonical server URL resets the avatar draft after upload');
      assert.equal(state.patches[1].name, 'Sara Benali');
      assert.equal(state.patches[1].bio, 'Un nouveau texte sans nouvelle image.');
    } finally { await context.close(); }
  });

  await scenario('A failed removal save preserves the pending change for an explicit retry', async () => {
    const { context, page, state } = await fixture();
    try {
      await remove(page).click(); state.failNext = true;
      await submit(page).click();
      await expect(submit(page)).toBeEnabled();
      await expect(card(page)).toContainText('Enregistrement indisponible. Réessayez.');
      await expect(preview(page).locator('img')).toHaveCount(0);
      await expect(editor(page)).toContainText(/Enregistrez/);
      assert.equal(state.user.avatar, '/api/avatars/2', 'Failed save leaves server photo intact');
      await submit(page).click();
      await expect(submit(page)).toBeEnabled();
      assert.equal(state.failedPatches.length, 1);
      assert.equal(state.patches.length, 2);
      assert.equal(state.patches[0].avatar, '');
      assert.equal(state.patches[1].avatar, '');
      assert.equal(state.user.avatar, '');
      await expect(editor(page)).not.toContainText(/Enregistrez/);
    } finally { await context.close(); }
  });

  await scenario('Removing an unsaved first photo restores initials without leaving an unnecessary avatar mutation', async () => {
    const { context, page, state } = await fixture({ empty: true });
    try {
      await expect(remove(page)).toHaveCount(0);
      await uploadPng(page, { width: 180, height: 320 });
      await remove(page).click();
      await expect(preview(page).locator('img')).toHaveCount(0);
      await expect(preview(page)).toHaveText('SB');
      await expect(remove(page)).toHaveCount(0);
      await expect(editor(page)).not.toContainText(/Enregistrez/);
      assert.equal(state.patches.length, 0);
      await card(page).getByLabel('À propos', { exact: true }).fill('Texte enregistré après abandon de la photo.');
      await submit(page).click();
      await expect(submit(page)).toBeEnabled();
      assert.equal(state.patches.length, 1);
      assert.equal(Object.hasOwn(state.patches[0], 'avatar'), false, 'Discarding a new image restores the original empty photo state');
    } finally { await context.close(); }
  });

  assert.deepEqual(errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ passed, layouts, errors }, null, 2));
  console.log(`${passed.length} profile photo browser scenarios passed; ${layouts.length} responsive image layouts checked.`);
} finally { await browser.close(); }
