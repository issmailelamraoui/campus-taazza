import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { chooseOption } from './ui.helpers.mjs';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
mkdirSync('test-results', { recursive: true });
const faculties = [{ id: 'flaa', name: 'Faculté des Lettres, des Arts et des Sciences Humaines', filieres: [{ id: 'french_studies', name: 'Études françaises' }] }];
const cases = [
  { width: 320, height: 600, theme: 'dark', language: 'fr' },
  { width: 390, height: 844, theme: 'light', language: 'fr', submit: true },
  { width: 390, height: 844, theme: 'dark', language: 'ar' },
  { width: 844, height: 390, theme: 'light', language: 'en' },
  { width: 1280, height: 900, theme: 'dark', language: 'fr' },
];

async function setup(config, failOptions = false) {
  const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, hasTouch: config.width < 1000, isMobile: config.width < 1000 });
  const errors = [], registrations = [];
  let pending, fail = failOptions;
  await context.addInitScript(({ theme, language }) => {
    window.EventSource = undefined;
    // These regressions exercise returning visitors; installation has its own suite.
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
  }, config);
  // All registration requests stay in this fixture; no real account is created.
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user: null } });
    if (path === '/api/registration-options') {
      await new Promise(resolve => setTimeout(resolve, 80));
      return route.fulfill(fail ? { status: 503, json: { error: 'Facultés temporairement indisponibles.' } } : { json: { faculties } }).catch(() => {});
    }
    if (path === '/api/register' && request.method() === 'POST') {
      const body = request.postDataJSON(); registrations.push(body);
      pending = () => route.fulfill({ status: 201, json: { authenticated: false, user: { id: 9999, name: body.name, username: body.username, email: body.email, role: 'student', account_status: 'pending', faculty_id: body.faculty_id, filiere_id: body.filiere_id, current_semester: body.current_semester } } });
      return;
    }
    errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseURL}/register`);
  await expect(page.locator('#register-name')).toBeVisible();
  return { context, page, errors, registrations, resolve: () => pending(), hasPending: () => Boolean(pending), retry: () => { fail = false; } };
}

try {
  for (const config of cases) {
    const fixture = await setup(config), { page } = fixture;
    try {
      await expect(page.locator('#register-faculty')).toBeEnabled();
      await page.waitForTimeout(150);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-theme', config.theme);
      const compact = config.width < 1000;
      if (compact) await expect(page.locator('.register-page .login-story')).toBeHidden();
      else await expect(page.locator('.register-page .login-story')).toBeVisible();
      const geometry = await page.locator('.register-page .login-form .input').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { x: rect.x, right: rect.right, height: rect.height, fontSize: parseFloat(style.fontSize) };
      }));
      assert.equal(geometry.length, 7);
      for (const control of geometry) {
        assert.ok(control.x >= 0 && control.right <= config.width + 1, 'Every field must fit the screen.');
        assert.equal(control.height, 49);
        if (compact) assert.ok(control.fontSize >= 16, 'Focused phone fields should not trigger automatic zoom.');
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#register-name').fill('Fixture Student');
      await page.locator('#register-username').fill('mobile_fixture');
      await page.locator('#register-email').fill('mobile@example.test');
      await page.locator('#register-password').fill('FixturePassword10!');
      await page.locator('.password-field button').click();
      await expect(page.locator('#register-password')).toHaveAttribute('type', 'text');
      const password = await page.locator('#register-password').boundingBox(), eye = await page.locator('.password-field button').boundingBox();
      assert.ok(eye.x >= password.x && eye.x + eye.width <= password.x + password.width);
      assert.ok(eye.y >= password.y && eye.y + eye.height <= password.y + password.height);
      assert.ok(await page.locator('#register-password').evaluate(node => parseFloat(getComputedStyle(node).paddingInlineEnd) >= 49));
      await page.locator('.password-field button').click();
      await chooseOption(page.locator('#register-faculty'), 'flaa');
      await chooseOption(page.locator('#register-filiere'), 'french_studies');
      await chooseOption(page.locator('#register-semester'), '3');
      const submit = page.locator('.register-page button[type="submit"]');
      await expect(submit).toBeEnabled();
      await submit.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/register-after-${config.width}-${config.theme}-${config.language}.png`, fullPage: true });
      if (config.submit) {
        await submit.tap();
        await expect.poll(fixture.hasPending).toBe(true);
        await expect(page.locator('.login-form')).toHaveAttribute('aria-busy', 'true');
        await expect(submit).toBeDisabled();
        await expect(submit).toContainText('Envoi de la demande');
        assert.equal(fixture.registrations.length, 1);
        assert.deepEqual(fixture.registrations[0], { name: 'Fixture Student', username: 'mobile_fixture', email: 'mobile@example.test', password: 'FixturePassword10!', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 3 });
        await fixture.resolve();
        await expect(page).toHaveURL(url => url.pathname === '/account-review');
        await expect(page.locator('.onboarding-heading h1')).toContainText('en attente');
      }
      assert.deepEqual(fixture.errors, []);
      console.log(`PASS registration ${config.width}x${config.height} ${config.theme}/${config.language}: usable controls, scrolling, selections${config.submit ? ', submission progress and pending review' : ''}`);
    } finally { await fixture.context.close(); }
  }
  const retry = await setup({ width: 390, height: 844, theme: 'light', language: 'fr' }, true);
  try {
    await expect(retry.page.getByRole('alert')).toContainText('Facultés temporairement indisponibles.');
    await retry.page.locator('#register-name').fill('Fixture Retry');
    retry.retry();
    await retry.page.getByRole('button', { name: 'Réessayer', exact: true }).click();
    await expect(retry.page.locator('#register-faculty')).toBeEnabled();
    await expect(retry.page.getByRole('alert')).toHaveCount(0);
    await expect(retry.page.locator('#register-name')).toHaveValue('Fixture Retry');
    assert.deepEqual(retry.errors, []);
    console.log('PASS real options failure remains visible; retry restores choices and preserves entered data');
  } finally { await retry.context.close(); }
} finally { await browser.close(); }
