import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { browserOptions } from './browser-utils.mjs';

const baseURL = process.env.CAMPUS_BROWSER_ORIGIN || process.env.CAMPUS_BROWSER_URL || 'http://localhost:5173';
const browser = await chromium.launch(browserOptions());
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const runtimeErrors = [];
const requests = [];
let initialLanguage = 'fr';
page.on('pageerror', error => runtimeErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) runtimeErrors.push(message.text()); });
page.on('request', request => { if (request.method() !== 'GET') requests.push({ method: request.method(), url: request.url() }); });

async function clickTab(name) {
  console.log(`Admin screen: ${name}`);
  await page.locator('.admin-tabbar').getByRole('tab', { name, exact: true }).click();
}
async function noOverflow(route, width, language, target = page) {
  console.log(`Layout check: ${route}, ${width}px, ${language}`);
  await target.setViewportSize({ width, height: 900 });
  await target.goto(`${baseURL}${route}`);
  await target.locator('.language-selector').getByRole('button', { name: language, exact: true }).click();
  await target.waitForFunction(({ language }) => document.documentElement.lang === language.toLowerCase(), { language });
  await target.waitForTimeout(250);
  const dimensions = await target.evaluate(() => ({ screen: innerWidth, content: document.documentElement.scrollWidth, dir: document.documentElement.dir }));
  assert.ok(dimensions.content <= dimensions.screen + 1, `${route} ${language} overflows at ${width}px: ${JSON.stringify(dimensions)}`);
  if (language === 'AR') assert.equal(dimensions.dir, 'rtl');
  return dimensions;
}

try {
  await page.goto(`${baseURL}/login`);
  await page.getByLabel(/Nom d.utilisateur/).fill('admin');
  await page.getByLabel('Mot de passe', { exact: true }).fill(process.env.CAMPUS_ADMIN_PASSWORD || 'Admin2026!');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.waitForURL('**/app');
  initialLanguage = (await (await context.request.get(`${baseURL}/api/session`)).json()).user.language || 'fr';
  await page.locator('.language-selector').getByRole('button', { name: 'FR', exact: true }).click();
  await page.goto(`${baseURL}/app/admin`);
  await page.getByRole('heading', { name: 'Espace administration' }).waitFor();
  await page.locator('.admin-loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.admin-error').count(), 0);

  // Reports and each filter remain usable with either seeded reports or an empty inbox.
  for (const label of ['En attente', 'Examinés', 'Résolu', 'Tout']) {
    await page.locator('.admin-filter-pills').getByRole('button', { name: label, exact: true }).click();
    assert.ok(await page.locator('.admin-filter-pills button.active').textContent());
  }

  await clickTab('Utilisateurs');
  const originalUserCount = await page.locator('.admin-user-row').count();
  assert.ok(originalUserCount > 0, 'Administrator can see the user list');
  await page.getByPlaceholder('Rechercher un utilisateur…').fill('sara');
  assert.ok(await page.locator('.admin-user-row').count() < originalUserCount, 'User search filters the list');
  await page.getByPlaceholder('Rechercher un utilisateur…').fill('');
  await page.locator('.admin-user-row').first().getByRole('button', { name: /Gérer/ }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('dialog').getByLabel('Rôle', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('dialog').getByLabel('Affectation de faculté').count(), 1);
  const updatesBefore = requests.filter(request => request.method === 'PATCH' && request.url.includes('/admin/users/')).length;
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer les modifications' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(requests.filter(request => request.method === 'PATCH' && request.url.includes('/admin/users/')).length, updatesBefore, 'Unchanged user edits do not revoke sessions');

  await page.getByRole('button', { name: 'Créer un compte', exact: true }).click();
  const accountDialog = page.getByRole('dialog');
  assert.equal(await accountDialog.getByLabel('Mot de passe initial').getAttribute('minlength'), '10');
  await accountDialog.getByLabel('Nom', { exact: true }).fill('Browser test');
  await accountDialog.getByLabel(/Nom d.utilisateur/).fill('browser_test');
  await accountDialog.getByLabel('Mot de passe initial').fill('too_short');
  assert.equal(await accountDialog.evaluate(form => form.checkValidity()), false);
  await page.keyboard.press('Escape');
  await accountDialog.waitFor({ state: 'hidden' });

  await clickTab('Ressources');
  assert.ok(await page.locator('.admin-resource-row').count() > 0);
  await page.locator('.admin-resource-row').first().getByRole('button', { name: /Gérer/ }).click();
  const resourceDialog = page.getByRole('dialog');
  assert.equal(await resourceDialog.getByLabel('Catégorie', { exact: true }).count(), 1);
  assert.equal(await resourceDialog.getByLabel('Semestre', { exact: true }).count(), 1);
  assert.equal(await resourceDialog.getByLabel('Statut', { exact: true }).count(), 1);
  assert.ok(await resourceDialog.getByText(/Remplacer le document/).isVisible());
  await resourceDialog.getByRole('button', { name: 'Retirer de la bibliothèque' }).click();
  assert.ok(await resourceDialog.getByRole('button', { name: 'Confirmer le retrait' }).isVisible());
  await resourceDialog.getByRole('button', { name: 'Annuler', exact: true }).click();
  await page.keyboard.press('Escape');
  await resourceDialog.waitFor({ state: 'hidden' });

  await clickTab('Canaux');
  await page.locator('.admin-channel-card').first().waitFor();
  await page.locator('.admin-channel-card').first().getByRole('button', { name: /Configurer/ }).click();
  await page.getByRole('dialog').getByLabel('Limiter aux administrateurs').check();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  await clickTab('Demandes de contact');
  assert.ok(await page.getByRole('heading', { name: 'Demandes de contact' }).isVisible());
  await clickTab('Publier');
  assert.equal(await page.getByLabel('Publier pour', { exact: true }).count(), 2);
  const announcementForm = page.locator('.admin-publish-panel').first();
  assert.ok(await announcementForm.getByRole('button', { name: 'Publier', exact: true }).isDisabled());
  await announcementForm.getByLabel('Message', { exact: true }).fill('An important update for the community.');
  assert.ok(await announcementForm.getByRole('button', { name: 'Publier', exact: true }).isEnabled());
  const eventForm = page.locator('.admin-publish-panel').nth(1);
  await eventForm.getByLabel('Titre de l’événement').fill('Workshop');
  await eventForm.getByLabel('Date', { exact: true }).fill('2026-12-15');
  await eventForm.getByLabel('Horaire', { exact: true }).fill('10:00');
  await eventForm.getByLabel('Type d’événement').selectOption('deadline');
  assert.ok(await eventForm.evaluate(form => form.checkValidity()));
  await page.screenshot({ path: '/tmp/campuslink-admin-desktop.png', fullPage: true });

  const layoutChecks = [];
  for (const route of ['/app/admin', '/app/chat/general']) {
    layoutChecks.push({ route, language: 'AR', ...await noOverflow(route, 390, 'AR') });
  }
  await page.goto(`${baseURL}/app/admin`);
  await page.screenshot({ path: '/tmp/campuslink-admin-arabic-mobile.png', fullPage: true });
  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  publicPage.on('pageerror', error => runtimeErrors.push(error.message));
  for (const route of ['/login', '/']) layoutChecks.push({ route, language: 'AR', ...await noOverflow(route, 390, 'AR', publicPage) });
  await publicContext.close();
  const studentContext = await browser.newContext();
  const studentLogin = await studentContext.request.post(`${baseURL}/api/login`, { data: { username: 'yassine', password: process.env.CAMPUS_STUDENT_PASSWORD || 'Campus2026!' } });
  assert.equal(studentLogin.status(), 200);
  assert.equal((await studentContext.request.get(`${baseURL}/api/admin`)).status(), 403, 'Server rejects student access to administration');
  const studentPage = await studentContext.newPage();
  await studentPage.goto(`${baseURL}/app/admin`);
  await studentPage.locator('.admin-empty').waitFor();
  assert.equal(await studentPage.locator('.admin-tabbar').count(), 0, 'Student UI omits administrator controls');
  await studentContext.close();
  assert.deepEqual(runtimeErrors, [], 'No browser runtime errors');
  console.log(JSON.stringify({ status: 'passed', tests: 'Admin tabs, user filters/dialogs, account validation, resource edit/confirmed removal UI, channel editor, publication forms, Arabic mobile layouts', originalUserCount, layoutChecks, screenshots: ['/tmp/campuslink-admin-desktop.png', '/tmp/campuslink-admin-arabic-mobile.png'] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ url: page.url(), runtimeErrors, body: await page.locator('body').innerText().catch(() => ''), error: error.message }, null, 2));
  await page.screenshot({ path: '/tmp/campuslink-admin-error.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context.request.patch(`${baseURL}/api/profile`, { data: { language: initialLanguage } }).catch(() => {});
  await browser.close();
}
