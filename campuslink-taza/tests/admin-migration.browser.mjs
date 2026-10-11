import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chooseOption } from './ui.helpers.mjs';

// These tests exercise UI/API contracts with isolated fixtures. Real database,
// authorization, storage and provider integration are covered separately.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const passed = [], problems = [];
const date = '2026-10-09T09:00:00.000Z';
await mkdir('test-results', { recursive: true });

function fixtures(role) {
  const self = { id: 1, name: 'Administration test', username: 'admin.test', email: 'admin@example.test', role, faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, language: 'fr', preferences: {}, account_status: 'approved', disabled: false, registered_at: date };
  const student = { ...self, id: 2, name: 'Sara Benali', username: 'sara.test', email: 'sara@example.test', role: 'student' };
  const pending = { ...student, id: 3, name: 'Inscription attente', username: 'pending.test', email: 'pending@example.test', account_status: 'pending' };
  const resource = { id: 10, faculty_id: 'flaa', filiere_id: 'french_studies', title: 'Cours de phonétique', filename: 'phonetique.pdf', module: 'Phonétique', semester: 1, category: 'courses', resource_type: 'courses', part_number: 'complete', teacher_name: 'Équipe pédagogique', created_at: date, size: 145000, mime: 'application/pdf', version: 1, status: 'new', library_visible: true, author: student, versions: [] };
  return { self, users: [self, student, pending], resources: [resource], registrations: [pending], channels: [{ id: 'general', faculty_id: 'flaa', name: 'Chat général', description: 'Échanger avec les étudiants.', read_only: false }], announcements: [{ id: 20, faculty_id: 'flaa', title: 'Information campus', kind: 'announcement', content: 'Une information importante.', author: self, created_at: date, channel: 'important', pinned: false }], messages: [{ id: 40, faculty_id: 'flaa', filiere_id: null, channel: 'general', content: 'Message à modérer', author: student, created_at: date, pinned: false, reactions: {}, my_reactions: [] }], reports: [{ id: 30, faculty_id: 'flaa', target_type: 'message', target_id: 40, reason: 'inappropriate', details: 'Contenu signalé par un étudiant.', reporter: student, created_at: date, status: 'open' }], contacts: [{ id: 50, faculty_id: 'flaa', user_id: 2, name: 'Sara Benali', email: 'sara@example.test', subject: 'credentials', message: 'Besoin d’aide pour mon compte.', created_at: date, status: 'open' }], blocks: [], events: [], calls: [], fail: null, delay: 0 };
}

async function setup({ role = 'global_admin', width = 1440, theme = 'dark' } = {}) {
  const state = fixtures(role);
  const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 1000 }, reducedMotion: 'reduce', hasTouch: width < 760 });
  await context.addInitScript(({ theme }) => { localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme)); localStorage.setItem('campuslink-prototype-v1:language', '"fr"'); window.EventSource = undefined;localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1','true'); }, { theme });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => problems.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), requestURL = new URL(request.url()), path = requestURL.pathname.replace(/^\/api/, ''), method = request.method();
    const body = request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : request.postData() || '';
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (method === 'GET') {
      if (path === '/session') return send({ user: state.self });
      if (path === '/bootstrap') return send({ user: state.self, faculty: { id: 'flaa', code: 'FLAA', name: 'Faculté des Langues, des Lettres et des Arts', members: 3 }, resources: state.resources, announcements: state.announcements, messages: state.messages, channels: state.channels, members: state.users.filter(item => item.account_status === 'approved'), saved: [], history: [], events: state.events, notifications: [] });
      if (path === '/admin') return send({ users: role === 'moderator' ? [] : state.users, resources: role === 'moderator' ? [] : state.resources, channels: role === 'moderator' ? [] : state.channels, contacts: role === 'moderator' ? [] : state.contacts, reports: requestURL.searchParams.get('status') === 'all' ? state.reports : state.reports.filter(item => ['open', 'reviewed'].includes(item.status)), announcements: role === 'moderator' ? [] : state.announcements, events: role === 'moderator' ? [] : state.events });
      if (path === '/admin/registrations') return send({ requests: state.registrations });
      if (path === '/chat/blocks') return send({ blocks: state.blocks });
    }
    state.calls.push({ path, method, body });
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    if (state.fail === path) { state.fail = null; return send({ error: 'Échec serveur de vérification.' }, 500); }
    if (path === '/admin/users' && method === 'POST') { const user = { ...body, id: 100, faculty_id: body.faculty_id, filiere_id: null, account_status: 'approved', disabled: false }; state.users.push(user); return send({ user }, 201); }
    if (/^\/admin\/users\/\d+\/admission$/.test(path) && method === 'PATCH') { const id = Number(path.split('/')[3]); const user = state.users.find(item => item.id === id); user.account_status = body.status; state.registrations = body.status === 'approved' ? state.registrations.filter(item => item.id !== id) : state.registrations; return send({ user }); }
    if (/^\/admin\/users\/\d+$/.test(path)) { const id = Number(path.split('/')[3]); if (method === 'DELETE') { state.users = state.users.filter(item => item.id !== id); state.registrations = state.registrations.filter(item => item.id !== id); return send({ ok: true }); } const user = state.users.find(item => item.id === id); Object.assign(user, body); return send({ user }); }
    if (path === '/admin/channels/general') { Object.assign(state.channels[0], body); return send({ channel: state.channels[0] }); }
    if (path === '/chat/blocks' && method === 'POST') { state.blocks.push({ user_id: Number(body.user_id), faculty_id: 'flaa', created_at: date }); return send({ chat_blocked: true }); }
    if (/^\/chat\/blocks\/\d+$/.test(path) && method === 'DELETE') { state.blocks = state.blocks.filter(item => item.user_id !== Number(path.split('/')[3])); return send({ chat_blocked: false }); }
    if (path === '/admin/resources/10/replace') { state.resources[0].version++; state.resources[0].status = 'updated'; return send({ resource: state.resources[0] }); }
    if (path === '/admin/resources/10') { if (method === 'DELETE') { state.resources = []; return send({ ok: true }); } Object.assign(state.resources[0], body); return send({ resource: state.resources[0] }); }
    if (path === '/admin/announcements' && method === 'POST') { const announcement = { ...body, id: 120, faculty_id: body.faculty_id === 'all' ? 'flaa' : body.faculty_id || 'flaa', author: state.self, created_at: date }; state.announcements.push(announcement); return send({ announcement }, 201); }
    if (/^\/admin\/announcements\/\d+$/.test(path)) { const id = Number(path.split('/')[3]); if (method === 'DELETE') { state.announcements = state.announcements.filter(item => item.id !== id); return send({ ok: true }); } const announcement = state.announcements.find(item => item.id === id); Object.assign(announcement, body); return send({ announcement }); }
    if (path === '/admin/events') { const event = { ...body, id: 130, faculty_id: 'flaa' }; state.events.push(event); return send({ event }, 201); }
    if (path === '/admin/reports/30') { Object.assign(state.reports[0], body); return send({ ok: true }); }
    if (path === '/admin/reports/30/remove-target') { state.messages = []; state.reports[0].status = 'resolved'; state.reports[0].note = body.note; return send({ ok: true, target_type: 'message', target_id: 40 }); }
    if (path === '/admin/messages/40/remove') { state.messages = []; return send({ ok: true }); }
    if (path === '/messages/40/pin') { const message = state.messages[0]; message.pinned = body.pinned ?? !message.pinned; state.announcements = state.announcements.filter(item => item.message_id !== 40); if (message.pinned) state.announcements.push({ id: 140, faculty_id: 'flaa', message_id: 40, title: body.title || '', content: message.content, author: message.author, created_at: date, pinned: true, channel: 'general' }); return send({ pinned: message.pinned }); }
    if (path === '/admin/contacts/50') { Object.assign(state.contacts[0], body); return send({ ok: true }); }
    problems.push(`Unexpected API contract: ${method} ${path}`);
    return send({ error: 'Route de test non reconnue.' }, 500);
  });
  await page.goto(`${baseURL}/app/admin`);
  await expect(page.locator('.admin-page')).toHaveAttribute('aria-busy', 'false');
  return { context, page, state };
}

const tab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
const modal = page => page.getByRole('dialog');
async function scenario(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }
async function close(page) { await modal(page).locator('.modal-footer').getByRole('button', { name: /Fermer|Annuler/ }).click(); await expect(modal(page)).toHaveCount(0); }
const saved = page => expect(modal(page)).toHaveCount(0);

try {
  await scenario('Global administrator creates credentials, changes roles, revokes access and deletes a student', async () => {
    const { context, page, state } = await setup();
    await expect(page.getByRole('tab')).toHaveCount(8);
    await tab(page, 'Comptes');
    await page.getByRole('button', { name: 'Ajouter un compte', exact: true }).click();
    await modal(page).getByLabel('Nom complet', { exact: true }).fill('Compte créé');
    await modal(page).getByLabel('Nom d’utilisateur', { exact: true }).fill('created.test');
    await modal(page).getByLabel('Adresse e-mail', { exact: true }).fill('created@example.test');
    await modal(page).getByLabel('Mot de passe initial', { exact: true }).fill('Test-password-123');
    await modal(page).getByRole('button', { name: 'Enregistrer', exact: true }).click(); await saved(page);
    const created = state.calls.find(item => item.path === '/admin/users'); assert.equal(created.body.role, 'student'); assert.equal(created.body.faculty_id, 'flaa'); assert.equal(created.body.password, 'Test-password-123');
    await page.getByRole('button', { name: 'Modifier Sara Benali', exact: true }).click();
    await chooseOption(modal(page).getByRole('combobox', { name: 'Rôle', exact: true }), 'moderator');
    await modal(page).getByRole('button', { name: 'Enregistrer', exact: true }).click(); await saved(page);
    assert.deepEqual(state.calls.find(item => item.path === '/admin/users/2').body, { role: 'moderator' });
    await page.getByRole('button', { name: 'Désactiver Sara Benali', exact: true }).click();
    await modal(page).getByRole('button', { name: 'Désactiver', exact: true }).click(); await saved(page);
    assert.equal(state.users.find(item => item.id === 2).disabled, true);
    await page.getByRole('button', { name: 'Consulter Compte créé', exact: true }).click();
    await modal(page).getByRole('button', { name: 'Supprimer', exact: true }).click();
    await modal(page).getByRole('button', { name: 'Supprimer le compte', exact: true }).click(); await saved(page);
    assert.equal(state.users.some(item => item.id === 100), false);
    await context.close();
  });

  await scenario('Admission decisions persist and a declined registration can subsequently be accepted', async () => {
    const { context, page, state } = await setup(); await tab(page, 'Comptes');
    await page.locator('[data-registration-id="3"]').getByRole('button', { name: 'Refuser', exact: true }).click();
    await expect(page.locator('[data-registration-id="3"] .admin-status')).toHaveText('Refusée');
    assert.equal(state.users.find(item => item.id === 3).account_status, 'rejected');
    await page.locator('[data-registration-id="3"]').getByRole('button', { name: 'Accepter', exact: true }).click();
    await expect(page.locator('[data-registration-id="3"]')).toHaveCount(0);
    assert.equal(state.users.find(item => item.id === 3).account_status, 'approved');
    await context.close();
  });

  await scenario('Resource management saves classification, preserves complete parts and replaces then withdraws files', async () => {
    const { context, page, state } = await setup(); await tab(page, 'Ressources');
    await page.getByRole('button', { name: 'Modifier Cours de phonétique', exact: true }).click();
    await modal(page).getByLabel('Titre', { exact: true }).fill('Phonétique révisée');
    await chooseOption(modal(page).getByRole('combobox', { name: 'Statut', exact: true }), 'corrected');
    await modal(page).getByRole('button', { name: 'Enregistrer', exact: true }).click(); await saved(page);
    const patch = state.calls.find(item => item.path === '/admin/resources/10'); assert.equal(patch.body.part_number, 'complete'); assert.equal(patch.body.status, 'corrected'); assert.equal(patch.body.teacher_name, 'Équipe pédagogique');
    await page.getByRole('button', { name: 'Modifier Phonétique révisée', exact: true }).click();
    await modal(page).locator('input[type="file"]').setInputFiles({ name: 'new-version.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nnew version') }); await saved(page);
    assert.ok(state.calls.find(item => item.path === '/admin/resources/10/replace').body.includes('name="file"')); assert.equal(state.resources[0].version, 2);
    await page.getByRole('button', { name: 'Retirer Phonétique révisée', exact: true }).click();
    await modal(page).getByRole('button', { name: 'Retirer', exact: true }).click(); await saved(page);
    await expect(page.locator('.admin-resource-row')).toHaveCount(0); await context.close();
  });

  await scenario('Channels and discussion blocks persist; failed actions retain the dialog and allow an explicit retry', async () => {
    const { context, page, state } = await setup(); await tab(page, 'Communauté');
    await page.locator('[data-channel-id="general"]').getByRole('button', { name: 'Configurer', exact: true }).click();
    await modal(page).getByLabel('Description', { exact: true }).fill('Nouvelle description');
    await modal(page).locator('input[type="checkbox"]').check();
    state.fail = '/admin/channels/general'; state.delay = 180;
    await modal(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(modal(page).getByRole('button', { name: 'Enregistrement…', exact: true })).toBeDisabled();
    await expect(modal(page).getByRole('alert')).toHaveText('Échec serveur de vérification.');
    assert.equal(state.channels[0].description, 'Échanger avec les étudiants.');
    await modal(page).getByRole('button', { name: 'Enregistrer', exact: true }).click(); await saved(page); state.delay = 0;
    assert.equal(state.channels[0].read_only, true); assert.equal(state.channels[0].description, 'Nouvelle description');
    await page.locator('[data-chat-user-id="2"]').getByRole('button', { name: 'Bloquer', exact: true }).click();
    await modal(page).getByRole('button', { name: 'Bloquer', exact: true }).click(); await saved(page);
    await expect(page.locator('[data-chat-user-id="2"]')).toContainText('Discussions bloquées');
    await page.locator('[data-chat-user-id="2"]').getByRole('button', { name: 'Débloquer', exact: true }).click();
    await modal(page).getByRole('button', { name: 'Débloquer', exact: true }).click(); await saved(page); assert.equal(state.blocks.length, 0);
    await context.close();
  });

  await scenario('Announcements and message promotions persist while calendar controls remain retired', async () => {
    const { context, page, state } = await setup(); await tab(page, 'Annonces');
    await page.locator('.admin-announcement-card').filter({ hasText: 'Information campus' }).getByRole('button', { name: 'Modifier', exact: true }).click();
    await expect(modal(page).getByRole('combobox', { name: 'Type', exact: true })).toContainText('Administration'); await close(page);
    await page.getByRole('button', { name: 'Rédiger une annonce', exact: true }).click();
    await modal(page).getByLabel('Titre', { exact: true }).fill('Publication globale'); await modal(page).getByLabel('Contenu', { exact: true }).fill('Information pour toutes les facultés.');
    await chooseOption(modal(page).getByRole('combobox', { name: 'Publier pour', exact: true }), 'all');
    await modal(page).getByRole('button', { name: 'Publier', exact: true }).click(); await saved(page);
    assert.equal(state.calls.find(item => item.path === '/admin/announcements').body.faculty_id, 'all');
    const row = page.locator('.admin-announcement-card').filter({ hasText: 'Publication globale' });
    await row.getByRole('button', { name: 'Épingler', exact: true }).click(); await expect(row).toContainText('Épinglée');
    await row.getByRole('button', { name: 'Modifier', exact: true }).click(); await modal(page).getByLabel('Titre', { exact: true }).fill('Titre modifié'); await modal(page).getByRole('button', { name: 'Enregistrer', exact: true }).click(); await saved(page);
    await page.locator('.admin-announcement-card').filter({ hasText: 'Titre modifié' }).getByRole('button', { name: 'Retirer cette annonce', exact: true }).click(); await modal(page).getByRole('button', { name: 'Retirer l’annonce', exact: true }).click(); await saved(page);
    await expect(page.getByRole('button', { name: 'Ajouter un événement', exact: true })).toHaveCount(0);
    await expect(page.locator('#admin-events-title')).toHaveCount(0);
    await tab(page, 'Communauté'); await page.getByRole('button', { name: 'Créer une annonce', exact: true }).click();
    await modal(page).getByLabel('Titre', { exact: true }).fill('Message utile'); await modal(page).getByRole('button', { name: 'Publier', exact: true }).click(); await saved(page);
    assert.deepEqual(state.calls.find(item => item.path === '/messages/40/pin').body, { pinned: true, title: 'Message utile' });
    await context.close();
  });

  await scenario('Report decisions and account-support replies use persisted moderation and in-app notifications', async () => {
    const { context, page, state } = await setup(); await tab(page, 'Signalements');
    await page.locator('.admin-report-row').getByRole('button', { name: 'Examiner', exact: true }).click();
    await modal(page).getByLabel('Note de modération (facultatif)', { exact: true }).fill('Vérifié par l’équipe');
    await modal(page).getByRole('button', { name: 'Marquer comme examiné', exact: true }).click(); await saved(page); assert.equal(state.reports[0].status, 'reviewed'); assert.equal(state.reports[0].note, 'Vérifié par l’équipe');
    await page.locator('.admin-report-row').getByRole('button', { name: 'Examiner', exact: true }).click();
    await modal(page).getByRole('button', { name: 'Retirer le message et traiter le signalement', exact: true }).click(); await saved(page); assert.equal(state.messages.length, 0); assert.equal(state.reports[0].status, 'resolved');
    await expect(page.locator('.admin-report-row')).toHaveCount(0);
    await chooseOption(page.getByRole('combobox', { name: 'Filtrer par statut', exact: true }), 'resolved');
    await expect(page.locator('.admin-report-row')).toHaveCount(1);
    await tab(page, 'Assistance'); await page.locator('.admin-assistance-row').getByRole('button', { name: 'Traiter', exact: true }).click();
    await modal(page).getByLabel('Réponse à l’étudiant (facultatif)', { exact: true }).fill('Votre demande a été traitée.');
    await modal(page).getByRole('button', { name: 'Répondre et clôturer', exact: true }).click(); await saved(page);
    assert.deepEqual(state.calls.find(item => item.path === '/admin/contacts/50').body, { status: 'resolved', reply: 'Votre demande a été traitée.' }); await context.close();
  });

  await scenario('Faculty administration and moderation expose only their allowed controls', async () => {
    const faculty = await setup({ role: 'faculty_admin' }); await tab(faculty.page, 'Comptes');
    await expect(faculty.page.getByRole('button', { name: 'Ajouter un compte', exact: true })).toBeDisabled(); await expect(faculty.page.locator('#admin-admissions-title')).toHaveCount(0);
    await faculty.page.getByRole('button', { name: 'Modifier Sara Benali', exact: true }).click();
    await modal(faculty.page).getByRole('combobox', { name: 'Rôle', exact: true }).click(); await expect(faculty.page.getByRole('option')).toHaveCount(2); await faculty.page.keyboard.press('Escape'); await close(faculty.page);
    await tab(faculty.page, 'Communauté'); await expect(faculty.page.locator('#admin-chat-blocks-title')).toHaveCount(0); await faculty.context.close();
    const moderator = await setup({ role: 'moderator' }); await expect(moderator.page.getByRole('tab')).toHaveCount(3); await tab(moderator.page, 'Communauté'); await expect(moderator.page.locator('#admin-channels-title')).toHaveCount(0); await expect(moderator.page.locator('#admin-chat-blocks-title')).toHaveCount(0); await moderator.context.close();
  });

  await scenario('Mobile dark/light administration keeps themed controls and fits narrow screens', async () => {
    for (const theme of ['dark', 'light']) {
      const { context, page } = await setup({ width: 320, theme }); await tab(page, 'Comptes');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
      await page.getByRole('button', { name: 'Ajouter un compte', exact: true }).click();
      await expect(page.locator('select,datalist')).toHaveCount(0);
      assert.ok(await modal(page).evaluate(element => element.getBoundingClientRect().width <= innerWidth));
      await page.screenshot({ path: `test-results/admin-migration-mobile-${theme}.png`, animations: 'disabled' }); await close(page); await context.close();
    }
  });
  assert.deepEqual(problems, []);
  await writeFile('test-results/admin-migration-report.json', JSON.stringify({ passed, problems }, null, 2));
  console.log(`${passed.length} admin UI contract scenarios passed.`);
} finally { await browser.close(); }
