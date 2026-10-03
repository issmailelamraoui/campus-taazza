import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { browserOptions } from './browser-utils.mjs';
import { messagePath } from '../src/utils.js';

const origin = process.env.CAMPUS_BROWSER_ORIGIN || 'http://localhost:5173';
const browser = await chromium.launch(browserOptions());
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('response', response => { if (response.status() === 401) console.log('AUTH RESPONSE', response.url()); });
page.on('pageerror', error => { errors.push(error.message); console.log('BROWSER ERROR', error.message); });
let initial;
let savedResource;
let changedPassword = '';
const report = message => console.log(`PASS ${message}`);
const navigate = async path => { await page.goto(`${origin}${path}`); await page.locator('.study-page').waitFor(); };
const json = async (path, options) => {
  const result = await page.request.fetch(`${origin}/api${path}`, options);
  const body = await result.json();
  assert.ok(result.ok(), `${path}: ${JSON.stringify(body)}`);
  return body;
};
try {
  await page.goto(`${origin}/login`);
  await page.getByLabel(/Nom d[’']utilisateur/).fill('sara');
  await page.getByLabel('Mot de passe', { exact: true }).fill('Campus2026!');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.waitForURL('**/app');
  await page.getByRole('heading', { name: 'Bonjour Sara.' }).waitFor();
  initial = await json('/bootstrap');
  assert.equal(initial.faculty.id, 'flaa');
  assert.ok(initial.resources.length >= 10);
  report('assigned faculty dashboard and live resource counts');

  await navigate('/app/resources');
  await page.locator('.study-semester-strip').getByRole('button', { name: 'S3', exact: true }).click();
  await page.waitForURL('**/app/resources?semester=3');
  await expect(page.locator('.resource-card')).toHaveCount(initial.resources.filter(r => r.semester === 3).length);
  report('all-category semester filter remains in the library');

  await navigate('/app/resources/courses/s1');
  await page.getByLabel('Module', { exact: true }).selectOption('Linguistique');
  await page.waitForURL('**/app/resources/courses/s1/linguistique');
  const resource = initial.resources.find(r => r.category === 'courses' && r.module === 'Linguistique');
  await expect(page.locator('.resource-card')).toHaveCount(1);
  await navigate(`/app/resources/courses/s1/linguistique#resource-${resource.id}`);
  await page.locator('.study-resource-focus').waitFor();
  assert.equal(await page.locator(`[id="resource-${resource.id}"]`).count(), 1);
  await page.locator('.resource-card').getByRole('button', { name: 'Ouvrir', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').getByRole('link', { name: 'Voir la discussion' }).click();
  await page.waitForURL('**' + messagePath(resource));
  assert.equal(await page.getByRole('dialog').count(), 0);
  report('resource module route, unique anchor, preview and original discussion');

  savedResource = initial.resources.find(r => !initial.saved.some(s => s.type === 'resource' && s.id === r.id));
  await navigate(`/app/resources/${savedResource.category}/s${savedResource.semester}`);
  await page.locator(`#resource-${savedResource.id}`).getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.locator(`#resource-${savedResource.id}`).getByRole('button', { name: 'Retirer des enregistrés', exact: true }).waitFor();
  await navigate('/app/saved');
  await page.locator(`#resource-${savedResource.id}`).waitFor();
  await page.reload();
  await page.locator(`#resource-${savedResource.id}`).waitFor();
  await page.locator(`#resource-${savedResource.id}`).getByRole('button', { name: 'Retirer des enregistrés', exact: true }).click();
  await page.locator(`#resource-${savedResource.id}`).waitFor({ state: 'detached' });
  savedResource = null;
  report('saved resource toggle persists across navigation and reload');

  await navigate('/app/search?q=linguistique&type=courses&semester=1&module=Linguistique&author=7&date=' + resource.created_at.slice(0, 10));
  await page.locator('.study-search-result').waitFor();
  assert.equal(await page.locator('.study-search-result').count(), 1);
  await page.locator('.study-search-result').click();
  await page.waitForURL(`**#resource-${resource.id}`);
  report('real search matches keyword, type, semester, module, author and exact date');
  await navigate('/app/search?q=campuslink-no-match-9da44');
  await page.getByRole('heading', { name: 'Aucun résultat trouvé' }).waitFor();
  report('search designed empty state');

  await navigate('/app/members');
  await page.getByLabel('Rechercher un membre…', { exact: true }).fill('Nadia');
  await expect(page.locator('.study-member-card')).toHaveCount(1);
  await navigate('/app/members#member-7');
  await page.locator('.study-resource-focus').waitFor();
  report('member search and exact member navigation');

  await navigate('/app/calendar?date=2026-10-15');
  await page.locator('.study-day-agenda').getByRole('heading', { name: 'Examens normaux · S1' }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.study-day-agenda').getByRole('button', { name: 'Ajouter à mon calendrier' }).click();
  const download = await downloadPromise;
  assert.ok(download.suggestedFilename().endsWith('.ics'));
  await page.getByRole('button', { name: 'Mois suivant', exact: true }).click();
  await page.locator('.study-calendar-toolbar').getByRole('heading', { name: /novembre 2026/i }).waitFor();
  await page.getByRole('button', { name: /Aujourd.hui/, exact: true }).click();
  await page.locator('.study-calendar-toolbar').getByRole('heading', { name: /octobre 2026/i }).waitFor();
  await navigate('/app/calendar?date=2026-99-99');
  await page.locator('.study-calendar-toolbar').getByRole('heading', { name: /octobre 2026/i }).waitFor();
  report('calendar month controls, selection, .ics export and invalid date fallback');

  await navigate('/app/notifications');
  await page.locator('.study-filter-pills').getByRole('button', { name: 'Ressources', exact: true }).click();
  assert.equal(await page.locator('.study-notification:not(.type-resources)').count(), 0);
  await page.locator('.study-filter-pills').getByRole('button', { name: 'Tout' }).click();
  if (await page.locator('.study-notification.unread').count()) {
    const notification = (await json('/bootstrap')).notifications.find(n => !n.read);
    await page.locator('.study-notification.unread').first().click();
    await page.waitForURL(`**${notification.path}`);
    assert.ok((await json('/bootstrap')).notifications.find(n => n.id === notification.id).read);
  }
  await navigate('/app/notifications');
  const readAll = page.getByRole('button', { name: 'Marquer tout comme lu', exact: true });
  if (await readAll.isEnabled()) {
    await readAll.click();
    await expect(readAll).toBeDisabled();
    await expect(page.locator('.study-notification.unread')).toHaveCount(0);
  }
  await page.getByLabel('Non lues uniquement').check();
  await page.getByRole('heading', { name: 'Tout est à jour' }).waitFor();
  report('notification filter, read state and exact destination');

  await navigate('/app/settings');
  await page.getByLabel(/Nom d[’']utilisateur/).fill('sara_study_test');
  const resourcePreference = page.locator('.study-preference').first().locator('input');
  await resourcePreference.setChecked(!initial.user.preferences.resources);
  await page.getByRole('button', { name: 'Enregistrer les modifications', exact: true }).click();
  await page.locator('.study-form-success').waitFor();
  assert.equal((await json('/session')).user.username, 'sara_study_test');
  assert.equal((await json('/session')).user.faculty_id, 'flaa');
  assert.equal((await json('/session')).user.preferences.resources, !initial.user.preferences.resources);
  await page.getByLabel(/Nom d[’']utilisateur/).fill('sara');
  await resourcePreference.setChecked(initial.user.preferences.resources);
  await page.getByRole('button', { name: 'Enregistrer les modifications', exact: true }).click();
  await page.locator('.study-form-success').waitFor();
  await page.getByLabel('Nouveau mot de passe', { exact: true }).fill('NewCampus2026!');
  await page.getByLabel('Confirmer le mot de passe', { exact: true }).fill('DifferentPassword2026!');
  await page.getByRole('button', { name: 'Enregistrer les modifications', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Les mots de passe ne correspondent pas.' }).waitFor();
  await page.getByLabel('Mot de passe actuel', { exact: true }).fill('Campus2026!');
  await page.getByLabel('Confirmer le mot de passe', { exact: true }).fill('NewCampus2026!');
  await page.getByRole('button', { name: 'Enregistrer les modifications', exact: true }).click();
  await page.locator('.study-form-success').waitFor();
  changedPassword = 'NewCampus2026!';
  assert.equal((await json('/session')).user.username, 'sara');
  await page.getByLabel('Mot de passe actuel', { exact: true }).fill(changedPassword);
  await page.getByLabel('Nouveau mot de passe', { exact: true }).fill('Campus2026!');
  await page.getByLabel('Confirmer le mot de passe', { exact: true }).fill('Campus2026!');
  await page.getByRole('button', { name: 'Enregistrer les modifications', exact: true }).click();
  await page.locator('.study-form-success').waitFor();
  changedPassword = '';
  await page.locator('.study-avatar-editor input[type=file]').setInputFiles({
    name: 'pixel.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64'),
  });
  await expect(page.locator('.study-avatar-editor img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  report('profile/preferences persistence, immutable faculty, avatar preview, and password change/restore');

  await navigate('/app/about');
  assert.ok(await page.locator('.study-about-hero h1').textContent());
  assert.equal(await page.locator('.study-about-hero h1').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['/app', '/app/resources', '/app/search?q=linguistique', '/app/calendar', '/app/settings', '/app/members', '/app/notifications', '/app/saved']) {
    await navigate(route);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, `${route} has horizontal viewport overflow`);
  }
  report('all study pages fit the mobile viewport');
  await json('/profile', { method: 'PATCH', data: { language: 'ar' } });
  await navigate('/app/calendar');
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  report('Arabic RTL layout at mobile width');
  assert.deepEqual(errors, [], 'Browser runtime errors');
  report('no browser runtime errors');
} catch (error) {
  console.log('FAILED PAGE', page.url(), await page.locator('body').innerText());
  console.log('RUNTIME ERRORS', errors);
  await page.screenshot({ path: '/tmp/campuslink-study-test-failure.png' });
  throw error;
} finally {
  if (initial) {
    if (changedPassword) await page.request.patch(`${origin}/api/profile`, { data: { password: 'Campus2026!', current_password: changedPassword } }).catch(() => {});
    await page.request.patch(`${origin}/api/profile`, { data: { username: initial.user.username, language: initial.user.language, preferences: initial.user.preferences } }).catch(() => {});
    if (savedResource) await page.request.post(`${origin}/api/saved`, { data: { type: 'resource', id: savedResource.id } }).catch(() => {});
  }
  await browser.close();
}
