import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { browserOptions } from './browser-utils.mjs';
import { getFilieres } from '../shared/studies.js';

// Every account, upload and event-stream API is intercepted below. This suite
// runs independently of the database and never creates a real academic file.
const origin = process.env.CAMPUS_BROWSER_ORIGIN || 'http://localhost:5173';
const browser = await chromium.launch(browserOptions());
const contexts = [];
const fixtures = [];
const errors = [];
const unknownApis = [];
const scratch = await mkdtemp(join(tmpdir(), 'campuslink-folder-browser-'));
const folder = join(scratch, 'Ressources');
const pdf = name => Buffer.from(`%PDF-1.4\n% Folder fixture ${name}\n%%EOF`);
const folderFiles = [
  ['Cours/Analyse.pdf', pdf('analyse')],
  ['S1/TD.pdf', pdf('first td')],
  ['S2/TD.pdf', pdf('duplicate td')],
  ['Nested/ملفات/مقدمة.pdf', pdf('arabic introduction')],
  ['Unsupported/executer.exe', Buffer.from('not an academic resource')],
  ['empty.pdf', Buffer.alloc(0)],
  ['big.pdf', Buffer.alloc(20 * 1024 * 1024 + 1)],
];
for (const [path, body] of folderFiles) {
  await mkdir(dirname(join(folder, path)), { recursive: true });
  await writeFile(join(folder, path), body);
}
const filePath = path => `Ressources/${path}`;
const row = (page, path) => page.locator('.upload-batch-row').filter({ has: page.locator('.upload-file-path').filter({ hasText: path }) });
const report = message => console.log(`PASS ${message}`);

function fixtureData(language = 'fr') {
  const user = { id: 92001, username: 'folder-fixture', name: 'Étudiant test', language, role: 'student', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 6, account_status: 'approved', preferences: {} };
  const faculty = { id: 'fsa', code: 'FSA', name: 'Faculté des Sciences Appliquées', arabic: 'كلية العلوم التطبيقية', color: '#24764c', members: 1, online: 1, chat_online: 1 };
  const message = { id: 10, content: 'Message initial pour répondre.', channel: 'filiere', semester: 5, filiere_id: 'data_science', faculty_id: 'fsa', author: user, created_at: new Date().toISOString(), pinned: false, reply_to: null, reactions: {}, my_reactions: [] };
  const resource = { id: 11, title: 'Document déjà partagé', filename: 'TD.pdf', relative_path: filePath('S2/TD.pdf'), category: 'exercises', resource_type: 'exercises', semester: 4, module: 'Analyse des données', filiere_id: 'physics', faculty_id: 'fsa', mime: 'application/pdf', size: 100, created_at: new Date().toISOString(), author: user, views: 0, downloads: 0, message_id: 12, channel: 'general' };
  return { user, faculty, faculties: [faculty], filieres: getFilieres('fsa'), modules: [], channels: [{ id: 'general', name: 'Chat général', read_only: false }], members: [user], messages: [message], resources: [resource], notifications: [], events: [], announcements: [], saved: [], history: [] };
}

async function mockApp({ width = 1440, height = 960, language = 'fr', theme = 'dark', mobile = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
  contexts.push(context);
  const data = fixtureData(language);
  const posts = [];
  const modules = [];
  let nextId = 100;
  let active = 0;
  let maxActive = 0;
  let bootstraps = 0;
  await context.addInitScript(({ language, theme }) => {
    localStorage.setItem('campus-language', language);
    localStorage.setItem('campus-theme', theme);
    localStorage.setItem('campus-navigation-expanded', 'false');
    localStorage.setItem('campus-faculty-panel-expanded', 'false');
    window.EventSource = class extends EventTarget {
      constructor() { super(); this.readyState = 1; }
      close() { this.readyState = 2; }
    };
  }, { language, theme });
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/session') return route.fulfill({ json: { user: data.user } });
    if (url.pathname === '/api/bootstrap') { bootstraps++; return route.fulfill({ json: data }); }
    if (url.pathname === '/api/events/stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (url.pathname === '/api/modules') { modules.push(Object.fromEntries(url.searchParams)); return route.fulfill({ json: { modules: [{ name: 'Analyse des données' }] } }); }
    if (url.pathname === '/api/profile') return route.fulfill({ json: { user: data.user } });
    if (url.pathname === '/api/uploads' && request.method() === 'POST') {
      const form = await new Request(url, { method: 'POST', headers: { 'content-type': request.headers()['content-type'] }, body: request.postDataBuffer() }).formData();
      let resolve;
      const pending = new Promise(done => { resolve = done; });
      active++; maxActive = Math.max(maxActive, active);
      const entry = {
        fields: Object.fromEntries([...form].filter(([key]) => key !== 'file')),
        file: form.get('file'), completed: false,
        finish(status = 201) {
          if (this.completed) return;
          this.completed = true;
          active--;
          if (status === 409) return resolve({ status, json: { error: 'Un fichier identique existe déjà dans les ressources de votre faculté.', resource: data.resources[0] } });
          if (status >= 400) return resolve({ status, json: { error: 'Échec temporaire injecté par le test.' } });
          const id = nextId++, f = this.fields;
          const message = { id: nextId++, channel: f.channel, semester: f.channel === 'filiere' ? Number(f.chat_semester) : null, filiere_id: f.channel === 'filiere' ? data.user.filiere_id : null, faculty_id: data.user.faculty_id, content: f.content, reply_to: f.reply_to ? Number(f.reply_to) : null, author: data.user, created_at: new Date().toISOString(), pinned: false, reactions: {}, my_reactions: [], resource_id: id };
          const resource = { id, ...f, semester: Number(f.semester), chat_semester: message.semester, filename: this.file.name, relative_path: f.relative_path || '', author: data.user, faculty_id: data.user.faculty_id, mime: this.file.type || 'application/pdf', size: this.file.size, created_at: message.created_at, views: 0, downloads: 0, message_id: message.id };
          data.resources.push(resource); data.messages.push(message);
          return resolve({ status, json: { resource, message } });
        },
      };
      posts.push(entry);
      return route.fulfill(await pending);
    }
    unknownApis.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 501, json: { error: 'Unexpected API in folder fixture.' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const fixture = { context, page, data, posts, modules, get maxActive() { return maxActive; }, get bootstraps() { return bootstraps; } };
  fixtures.push(fixture);
  return fixture;
}

async function openUpload(fixture) {
  await fixture.page.goto(origin + '/app/resources');
  await fixture.page.locator('.study-library').waitFor();
  await fixture.page.locator('.study-library .page-heading button').click();
  await fixture.page.locator('.modal-upload').waitFor();
}

async function classify(page) {
  const fields = page.locator('.upload-study-form');
  await fields.getByLabel('Filière', { exact: true }).selectOption('physics');
  await fields.getByLabel('Semestre', { exact: true }).selectOption('4');
  await fields.getByLabel('Module', { exact: true }).fill('Analyse des données');
  await fields.getByLabel('Type de contenu', { exact: true }).selectOption('exercises');
}

async function nextPost(fixture, index) {
  await expect.poll(() => fixture.posts.length).toBeGreaterThan(index);
  return fixture.posts[index];
}

async function assertNoOverflow(page) {
  await page.locator('.modal-upload').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
  const geometry = await page.locator('.modal-upload').evaluate(modal => ({ viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, modalWidth: modal.clientWidth, scrollWidth: modal.scrollWidth }));
  assert.ok(geometry.pageWidth <= geometry.viewport, 'Upload dialog fits the viewport.');
  assert.ok(geometry.scrollWidth <= geometry.modalWidth + 1, 'Nested paths do not overflow the dialog.');
  const controls = await page.locator('.modal-upload button:not([disabled])').evaluateAll(buttons => buttons.filter(button => button.getClientRects().length).map(button => ({ label: button.textContent || button.getAttribute('aria-label'), width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
  for (const button of controls) assert.ok(button.width >= 40 && button.height >= 40, `${button.label} is a usable touch target (${button.width}×${button.height}px).`);
}

async function readableText(locator, label) {
  const measurements = await locator.evaluate(element => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const parseColor = color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const composite = (foreground, background) => {
      const alpha = foreground[3] / 255;
      return foreground.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
    };
    const ancestors = [];
    for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
    let background = [255, 255, 255];
    for (const node of ancestors) background = composite(parseColor(getComputedStyle(node).backgroundColor), background);
    const style = getComputedStyle(element);
    const foreground = composite(parseColor(style.color), background);
    const luminance = rgb => rgb.map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const light = Math.max(luminance(foreground), luminance(background)), dark = Math.min(luminance(foreground), luminance(background));
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { font: parseFloat(style.fontSize), color: style.color, background, contrast: (light + 0.05) / (dark + 0.05), top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, controlHeight: rect.height, width: innerWidth, height: innerHeight, reachable: element.contains(hit) };
  });
  assert.ok(measurements.font >= 14, `${label} uses readable type (${measurements.font}px).`);
  assert.ok(measurements.contrast >= 4.5, `${label} has readable text contrast (${measurements.contrast.toFixed(2)}:1, ${measurements.color} on ${measurements.background}).`);
  assert.ok(measurements.top >= 0 && measurements.bottom <= measurements.height && measurements.left >= 0 && measurements.right <= measurements.width, `${label} is fully inside the viewport after scrolling.`);
  assert.ok(measurements.reachable, `${label} is not clipped by the nested list or covered by another element.`);
  return measurements;
}

try {
  const batch = await mockApp();
  await openUpload(batch);
  const directory = batch.page.getByTestId('upload-folder-input');
  await expect(directory).toHaveAttribute('webkitdirectory', '');
  await expect(directory).toHaveAttribute('multiple', '');
  await expect(batch.page.getByTestId('upload-files-input')).toHaveAttribute('multiple', '');
  assert.equal(await batch.page.locator('.modal-upload select option[value="management"]').count(), 0, 'Only the account faculty majors are offered.');
  assert.equal(await batch.page.locator('.modal-upload select[aria-label="Faculté"]').count(), 0, 'Faculty is never selected again.');
  await directory.setInputFiles(folder);
  await expect(batch.page.locator('.upload-batch-row')).toHaveCount(folderFiles.length);
  await expect(batch.page.locator('.upload-classification-grid').getByLabel('Titre de la ressource', { exact: true })).toHaveCount(0);
  for (const [path] of folderFiles) await expect(row(batch.page, filePath(path))).toHaveAttribute('data-upload-path', filePath(path));
  for (const path of ['Unsupported/executer.exe', 'empty.pdf', 'big.pdf']) await expect(row(batch.page, filePath(path))).toHaveAttribute('data-status', 'skipped');
  await expect(row(batch.page, filePath('S1/TD.pdf')).locator('input[data-upload-title]')).toHaveValue('TD');
  await expect(row(batch.page, filePath('S2/TD.pdf')).locator('input[data-upload-title]')).toHaveValue('TD');
  await row(batch.page, filePath('Cours/Analyse.pdf')).locator('input[data-upload-title]').fill('Analyse : notes complètes');
  await row(batch.page, filePath('Nested/ملفات/مقدمة.pdf')).locator('input[data-upload-title]').fill('مقدمة في تحليل البيانات');
  await classify(batch.page);
  report('native nested folder picker preserves repeated basenames and Unicode paths; invalid files stay flagged');

  await batch.page.getByRole('button', { name: 'Partager les fichiers', exact: true }).click();
  await nextPost(batch, 1);
  await batch.page.waitForTimeout(250);
  assert.equal(batch.posts.length, 2, 'Only two uploads begin while responses are held.');
  await expect(batch.page.locator('.upload-batch-progress')).toBeVisible();
  await expect(batch.page.locator('.upload-study-form select').first()).toBeDisabled();
  await expect(directory).toBeDisabled();
  await batch.page.keyboard.press('Escape');
  await expect(batch.page.locator('.modal-upload')).toBeVisible();
  const outcome = entry => entry.fields.relative_path === filePath('S2/TD.pdf') ? 409 : entry.fields.relative_path === filePath('Nested/ملفات/مقدمة.pdf') ? 503 : 201;
  for (let index = 0; index < 4; index++) {
    const post = await nextPost(batch, index);
    assert.equal(post.file.name, basename(post.fields.relative_path), 'Each request contains one basename file.');
    assert.equal(post.fields.filiere_id, 'physics');
    assert.equal(post.fields.semester, '4');
    assert.equal(post.fields.module, 'Analyse des données');
    assert.equal(post.fields.category, 'exercises');
    assert.equal(post.fields.resource_type, 'exercises');
    assert.equal(post.fields.channel, 'general');
    assert.ok(!Object.hasOwn(post.fields, 'faculty_id'), 'Faculty stays implicit on the server.');
    if (post.fields.relative_path === filePath('Cours/Analyse.pdf')) assert.equal(post.fields.title, 'Analyse : notes complètes');
    if (post.fields.relative_path === filePath('Nested/ملفات/مقدمة.pdf')) assert.equal(post.fields.title, 'مقدمة في تحليل البيانات');
    post.finish(outcome(post));
    if (index === 0) {
      await expect(batch.page.locator('.upload-batch-row[data-status=uploaded]')).toHaveCount(1);
      await expect(batch.page.locator('.upload-result-link'), 'Completed rows cannot close a still-uploading folder.').toHaveCount(0);
    }
  }
  await expect(row(batch.page, filePath('Cours/Analyse.pdf'))).toHaveAttribute('data-status', 'uploaded');
  await expect(row(batch.page, filePath('S1/TD.pdf'))).toHaveAttribute('data-status', 'uploaded');
  await expect(row(batch.page, filePath('S2/TD.pdf'))).toHaveAttribute('data-status', 'duplicate');
  await expect(row(batch.page, filePath('Nested/ملفات/مقدمة.pdf'))).toHaveAttribute('data-status', 'error');
  await expect(row(batch.page, filePath('S2/TD.pdf')).getByRole('link')).toHaveAttribute('href', /#resource-11$/);
  await expect(batch.page.locator('.upload-batch-summary')).toBeVisible();
  await expect(batch.page.locator('.upload-batch-progress')).toHaveAttribute('value', '4');
  await expect(batch.page.locator('.upload-batch-progress')).toHaveAttribute('max', '4');
  assert.equal(batch.maxActive, 2, 'Folder uploads remain bounded to two workers.');
  assert.equal(batch.posts.length, 4, 'Skipped rows are never sent.');
  report('one shared classification is sent per file with bounded workers and partial success/duplicate/failure feedback');

  await row(batch.page, filePath('Nested/ملفات/مقدمة.pdf')).locator('input[data-upload-title]').fill('مقدمة مصححة');
  await batch.page.getByRole('button', { name: 'Réessayer les fichiers en échec', exact: true }).click();
  const retry = await nextPost(batch, 4);
  assert.equal(retry.fields.relative_path, filePath('Nested/ملفات/مقدمة.pdf'));
  assert.equal(retry.fields.title, 'مقدمة مصححة');
  await batch.page.waitForTimeout(150);
  assert.equal(batch.posts.length, 5, 'Successful and duplicate rows are not sent again.');
  retry.finish();
  await expect(row(batch.page, filePath('Nested/ملفات/مقدمة.pdf'))).toHaveAttribute('data-status', 'uploaded');
  await expect(batch.page.getByRole('button', { name: 'Réessayer les fichiers en échec', exact: true })).toHaveCount(0);
  await batch.page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(batch.page.locator('.modal-upload')).toHaveCount(0);
  assert.equal(new URL(batch.page.url()).pathname, '/app/resources', 'Batch completion stays in the library.');
  for (const path of [filePath('Cours/Analyse.pdf'), filePath('Nested/ملفات/مقدمة.pdf')]) {
    const resource = batch.data.resources.find(resource => resource.relative_path === path);
    assert.ok(resource, 'Successful resources retain their relative folder path after refresh.');
    await expect(batch.page.locator(`#resource-${resource.id} .resource-folder-path`)).toHaveText(path);
  }
  await batch.context.close();
  report('retry targets only failed files; closing the summary shows retained nested paths on library cards');

  const ordinary = await mockApp();
  await openUpload(ordinary);
  await ordinary.page.getByTestId('upload-files-input').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: pdf('single file') });
  await classify(ordinary.page);
  await ordinary.page.getByLabel('Titre de la ressource', { exact: true }).fill('Notes seules');
  await ordinary.page.getByRole('button', { name: 'Partager la ressource', exact: true }).click();
  const single = await nextPost(ordinary, 0);
  assert.equal(single.file.name, 'notes.pdf');
  assert.equal(single.fields.relative_path || '', '', 'Ordinary single files have no folder path.');
  assert.equal(single.fields.title, 'Notes seules');
  single.finish();
  await expect(ordinary.page.locator('.modal-upload')).toHaveCount(0);
  await expect(ordinary.page).toHaveURL(/\/app\/resources\/exercises\/s4\/analyse-des-donnees#resource-100$/);
  await ordinary.context.close();
  report('ordinary single-file upload preserves its title and existing completion navigation');

  const oneFolder = join(scratch, 'Seul');
  await mkdir(join(oneFolder, 'Semestre'), { recursive: true });
  await writeFile(join(oneFolder, 'Semestre', 'course.pdf'), pdf('single folder document'));
  const only = await mockApp();
  await openUpload(only);
  await only.page.getByTestId('upload-folder-input').setInputFiles(oneFolder);
  await expect(only.page.locator('.upload-batch-row')).toHaveCount(1);
  await classify(only.page);
  await only.page.getByRole('button', { name: 'Partager les fichiers', exact: true }).click();
  const onlyPost = await nextPost(only, 0);
  assert.equal(onlyPost.fields.relative_path, 'Seul/Semestre/course.pdf');
  onlyPost.finish();
  await expect(only.page.locator('.upload-batch-row')).toHaveAttribute('data-status', 'uploaded');
  await expect(only.page.locator('.modal-upload')).toBeVisible();
  await only.page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await only.context.close();
  report('a folder containing one document retains its path and folder completion summary');

  const major = await mockApp({ width: 390, height: 844, mobile: true });
  await major.page.goto(origin + '/app/chat/filiere');
  await major.page.locator('.chat-composer textarea').fill('Pièces jointes pour notre filière.');
  await major.page.locator('#message-10 .message-reply-action').click();
  await major.page.locator('.chat-composer input[type=file]').setInputFiles({ name: 'starter.pdf', mimeType: 'application/pdf', buffer: pdf('starter attachment') });
  await major.page.locator('.modal-upload').waitFor();
  await major.page.getByTestId('upload-folder-input').setInputFiles(folder);
  const form = major.page.locator('.upload-study-form');
  await form.getByLabel('Module', { exact: true }).fill('Analyse des données');
  await form.getByLabel('Type de contenu', { exact: true }).selectOption('courses');
  await major.page.getByRole('button', { name: 'Partager les fichiers', exact: true }).click();
  for (let index = 0; index < 4; index++) {
    const post = await nextPost(major, index);
    assert.equal(post.fields.channel, 'filiere');
    assert.equal(post.fields.chat_semester, '5', 'The account S6 major chat keeps its S5/S6 year group.');
    assert.equal(post.fields.reply_to, '10');
    assert.equal(post.fields.content, 'Pièces jointes pour notre filière.');
    post.finish();
  }
  await expect(major.page.locator('.upload-batch-row[data-status=uploaded]')).toHaveCount(4);
  await major.page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(major.page.locator('.chat-composer textarea')).toHaveValue('');
  await expect(major.page.locator('.composer-reply')).toHaveCount(0);
  await major.context.close();
  report('folder attached in a major chat preserves paired semester, draft and reply scope');

  let layouts = 0;
  for (const width of [320, 390, 768, 1440]) for (const language of ['fr', 'ar']) for (const theme of ['light', 'dark']) {
    const layout = await mockApp({ width, height: width < 768 ? 700 : 960, language, theme, mobile: width <= 768 });
    await openUpload(layout);
    await layout.page.getByTestId('upload-folder-input').setInputFiles(folder);
    await expect(layout.page.locator('.upload-batch-row')).toHaveCount(folderFiles.length);
    await assertNoOverflow(layout.page);
    await expect(layout.page.getByTestId('upload-files-input')).toBeEnabled();
    await expect(layout.page.getByTestId('upload-folder-input')).toBeEnabled();
    if (width === 390) await layout.page.screenshot({ path: `/tmp/campuslink-folder-${width}-${theme}-${language}.png` });
    const firstNested = row(layout.page, filePath('Cours/Analyse.pdf'));
    await firstNested.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await layout.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pathText = await readableText(firstNested.locator('.upload-file-path'), `${width}/${language}/${theme} nested path`);
    const titleText = await readableText(firstNested.locator('input[data-upload-title]'), `${width}/${language}/${theme} file title`);
    assert.ok(titleText.controlHeight >= 44, 'Per-file titles retain a reachable 44px input.');
    if (width <= 768) assert.ok(titleText.font >= 16, 'Phone/tablet title inputs use 16px text to avoid iOS focus zoom.');
    await expect(firstNested.locator('input[data-upload-title]')).toHaveValue('Analyse');
    if (width === 390) {
      console.log(`READABILITY ${language}/${theme}: path ${pathText.font}px ${pathText.contrast.toFixed(2)}:1; title ${titleText.font}px ${titleText.contrast.toFixed(2)}:1`);
      await layout.page.screenshot({ path: `/tmp/campuslink-folder-queue-${width}-${theme}-${language}.png` });
    }
    await layout.context.close(); layouts++;
  }
  report(`${layouts} phone/tablet/desktop, RTL/LTR and light/dark layouts retain visible nested paths/titles with readable contrast and selection controls`);

  const fallback = await mockApp({ width: 360, height: 700, mobile: true });
  await openUpload(fallback);
  await fallback.page.getByTestId('upload-files-input').setInputFiles([
    { name: 'first.pdf', mimeType: 'application/pdf', buffer: pdf('first fallback') },
    { name: 'second.pdf', mimeType: 'application/pdf', buffer: pdf('second fallback') },
  ]);
  await expect(fallback.page.locator('.upload-batch-row')).toHaveCount(2);
  await classify(fallback.page);
  await fallback.page.getByRole('button', { name: 'Partager les fichiers', exact: true }).click();
  for (let index = 0; index < 2; index++) {
    const post = await nextPost(fallback, index);
    assert.equal(post.fields.relative_path || '', '', 'Ordinary multiple-file fallback does not invent a folder path.');
    post.finish();
  }
  await expect(fallback.page.locator('.upload-batch-row[data-status=uploaded]')).toHaveCount(2);
  await fallback.context.close();
  report('ordinary multiple-file selection offers a phone fallback when the OS folder picker is unavailable');
  assert.deepEqual(unknownApis, [], 'No request escaped the explicit fixture routes.');
  assert.deepEqual(errors, [], 'No browser runtime error interrupted uploads.');
} catch (error) {
  const open = contexts.flatMap(context => context.pages()).find(page => !page.isClosed());
  if (open) {
    console.log('FAILED PAGE', open.url(), await open.locator('body').innerText());
    await open.screenshot({ path: '/tmp/campuslink-folder-test-failure.png' }).catch(() => {});
  }
  console.log('RUNTIME ERRORS', errors);
  throw error;
} finally {
  for (const fixture of fixtures) for (const post of fixture.posts) post.finish(503);
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
