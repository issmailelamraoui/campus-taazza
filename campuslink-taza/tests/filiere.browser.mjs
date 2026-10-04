import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { browserOptions, selectLanguage } from './browser-utils.mjs';
import { messagePath, resourcePath } from '../src/utils.js';
import { getChatSemester, getChatSemesterLabel } from '../shared/studies.js';

const origin = process.env.CAMPUS_BROWSER_ORIGIN || 'http://localhost:5173';
const browser = await chromium.launch(browserOptions());
const contexts = [];
const admin = await browser.newContext();
contexts.push(admin);
const errors = [];
let page;
const report = message => console.log(`PASS ${message}`);
const password = 'StudiesBrowser2026!';
const groups = {
  fsa: [
    'Filière Ingénierie des Systèmes d’Information', 'Filière Sciences de Données',
    'Filière Sciences Mathématiques', 'Filière Géologie', 'Filière Biologie',
    'Filière Physique', 'Filière Mécanique', 'Filière Chimie',
  ],
  flaa: ['مسلك الدراسات الفرنسية (S1, S3, S5)', 'شعبة اللغة العربية والآداب والفنون', 'شعبة التاريخ والحضارة', 'شعبة الجغرافيا'],
  feg: ['Filière Économie', 'Filière Gestion'],
  fsjp: ['شعبة القانون العام', 'شعبة القانون الخاص', 'مسار التميز في الدراسات السياسية والدولية (S5)'],
};

async function json(context, path, options) {
  const response = await context.request.fetch(`${origin}/api${path}`, options);
  const body = await response.json();
  assert.ok(response.ok(), `${path}: ${response.status()} ${JSON.stringify(body)}`);
  return body;
}

async function provision(faculty, suffix, role = 'student') {
  const username = `studies_browser_${suffix}`;
  await json(admin, '/admin/users', { method: 'POST', data: { username, email: `${username}@campuslink.test`, name: `Étudiant ${suffix}`, password, faculty_id: faculty, role } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  await json(context, '/login', { method: 'POST', data: { username, password } });
  return context;
}

async function studySetup(context, filiereName, semester = 1) {
  const target = await context.newPage();
  target.on('pageerror', error => errors.push(error.message));
  await target.goto(`${origin}/app`);
  await target.waitForURL('**/onboarding/studies');
  await target.locator('.studies-onboarding').waitFor();
  assert.equal(await target.locator('.faculty-choice, .faculty-choice-grid').count(), 0, 'Account setup never repeats faculty selection');
  assert.equal(await target.getByRole('combobox', { name: /faculté/i }).count(), 0, 'No faculty selector');
  const session = await json(context, '/session');
  assert.ok(session.user.faculty_id, 'Faculty is already assigned');
  await expect(target.locator('#setup-filiere option')).toHaveCount(groups[session.user.faculty_id].length + 1);
  const listed = await target.locator('#setup-filiere').evaluate(select => [...select.options].filter(option => option.value).map(option => option.textContent));
  assert.deepEqual(listed, groups[session.user.faculty_id], 'Only the exact supplied group is offered');
  await expect(target.locator('.studies-selection-form').getByRole('button', { name: 'Compléter mon compte', exact: true })).toBeDisabled();
  await target.locator('#setup-filiere').selectOption({ label: filiereName });
  await target.locator('#setup-semester').selectOption(String(semester));
  await target.locator('.studies-selection-form').getByRole('button', { name: 'Compléter mon compte', exact: true }).click();
  await target.waitForURL('**/app');
  await target.locator('.study-page').waitFor();
  const after = await json(context, '/session');
  assert.equal(after.user.faculty_id, session.user.faculty_id, 'Completing studies preserves the existing faculty');
  assert.equal(after.user.current_semester, semester);
  assert.ok(after.user.filiere_id);
  return { page: target, user: after.user };
}

async function sendChat(target, text) {
  await target.locator('.chat-composer textarea').fill(text);
  const persisted=target.waitForResponse(response=>new URL(response.url()).pathname==='/api/messages'&&response.request().method()==='POST');
  await target.locator('.composer-send').click();
  await target.locator('.message-text').filter({ hasText: text }).waitFor();
  assert.ok((await persisted).ok(), 'The visible message is persisted before backend assertions');
}

async function tab(target, semester) {
  const label = getChatSemesterLabel(semester);
  await target.locator('.chat-semester-tabs').getByRole('tab', { name: label, exact: true }).click();
  await expect(target.locator('.chat-semester-tabs').getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
  await target.waitForURL(`**/app/chat/filiere?semester=${getChatSemester(semester)}`);
}

async function compactPrivateHeader(target, width) {
  await target.locator('.filiere-chat .chat-header').waitFor({ state: 'visible' });
  const dimensions = await target.evaluate(() => {
    const rect = element => { const box = element.getBoundingClientRect(); return { x: box.x, right: box.right, top: box.top, bottom: box.bottom, height: box.height, width: box.width }; };
    const title = document.querySelector('.filiere-chat .chat-header h1');
    return {
      width: innerWidth, content: document.documentElement.scrollWidth,
      header: rect(document.querySelector('.filiere-chat .chat-header')),
      title: { ...rect(title), font: parseFloat(getComputedStyle(title).fontSize), lineHeight: parseFloat(getComputedStyle(title).lineHeight) },
      selector: rect(document.querySelector('.chat-header .chat-group-selector')),
    };
  });
  assert.equal(dimensions.width, width);
  assert.ok(dimensions.content <= width, `${width}px private chat has horizontal overflow`);
  assert.ok(dimensions.header.height >= 64 && dimensions.header.height <= 67, `${width}px private header expands to ${dimensions.header.height}px`);
  assert.ok(dimensions.title.font >= 20, `${width}px title becomes too small`);
  assert.ok(dimensions.title.height <= dimensions.title.lineHeight + 1, `${width}px title wraps to an extra row`);
  assert.ok(dimensions.selector.height >= 39 && dimensions.selector.height <= 41, 'Semester selector remains a readable touch control');
  assert.ok(dimensions.selector.top >= dimensions.header.top && dimensions.selector.bottom <= dimensions.header.bottom, 'Semester selector stays inside the existing header');
  assert.ok(dimensions.selector.x >= 0 && dimensions.selector.right <= width, 'Semester selector fits inside the phone viewport');
}

try {
  await json(admin, '/login', { method: 'POST', data: { username: 'admin', password: 'Admin2026!' } });
  let primary;
  const facultyContexts = new Map();
  for (const [faculty, names] of Object.entries(groups)) {
    const context = await provision(faculty, faculty);
    facultyContexts.set(faculty, context);
    const result = await studySetup(context, faculty === 'fsa' ? names[1] : names[0], faculty === 'fsa' ? 5 : 1);
    const catalog = await json(context, '/studies');
    assert.deepEqual(catalog.filieres.map(item => item.name), names);
    if (faculty === 'fsa') primary = { context, ...result };
    else await result.page.close();
  }
  page = primary.page;
  report('all four exact filière groups use the previously assigned faculty without a second faculty selector');

  await page.reload();
  await page.goto(`${origin}/onboarding/studies`);
  await page.waitForURL('**/app');
  assert.equal((await json(primary.context, '/session')).user.current_semester, 5);
  await page.goto(`${origin}/app/chat/general`);
  await page.locator('.chat-composer').waitFor();
  assert.equal(await page.locator('.chat-semester-tabs, .chat-group-selector').count(), 0, 'General chat has no semester selector');
  const generalBootstrap = await json(primary.context, '/bootstrap');
  const originalGeneral = generalBootstrap.messages.find(message => message.channel === 'general');
  assert.ok(originalGeneral, 'Original faculty chat history remains available');
  await page.locator(`#message-${originalGeneral.id}`).waitFor();
  const originalResource = generalBootstrap.resources.find(resource => resource.message_id && resource.channel === 'general');
  assert.ok(originalResource);
  await page.goto(origin + resourcePath(originalResource));
  await page.locator(`#resource-${originalResource.id}`).getByRole('link', { name: 'Voir la discussion', exact: true }).click();
  await page.waitForURL('**' + messagePath(originalResource));
  assert.equal(new URL(page.url()).pathname, '/app/chat/general');
  await page.locator(`#message-${originalResource.message_id}`).waitFor();
  report('faculty-wide general chat has no semester selector and keeps original history/resource IDs and links');

  const peer = await provision('fsa', 'peer');
  const peerSetup = await studySetup(peer, groups.fsa[1], 2);
  const foreign = await provision('fsa', 'foreign');
  const foreignSetup = await studySetup(foreign, groups.fsa[0], 1);
  await foreignSetup.page.goto(`${origin}/app/chat/general`);
  const publicText = 'Studies E2E faculty-wide cross-major general message 3576';
  await sendChat(foreignSetup.page, publicText);
  await page.locator('.message-text').filter({ hasText: publicText }).waitFor();
  const sharedGeneral = (await json(primary.context, '/bootstrap')).messages.find(message => message.content === publicText);
  assert.equal(sharedGeneral.channel, 'general');
  assert.equal(sharedGeneral.semester, null);
  assert.equal(sharedGeneral.filiere_id, null);
  assert.equal((await primary.context.request.get(`${origin}/api/messages/${sharedGeneral.id}`)).status(), 200);
  assert.ok((await json(primary.context, '/search?q=' + encodeURIComponent(publicText))).results.some(result => result.type === 'message' && result.id === sharedGeneral.id));
  await peerSetup.page.goto(`${origin}/app/chat/general`);
  await peerSetup.page.locator(`#message-${sharedGeneral.id}`).waitFor();
  const generalReply = 'Studies E2E current S2 student replies across majors in general 7051';
  await sendChat(peerSetup.page, generalReply);
  await page.locator('.message-text').filter({ hasText: generalReply }).waitFor();
  report('students from different Filières and semesters exchange live in their faculty general chat');

  await page.goto(`${origin}/app/chat/filiere`);
  await page.locator('.chat-semester-tabs').waitFor();
  await expect(page.locator('.chat-semester-tabs').getByRole('tab')).toHaveCount(3);
  await expect(page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S5 / S6', exact: true })).toHaveAttribute('aria-selected', 'true');
  assert.ok((await page.locator('.chat-filiere-name').textContent()).includes('Sciences de Données'));
  assert.ok(await page.locator('.navigation-columns a[href="/app/chat/filiere"]').count(), 'Private Filière chat appears in Community navigation');
  const fifth = 'Studies E2E Sciences de Données S5 independent chat 4702';
  await sendChat(page, fifth);
  const ownS5 = (await json(primary.context, '/bootstrap')).messages.find(message => message.content === fifth);
  assert.equal(ownS5.semester, 5);
  report('Community has three study-year chats and persisted S5/S6 default for current S5');

  await tab(page, 1);
  assert.equal(await page.locator(`#message-${ownS5.id}`).count(), 0);
  const first = 'Studies E2E Sciences de Données S1 independent chat 1049';
  await sendChat(page, first);
  const ownS1 = (await json(primary.context, '/bootstrap')).messages.find(message => message.content === first);
  assert.equal(ownS1.channel, 'filiere');
  assert.equal(ownS1.semester, 1);
  assert.equal(ownS1.filiere_id, primary.user.filiere_id);
  await page.goto(`${origin}/app/chat/filiere?semester=2`);
  await expect(page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S1 / S2', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.waitForURL('**/app/chat/filiere?semester=1');
  await page.locator(`#message-${ownS1.id}`).waitFor();
  await tab(page, 3);
  assert.equal(await page.locator('.message-text').filter({ hasText: first }).count(), 0, 'S1 messages are not in S3');
  const third = 'Studies E2E Sciences de Données S3 independent chat 2857';
  await sendChat(page, third);
  const ownS3 = (await json(primary.context, '/bootstrap')).messages.find(message => message.content === third);
  assert.equal(ownS3.semester, 3);
  const s1Api = await json(primary.context, '/messages?channel=filiere&semester=1');
  assert.ok(s1Api.messages.some(message => message.id === ownS1.id));
  assert.equal(s1Api.messages.some(message => message.id === ownS3.id), false);
  assert.ok(s1Api.messages.every(message => message.filiere_id === primary.user.filiere_id && message.semester === 1));
  const s2Api = await json(primary.context, '/messages?channel=filiere&semester=2');
  assert.deepEqual(s2Api.messages, s1Api.messages);
  assert.ok(s2Api.messages.every(message => message.filiere_id === primary.user.filiere_id && message.semester === 1));
  const crossSemesterReply = await primary.context.request.post(`${origin}/api/messages`, { data: { channel: 'filiere', semester: 1, content: 'A reply cannot combine semester chats.', reply_to: ownS3.id } });
  assert.equal(crossSemesterReply.status(), 400, 'Replies cannot bridge S1 and S3');
  await page.goto(`${origin}/app/chat/filiere?semester=4`);
  await expect(page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S3 / S4', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.waitForURL('**/app/chat/filiere?semester=3');
  await page.locator(`#message-${ownS3.id}`).waitFor();
  await tab(page, 3);
  await page.reload();
  await page.locator('.message-text').filter({ hasText: third }).waitFor();
  assert.equal(await page.locator('.message-text').filter({ hasText: first }).count(), 0);
  await tab(page, 5);
  await page.locator(`#message-${ownS5.id}`).waitFor();
  assert.equal(await page.locator('.message-text').filter({ hasText: first }).count(), 0);
  assert.equal(await page.locator('.message-text').filter({ hasText: third }).count(), 0);
  await page.goto(`${origin}/app/chat/filiere?semester=6`);
  await expect(page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S5 / S6', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.waitForURL('**/app/chat/filiere?semester=5');
  await page.locator(`#message-${ownS5.id}`).waitFor();
  await tab(page, 1);
  await page.locator('.message-text').filter({ hasText: first }).waitFor();
  assert.equal(await page.locator('.message-text').filter({ hasText: third }).count(), 0);
  report('each study year combines S1/S2, S3/S4 or S5/S6 across reloads and old even-semester links');

  await peerSetup.page.goto(`${origin}/app/chat/filiere`);
  await expect(peerSetup.page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S1 / S2', exact: true })).toHaveAttribute('aria-selected', 'true');
  await peerSetup.page.locator(`#message-${ownS1.id}`).waitFor();
  const peerText = 'Studies E2E current-S2 peer posts in the shared S1/S2 chat 9962';
  await sendChat(peerSetup.page, peerText);
  await page.locator('.message-text').filter({ hasText: peerText }).waitFor();
  await tab(page, 2);
  await page.locator('.message-text').filter({ hasText: peerText }).waitFor();
  assert.equal((await json(primary.context, '/bootstrap')).messages.find(message => message.content === peerText).semester, 1);
  const secondSend = await json(peer, '/messages', { method: 'POST', data: { channel: 'filiere', semester: 2, content: 'Studies E2E semester 2 API joins the S1/S2 conversation 8613' } });
  assert.equal(secondSend.message.semester, 1);
  await page.locator(`#message-${secondSend.message.id}`).waitFor();
  report('S2 defaults to the shared S1/S2 chat and a current-S5 student can visit that same-Filière conversation');

  const firstPeer = await provision('fsa', 'first_peer');
  const firstSetup = await studySetup(firstPeer, groups.fsa[1], 1);
  await firstSetup.page.goto(`${origin}/app/chat/filiere`);
  await firstSetup.page.locator(`#message-${ownS1.id}`).waitFor();
  await tab(page, 1);
  const firstReply = 'Studies E2E current-S1 peer replies to the visiting S5 student 5106';
  await sendChat(firstSetup.page, firstReply);
  await page.locator('.message-text').filter({ hasText: firstReply }).waitFor();
  report('current-S5 and current-S1 students exchange live inside the same-Filière S1 chat');

  const sixthPeer = await provision('fsa', 'sixth_peer');
  const sixthSetup = await studySetup(sixthPeer, groups.fsa[1], 6);
  await sixthSetup.page.goto(`${origin}/app/chat/filiere`);
  await expect(sixthSetup.page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S5 / S6', exact: true })).toHaveAttribute('aria-selected', 'true');
  assert.equal(await sixthSetup.page.locator(`#message-${ownS1.id}, #message-${ownS3.id}`).count(), 0);
  await sixthSetup.page.locator(`#message-${ownS5.id}`).waitFor();
  await tab(page, 6);
  const sixth = 'Studies E2E current S6 peer posts in its shared S5/S6 chat 2718';
  await sendChat(sixthSetup.page, sixth);
  await page.locator('.message-text').filter({ hasText: sixth }).waitFor();
  assert.equal((await json(primary.context, '/bootstrap')).messages.find(message => message.content === sixth).semester, 5);
  report('current S6 defaults to S5/S6 and exchanges with S5 while other study years stay separate');

  await foreignSetup.page.goto(`${origin}/app/chat/filiere`);
  const privateText = 'Studies E2E information systems private chat 3782';
  await sendChat(foreignSetup.page, privateText);
  const foreignMessage = (await json(foreign, '/bootstrap')).messages.find(message => message.content === privateText);
  assert.ok(foreignMessage);
  let primaryBootstrap = await json(primary.context, '/bootstrap');
  assert.equal(primaryBootstrap.messages.some(message => message.id === foreignMessage.id), false);
  assert.equal((await json(primary.context, '/search?q=' + encodeURIComponent(privateText))).results.some(result => result.type === 'message'), false);
  assert.equal((await primary.context.request.get(`${origin}/api/messages/${foreignMessage.id}`)).status(), 403);
  assert.equal((await primary.context.request.get(`${origin}/api/messages?channel=filiere&semester=1&filiere_id=${foreignSetup.user.filiere_id}`)).status(), 403);
  for (const [path, data] of [
    [`/messages/${foreignMessage.id}/reaction`, { reaction: 'like' }],
    ['/saved', { type: 'message', id: foreignMessage.id }],
    ['/reports', { target_type: 'message', target_id: foreignMessage.id, reason: 'other' }],
    ['/messages', { channel: 'filiere', semester: 1, content: 'Attempted foreign reply', reply_to: foreignMessage.id }],
    ['/messages', { channel: 'filiere', semester: 1, content: 'Attempted foreign major', filiere_id: foreignSetup.user.filiere_id }],
  ]) {
    const response = await primary.context.request.post(`${origin}/api${path}`, { data });
    assert.ok([403, 404].includes(response.status()), `${path} blocks access to another filière (${response.status()})`);
  }
  await page.goto(origin + messagePath(foreignMessage));
  await page.locator('.chat-semester-tabs').waitFor();
  assert.equal(await page.locator(`#message-${foreignMessage.id}`).count(), 0, 'A forged message deep link never exposes the other major');
  report('foreign-Filière private messages remain absent from bootstrap, search, direct actions, replies and deep links');

  const moderator = await provision('fsa', 'moderator', 'moderator');
  await json(moderator, '/studies', { method: 'POST', data: { filiere_id: foreignSetup.user.filiere_id, current_semester: 1 } });
  await json(moderator, `/messages/${foreignMessage.id}/pin`, { method: 'POST' });
  primaryBootstrap = await json(primary.context, '/bootstrap');
  assert.equal(primaryBootstrap.announcements.some(announcement => announcement.message_id === foreignMessage.id), false, 'Pinning never republishes foreign-major chat content');
  await json(moderator, `/messages/${sharedGeneral.id}/pin`, { method: 'POST' });
  assert.ok((await json(primary.context, '/bootstrap')).announcements.some(announcement => announcement.message_id === sharedGeneral.id), 'A general-chat pin is shared by the whole faculty');
  report('private pins retain Filière privacy while general pins remain visible to the whole faculty');

  const ownModerator = await provision('fsa', 'own_moderator', 'moderator');
  await json(ownModerator, '/studies', { method: 'POST', data: { filiere_id: primary.user.filiere_id, current_semester: 5 } });
  await json(ownModerator, `/messages/${ownS1.id}/pin`, { method: 'POST' });
  const ownAnnouncement = (await json(primary.context, '/bootstrap')).announcements.find(announcement => announcement.message_id === ownS1.id);
  assert.ok(ownAnnouncement);
  await json(primary.context, '/saved', { method: 'POST', data: { type: 'announcement', id: ownAnnouncement.id } });
  for (const route of ['/app', '/app/saved']) {
    await page.goto(origin + route);
    await page.locator(`#announcement-${ownAnnouncement.id} .study-announcement-content > a`).click();
    await page.waitForURL('**' + messagePath(ownAnnouncement));
    await expect(page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S1 / S2', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.locator(`#message-${ownS1.id}`).waitFor();
  }
  await page.goto(`${origin}/app/chat/general?semester=2#message-${ownS1.id}`);
  await page.waitForURL('**' + messagePath(ownS1));
  await page.locator(`#message-${ownS1.id}`).waitFor();
  report('home/saved announcement links and earlier general URLs recover the actual private semester and message ID');

  await tab(page, 3);
  const file = { name: 'studies-classified.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E TP : classification filière, semestre, module et type. 12852') };
  await page.locator('.chat-composer input[type=file]').setInputFiles(file);
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('combobox', { name: /faculté/i }).count(), 0);
  assert.deepEqual(await dialog.getByLabel('Filière', { exact: true }).evaluate(select => [...select.options].filter(option => option.value).map(option => option.textContent)), groups.fsa);
  await expect(dialog.getByLabel('Filière', { exact: true })).toHaveValue(primary.user.filiere_id);
  assert.equal(await dialog.getByLabel('Module', { exact: true }).getAttribute('required'), '');
  await dialog.getByLabel('Semestre', { exact: true }).selectOption('6');
  await dialog.getByLabel('Module', { exact: true }).fill('Statistiques multivariées');
  await dialog.getByLabel('Type de contenu', { exact: true }).selectOption('tp');
  await dialog.getByLabel('Titre de la ressource', { exact: true }).fill('Studies E2E TP classé');
  await dialog.locator('form >button').click();
  await dialog.waitFor({ state: 'hidden' });
  const uploaded = (await json(primary.context, '/bootstrap')).resources.find(resource => resource.title === 'Studies E2E TP classé');
  assert.ok(uploaded);
  assert.equal(uploaded.filiere_id, primary.user.filiere_id);
  assert.equal(uploaded.semester, 6);
  assert.equal(uploaded.channel, 'filiere');
  assert.equal(uploaded.chat_semester, 3);
  assert.equal(uploaded.module, 'Statistiques multivariées');
  assert.ok(uploaded.module_id, 'The selected module is persisted with its own identifier');
  const loadedModules = await json(primary.context, `/modules?filiere_id=${primary.user.filiere_id}&semester=6`);
  assert.ok(loadedModules.modules.some(module => module.id === uploaded.module_id && module.name === uploaded.module));
  assert.equal('object_key' in uploaded, false);
  assert.equal('stored_name' in uploaded, false);
  assert.equal(uploaded.resource_type, 'tp');
  const fileResponse = await primary.context.request.get(`${origin}/api/files/${uploaded.id}`);
  assert.equal(fileResponse.status(), 200);
  assert.ok((await fileResponse.text()).includes('classification filière'));
  assert.equal((await facultyContexts.get('flaa').request.get(`${origin}/api/files/${uploaded.id}`)).status(), 403);
  const anonymous = await browser.newContext();
  contexts.push(anonymous);
  assert.equal((await anonymous.request.get(`${origin}/api/files/${uploaded.id}`)).status(), 401);
  await page.locator(`#message-${uploaded.message_id}`).waitFor();
  await page.locator(`#message-${uploaded.message_id} .attachment-location`).click();
  await page.waitForURL('**' + resourcePath(uploaded));
  await page.locator(`#resource-${uploaded.id}`).getByRole('link', { name: 'Voir la discussion', exact: true }).click();
  await page.waitForURL('**' + messagePath(uploaded));
  await expect(page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S3 / S4', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.locator(`#message-${uploaded.message_id}`).waitFor();
  report('upload classification persists academic S6 while its resource links to the actual private S3 chat');

  const foreignResourceUpload = await json(foreign, '/uploads', { method: 'POST', multipart: {
    file: { name: 'foreign-studies.txt', mimeType: 'text/plain', buffer: Buffer.from('A shared faculty library document, with private major chat provenance. 16925') },
    title: 'Studies E2E shared faculty library', filiere_id: foreignSetup.user.filiere_id,
    semester: '1', module: 'Systèmes distribués', resource_type: 'document', category: 'general', channel: 'filiere', chat_semester: '1',
  } });
  const foreignResource = foreignResourceUpload.resource;
  primaryBootstrap = await json(primary.context, '/bootstrap');
  assert.ok(primaryBootstrap.resources.some(resource => resource.id === foreignResource.id), 'The existing faculty-wide library remains available');
  assert.equal(primaryBootstrap.messages.some(message => message.id === foreignResource.message_id), false, 'The resource does not expose its foreign-major chat');
  await page.goto(origin + resourcePath(foreignResource));
  await page.locator(`#resource-${foreignResource.id}`).waitFor();
  assert.equal(await page.locator(`#resource-${foreignResource.id}`).getByRole('link', { name: 'Voir la discussion', exact: true }).count(), 0, 'No chat link is offered for another major');
  report('faculty-wide resource access is preserved while foreign-major discussion access is hidden');

  await page.goto(`${origin}/app/chat/filiere?semester=3`);
  await page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S3 / S4', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForURL('**/app/chat/filiere?semester=5');
  await expect(page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S5 / S6', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await page.waitForURL('**/app/chat/filiere?semester=1');
  const firstYearTab=page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S1 / S2', exact: true });
  await expect(firstYearTab).toHaveAttribute('aria-selected', 'true');
  await expect(firstYearTab).toBeFocused();
  await page.keyboard.press('End');
  await page.waitForURL('**/app/chat/filiere?semester=5');
  await expect(page.locator('.chat-semester-tabs').getByRole('tab', { name: 'S5 / S6', exact: true })).toBeFocused();
  report('keyboard arrows, Home and End navigate all three study-year tabs');

  await page.setViewportSize({ width: 390, height: 844 });
  await selectLanguage(page, 'AR');
  await page.goto(`${origin}/app/chat/filiere?semester=5`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.chat-header .chat-group-selector')).toBeVisible();
  await expect(page.locator('.chat-header .chat-group-selector')).toHaveValue('5');
  await expect(page.locator('.chat-header .chat-group-selector option')).toHaveCount(3);
  await expect(page.locator('.chat-semester-tabs')).toBeHidden();
  assert.equal(await page.locator('.chat-group-selector').count(), 1, 'Phone selector occupies the existing header only');
  await page.locator('.chat-group-selector').selectOption('1');
  await page.waitForURL('**/app/chat/filiere?semester=1');
  await page.locator(`#message-${ownS1.id}`).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await compactPrivateHeader(page, 390);
  await selectLanguage(page, 'FR');
  await page.setViewportSize({ width: 320, height: 740 });
  await compactPrivateHeader(page, 320);
  await selectLanguage(page, 'AR');
  await compactPrivateHeader(page, 320);
  await page.setViewportSize({ width: 834, height: 1112 });
  await expect(page.locator('.chat-semester-tabs').getByRole('tab')).toHaveCount(3);
  await expect(page.locator('.chat-semester-tabs')).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.goto(`${origin}/app/chat/general`);
  assert.equal(await page.locator('.chat-semester-tabs, .chat-group-selector').count(), 0);
  assert.deepEqual(errors, [], 'No browser runtime errors');
  report('semester tabs preserve the existing phone/tablet design and Arabic RTL without horizontal overflow');
} catch (error) {
  if (page) {
    console.error('FAILED FILIERE PAGE', page.url(), await page.locator('body').innerText());
    await page.screenshot({ path: '/tmp/campuslink-filiere-test-failure.png', fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
