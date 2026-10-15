import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Every request is intercepted; these checks never edit real accounts.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const before = process.env.CAMPUS_ADMIN_CAPTURE_BEFORE === '1';
const engine = process.env.CAMPUS_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const browser = await (engine === 'firefox' ? firefox : chromium).launch({ headless: true, ...(engine === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const errors = [], results = [];
const out = `test-results/admin-mobile${engine === 'firefox' ? '/firefox' : ''}`;
await mkdir(out, { recursive: true });
const avatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="180" height="100" fill="#92734f"/><circle cx="90" cy="38" r="20" fill="#f1dfc2"/><ellipse cx="90" cy="99" rx="42" ry="36" fill="#f1dfc2"/></svg>')}`;
const self = { id: 1, name: 'Administration test', username: 'admin.test', role: 'global_admin', faculty_id: 'fsa', filiere_id: 'mathematics', current_semester: 1, language: 'fr', account_status: 'approved', preferences: {} };
const student = { ...self, id: 2, name: 'Ayoub Nir', username: 'ayoub-nir', email: 'ayoub@example.test', role: 'student', avatar, can_reset_password: true };
const longName = { ...student, id: 3, name: 'Nabil Bougribate El Amrani', username: 'nabil-bougribate-identifiant-long', disabled: true, can_reset_password: false, avatar: '' };
const pending = { ...student, id: 4, name: 'Sara Benali', username: 'sara.identifiant.long', email: 'sara.benali.inscription@example.test', account_status: 'pending', registered_at: '2026-10-15T09:00:00Z' };

async function fixture(config) {
  const activeSelf = { ...self, language: config.language };
  const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, hasTouch: config.width < 900, reducedMotion: 'reduce' });
  await context.addInitScript(({ theme, language }) => {
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    window.EventSource = undefined;
  }, config);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    assert.equal(request.method(), 'GET', `Unexpected write in visual fixture: ${path}`);
    if (path === '/api/session') return route.fulfill({ json: { user: activeSelf } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user: activeSelf, faculty: { id: 'fsa', code: 'FSA', name: 'Faculté des Sciences Appliquées' }, resources: [], announcements: [], messages: [], channels: [], members: [activeSelf, student, longName], saved: [], history: [], events: [], notifications: [] } });
    if (path === '/api/admin') return route.fulfill({ json: { users: [student, longName, self], resources: [], announcements: [], channels: [], reports: [], contacts: [] } });
    if (path === '/api/admin/registrations') return route.fulfill({ json: { requests: [pending] } });
    if (path === '/api/admin/appointments') return route.fulfill({ json: { appointments: [] } });
    if (path === '/api/chat/blocks') return route.fulfill({ json: { blocks: [] } });
    errors.push(`Unexpected GET ${path}`);
    return route.fulfill({ status: 404, json: { error: 'Unexpected fixture route' } });
  });
  await page.goto(`${baseURL}/app/admin?tab=accounts`);
  await expect(page.locator('.admin-page')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.admin-accounts-table tbody tr')).toHaveCount(3);
  await expect(page.locator('[data-registration-id="4"]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', config.language);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

async function align(page, selector) {
  await page.locator(selector).first().evaluate(node => {
    const top = document.querySelector('.app-header')?.getBoundingClientRect().bottom || 60;
    window.scrollBy(0, node.getBoundingClientRect().top - top - 12);
  });
}

try {
  const configurations = before ? [{ width: 320, height: 480, theme: 'dark', language: 'fr' }, { width: 390, height: 844, theme: 'dark', language: 'fr' }, { width: 1440, height: 1000, theme: 'dark', language: 'fr' }] : [
    { width: 320, height: 480, theme: 'dark', language: 'fr' },
    { width: 390, height: 844, theme: 'dark', language: 'fr' },
    { width: 480, height: 854, theme: 'light', language: 'fr' },
    { width: 768, height: 1024, theme: 'light', language: 'en' },
    { width: 1024, height: 900, theme: 'dark', language: 'fr' },
    { width: 390, height: 844, theme: 'light', language: 'ar' },
    { width: 1280, height: 900, theme: 'light', language: 'fr' },
    { width: 1440, height: 1000, theme: 'dark', language: 'fr' },
  ];
  for (const config of configurations) {
    const { page, context } = await fixture(config);
    const prefix = `${before ? 'before' : 'after'}-${config.width}-${config.theme}-${config.language}`;
    try {
      await page.screenshot({ path: `${out}/${prefix}-overview.png`, animations: 'disabled' });
      await align(page, '.admin-accounts-table tbody tr');
      await page.screenshot({ path: `${out}/${prefix}-accounts.png`, animations: 'disabled' });
      if (before) continue;
      const row = page.locator('.admin-accounts-table tbody tr').first();
      await expect(page.locator('.admin-accounts-table').getByRole('columnheader')).toHaveCount(5);
      const geometry = await row.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const buttons = [...node.querySelectorAll('.admin-row-actions button')].map(button => {
          const r = button.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, text: button.textContent.trim(), disabled: button.disabled };
        });
        const identity = node.querySelector('.admin-account-person').getBoundingClientRect();
        const avatar = node.querySelector('.avatar').getBoundingClientRect();
        const image = node.querySelector('.avatar img')?.getBoundingClientRect();
        const scroll = node.closest('.admin-table-scroll');
        const labels = [...node.closest('tbody').querySelectorAll('.admin-account-action-label')].map(label => ({ fontSize: parseFloat(getComputedStyle(label).fontSize), fits: label.scrollWidth <= label.clientWidth + 1 }));
        const names = [...node.closest('tbody').querySelectorAll('.admin-account-person > div')].map(person => ({ fontSize: parseFloat(getComputedStyle(person.querySelector('strong')).fontSize), fits: person.scrollWidth <= person.clientWidth + 1 }));
        return { width: rect.width, height: rect.height, buttons, names, labels, identity: { y: identity.y, height: identity.height }, avatar: { y: avatar.y, width: avatar.width, height: avatar.height }, image: image ? { x: image.x, y: image.y, width: image.width, height: image.height } : null, scrollWidth: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, tableWidth: node.closest('table').getBoundingClientRect().width, tableFits: scroll.scrollWidth <= scroll.clientWidth + 1 };
      });
      assert.ok(geometry.scrollWidth <= geometry.viewport + 1, `No page overflow: ${prefix}`);
      assert.ok(geometry.tableFits, 'Account list requires no horizontal scrolling');
      assert.equal(geometry.buttons.length, 6, 'All six permitted account actions remain reachable');
      assert.ok(Math.abs(geometry.avatar.width - geometry.avatar.height) < 1, 'Account avatar stays square');
      assert.ok(Math.abs(geometry.avatar.y + geometry.avatar.height / 2 - geometry.identity.y - geometry.identity.height / 2) < 1, 'Avatar stays vertically centered beside identity');
      await expect(row.locator('.avatar img')).toHaveAttribute('src', avatar);
      assert.ok(geometry.image && Math.abs(geometry.image.width - geometry.avatar.width) <= 2.1 && Math.abs(geometry.image.height - geometry.avatar.height) <= 2.1, 'Photo fills the avatar inside its border without changing its geometry');
      if (config.width <= 900) {
        assert.ok(geometry.names.every(name => name.fontSize >= 13 && name.fits), 'Names and long usernames remain readable and wrap inside their card');
        assert.ok(geometry.labels.every(label => label.fontSize >= 10 && label.fits), 'Visible action labels remain readable without truncation');
        assert.ok(geometry.height <= 360, `Account remains compact: ${prefix}, ${geometry.height}px`);
        assert.ok(geometry.tableWidth <= geometry.viewport, 'Compact accounts fit tablet as well as phones');
        for (const button of geometry.buttons) {
          assert.ok(button.height >= 44 && button.width >= 44, 'Actions retain comfortable touch targets');
          assert.ok(button.text.length > 0, 'Compact actions have visible labels');
          assert.ok(button.x >= 0 && button.x + button.width <= config.width, 'Every action stays onscreen');
        }
        const actionRows = [...new Set(geometry.buttons.map(button => Math.round(button.y)))];
        const perRow = actionRows.map(y => geometry.buttons.filter(button => Math.round(button.y) === y).length);
        assert.deepEqual(perRow, [3, 3], 'Six actions use a balanced grid rather than an orphaned delete button');
      }
      // Every action opens its intended dialog or permissions page. The fixture
      // rejects all writes, so this also guards against destructive one-tap actions.
      for (const name of ['Consulter Ayoub Nir', 'Modifier Ayoub Nir', 'Désactiver Ayoub Nir', 'Réinitialiser le mot de passe de Ayoub Nir', 'Nommer Ayoub Nir administrateur de sa faculté', 'Supprimer Ayoub Nir']) {
        const button = page.getByRole('button', { name, exact: true });
        // Translated layout checks use geometry; French cases also exercise actions.
        if (config.language !== 'fr' || ![320, 1440].includes(config.width)) break;
        await button.click();
        if (name.startsWith('Nommer ')) {
          await expect(page).toHaveURL(/\/app\/permissions\?user=2$/);
          await expect(page.locator('.permissions-page')).toBeVisible();
          await page.goBack();
          await expect(page.locator('.admin-page')).toHaveAttribute('aria-busy', 'false');
          continue;
        }
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
      await align(page, '[data-registration-id="4"]');
      await page.mouse.move(0, 0);
      const admission = page.locator('[data-registration-id="4"]');
      const admissionActions = admission.locator('.admin-admission-actions .btn');
      await expect(admissionActions).toHaveCount(2);
      const admissionGeometry = await admissionActions.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, height: r.height }; }));
      if (config.width <= 900) {
        assert.ok(admissionGeometry.every(r => r.height >= 44 && r.left >= 0 && r.right <= config.width), 'Admission decisions are comfortable and stay onscreen');
        assert.equal(Math.round(admissionGeometry[0].top), Math.round(admissionGeometry[1].top), 'Admission actions share a balanced row');
      }
      await page.screenshot({ path: `${out}/${prefix}-registrations.png`, animations: 'disabled' });
      results.push({ ...config, geometry, admissionGeometry });
      console.log(`PASS ${engine} administration ${config.width}px ${config.theme}/${config.language}: identity, six actions, admissions`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ results, errors }, null, 2));
} finally { await browser.close(); }
