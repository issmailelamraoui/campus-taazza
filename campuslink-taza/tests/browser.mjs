import { chromium, expect } from '@playwright/test';
import { chooseOption } from './ui.helpers.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = join(process.cwd(), 'test-results');
await mkdir(output, { recursive: true });
const fixtures = await mkdtemp(join(tmpdir(), 'campuslink-browser-'));
const installedChromium = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const chromiumPath = process.env.CAMPUSLINK_CHROMIUM || (existsSync(installedChromium) ? installedChromium : undefined);
const browser = await chromium.launch({
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const problems = [];
const completed = [];
let activePage;

function observe(page) {
  page.on('pageerror', error => problems.push(`Page error: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`Console error: ${message.text()}`); });
  page.on('request', request => {
    if (/\/api\//.test(request.url()) || /neon\.tech|cloudflare.*r2|r2\.dev/.test(request.url())) problems.push(`Unexpected backend request: ${request.url()}`);
  });
  page.setDefaultTimeout(10000);
}

async function phase(name, action) {
  await action();
  completed.push(name);
  console.log(`PASS ${name}`);
}

async function screenshot(page, name) {
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true, animations: 'disabled' });
}

async function noOverflow(page, name) {
  const result = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const offenders = [...document.querySelectorAll('main *, header *')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && getComputedStyle(element).position !== 'fixed' && (rect.right > width + 2 || rect.left < -2);
    }).slice(0, 6).map(element => `${element.tagName}.${element.className}`);
    return { width, scrollWidth, offenders };
  });
  assert.ok(result.scrollWidth <= result.width + 1, `${name}: horizontal overflow ${JSON.stringify(result)}`);
}

async function navigate(page, path) {
  const bottomLink = page.locator(`.mobile-bottom-nav a[href="${path}"]`);
  if (await bottomLink.isVisible()) {
    await bottomLink.click();
    await expect(page).toHaveURL(url => url.pathname === path);
    return;
  }
  const menu = page.locator('.mobile-menu-button');
  if (await menu.isVisible()) await menu.click();
  await page.locator(`.sidebar .nav-item[href="${path}"]`).click();
  await expect(page).toHaveURL(url => url.pathname === path);
  await expect(page.locator('.sidebar')).not.toHaveClass(/\bopen\b/);
}

async function closeModal(page) {
  await page.locator('.modal-header .icon-btn').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function login(page, username) {
  await page.goto(`${baseURL}/login`);
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill('campus2026');
  await page.locator('form.login-form button[type="submit"]').click();
}

function makePDF(title) {
  const stream = `BT /F1 18 Tf 60 740 Td (${title.replace(/[()\\]/g, '')}) Tj ET`;
  const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

async function shareFiles(page, paths, title, folder = false, part = '') {
  await page.locator('.page-actions button').filter({ hasText: 'Partager un document' }).click();
  const modal = page.getByRole('dialog');
  await (folder ? modal.locator('input[webkitdirectory]') : modal.locator('input[type="file"]').first()).setInputFiles(paths);
  await expect(modal.locator('.upload-file')).toHaveCount(folder ? 2 : Array.isArray(paths) ? paths.length : 1);
  if (folder) await expect(modal.locator('.upload-file-path').filter({ hasText: 'nested' })).toBeVisible();
  await modal.getByRole('button', { name: /Classer les documents/ }).click();
  await expect(modal.getByLabel('Filière attribuée')).toBeDisabled();
  const batch = modal.locator('.upload-batch');
  await batch.getByLabel(/^Module/).fill(`Module ${title}`);
  await batch.getByLabel('Professeur / auteur', { exact: true }).fill('Équipe test');
  await batch.getByRole('button', { name: /Appliquer aux/ }).click();
  for (let index = 0; index < await modal.locator('.upload-file').count(); index++) {
    const row = modal.locator('.upload-file').nth(index);
    await row.getByRole('button', { name: /^Modifier / }).click();
    const fields = row.locator('.upload-file-editor');
    if (index === 0) await fields.getByLabel('Titre du document *', { exact: true }).fill(title);
    await fields.getByLabel('Part/Chapitre *', { exact: true }).fill(String(part || index + 1));
  }
  await modal.getByRole('button', { name: /^Vérifier/ }).click();
  await expect(modal.locator('.upload-review-list')).toContainText(title);
  await expect(modal.locator('.upload-local-notice')).toContainText('ne sont pas envoyés');
  await modal.getByRole('button', { name: 'Confirmer le partage', exact: true }).click();
  await expect(modal.getByRole('progressbar')).toHaveCount(0);
  await expect(modal.getByRole('heading', { name: 'Documents ajoutés' })).toBeVisible();
  await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

try {
  if (process.env.CAMPUSLINK_TEST_SCOPE !== 'admin') {
  const student = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', reducedMotion: 'reduce' });
  await student.tracing.start({ screenshots: true, snapshots: true });
  const page = await student.newPage();
  activePage = page;
  observe(page);
  await phase('Landing, validation, login and locked academic onboarding', async () => {
    await page.goto(baseURL);
    await expect(page.locator('.landing-benefits article')).toHaveCount(4);
    await noOverflow(page, 'Desktop landing');
    await screenshot(page, 'landing-desktop-dark-fr');
    await page.locator('.landing-primary').click();
    await page.locator('form.login-form button[type="submit"]').click();
    await expect(page.getByRole('alert')).toHaveCount(2);
    await page.locator('#login-username').fill('sara.demo');
    await page.locator('#login-password').fill('wrong');
    await page.getByRole('button', { name: 'Afficher le mot de passe', exact: true }).click();
    await expect(page.locator('#login-password')).toHaveAttribute('type', 'text');
    await page.locator('form.login-form button[type="submit"]').click();
    await expect(page.getByRole('alert')).toContainText('Identifiants incorrects');
    await page.locator('#login-password').fill('campus2026');
    await page.locator('form.login-form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.locator('.onboarding-faculty')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Continuer', exact: true })).toBeDisabled();
    await page.locator('.onboarding-faculty').filter({ has: page.locator('small', { hasText: /^FLAA$/ }) }).click();
    await page.getByRole('button', { name: 'Continuer', exact: true }).click();
    await expect(page.locator('.onboarding-filieres button')).toHaveCount(4);
    await expect(page.locator('.onboarding-filieres')).not.toContainText('Sciences de Données');
    await page.locator('.onboarding-filieres button').filter({ hasText: 'مسلك الدراسات الفرنسية' }).click();
    await chooseOption(page.getByLabel('Votre semestre actuel', { exact: true }), '1');
    await page.getByRole('button', { name: 'Continuer', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirmer mon choix', exact: true })).toBeDisabled();
    await page.locator('.onboarding-consent input').check();
    await page.getByRole('button', { name: 'Confirmer mon choix', exact: true }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.locator('.sidebar-context')).toContainText('FLAA');
    await page.reload();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.locator('.home-welcome')).toBeVisible();
    const locked = await page.evaluate(() => JSON.parse(localStorage.getItem('campuslink-prototype-v1:selections'))['sara.demo']);
    assert.deepEqual(locked, { facultyId: 'flaa', filiereId: 'french_studies', semester: 1 });
    await expect(page.locator('.sidebar .nav-item')).toHaveCount(7);
    await screenshot(page, 'home-desktop-dark-fr');
  });

  await phase('Library semesters, exact modules, categories, search, filters and sorting', async () => {
    await navigate(page, '/app/library');
    await expect(page.locator('.semester-choice')).toHaveCount(6);
    await expect(page.locator('.library-document-grid .document-card')).toHaveCount(9);
    await page.getByRole('tab', { name: /^Cours/ }).click();
    await expect(page.locator('.library-document-grid .document-card')).toHaveCount(3);
    await page.getByRole('tab', { name: /^TD \/ TP/ }).click();
    await expect(page.locator('.library-document-grid .document-card')).toHaveCount(2);
    await page.getByRole('tab', { name: /^Tous/ }).click();
    await page.locator('.module-choice').filter({ hasText: /^Linguistique$/ }).click();
    await expect(page.locator('.library-document-grid .document-card')).toHaveCount(6);
    await page.getByLabel('Rechercher des documents', { exact: true }).fill('phonétique');
    await expect(page.locator('.library-document-grid .document-card')).toHaveCount(3);
    await page.getByLabel('Rechercher des documents', { exact: true }).fill('no-matching-resource');
    await expect(page.getByRole('heading', { name: 'Aucun document ici pour le moment' })).toBeVisible();
    await page.getByRole('button', { name: 'Effacer les filtres', exact: true }).click();
    await page.getByRole('button', { name: 'Filtres', exact: true }).click();
    await chooseOption(page.locator('#library-filters').getByLabel('Auteur / enseignant'), 'Sara Benali');
    await expect(page.locator('.library-document-grid .document-card')).toHaveCount(1);
    await page.locator('#library-filters').getByRole('button', { name: 'Réinitialiser les filtres' }).click();
    await chooseOption(page.getByLabel('Trier', { exact: true }), 'part');
    await page.getByRole('button', { name: /^S3$/ }).click();
    await expect(page.locator('.library-modules')).toContainText('Poésie');
    await page.getByRole('button', { name: /^S6$/ }).click();
    await expect(page.locator('.library-modules')).toContainText('Projet de fin d’études');
    await page.getByRole('button', { name: /^S1$/ }).click();
    await noOverflow(page, 'Desktop library');
    await screenshot(page, 'library-desktop-dark-fr');
  });

  const singlePath = join(fixtures, 'single.pdf');
  const multiplePaths = [join(fixtures, 'batch-a.pdf'), join(fixtures, 'batch-b.pdf')];
  const folderPath = join(fixtures, 'academic-folder');
  await mkdir(join(folderPath, 'nested', 'week-01'), { recursive: true });
  await writeFile(singlePath, makePDF('Single PDF fixture'));
  for (const path of multiplePaths) await writeFile(path, makePDF('Multiple PDF fixture'));
  await writeFile(join(folderPath, 'root.pdf'), makePDF('Folder root fixture'));
  await writeFile(join(folderPath, 'nested', 'week-01', 'chapter.pdf'), makePDF('Nested folder fixture'));
  await writeFile(join(folderPath, 'ignored.zip'), 'Unsupported file excluded from the device workflow.');
  await phase('Single, multiple and nested-folder PDFs with metadata, review and session sharing', async () => {
    await shareFiles(page, singlePath, 'Document individuel de test');
    await shareFiles(page, multiplePaths, 'Document multiple de test');
    await shareFiles(page, folderPath, 'Document de dossier de test', true);
    await expect(page.locator('.library-document-grid .document-card')).toHaveCount(14);
    await shareFiles(page, singlePath, 'Série de test multipartie', false, 1);
    await shareFiles(page, singlePath, 'Série de test multipartie', false, 2);
    await chooseOption(page.getByLabel('Trier', { exact: true }), 'part');
    await page.getByLabel('Rechercher des documents').fill('Série de test multipartie');
    const series = page.locator('.document-card');
    await expect(series).toHaveCount(2);
    await expect(series.nth(0).locator('.part-label')).toHaveText('Part/Chapitre 1');
    await expect(series.nth(1).locator('.part-label')).toHaveText('Part/Chapitre 2');
    await page.getByLabel('Rechercher des documents').fill('');
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => /resource|upload/i.test(key)));
    assert.deepEqual(stored, [], 'PDF upload bytes and blob URLs must not be stored in localStorage');
    await page.locator('.page-actions button').filter({ hasText: 'Partager un document' }).click();
    const modal = page.getByRole('dialog');
    await modal.locator('input[type="file"]').first().setInputFiles(singlePath);
    await modal.getByRole('button', { name: /^Retirer / }).click();
    await expect(modal.getByRole('button', { name: /Classer les documents/ })).toBeDisabled();
    await modal.locator('.upload-dropzone').evaluate(element => {
      const file = name => ({ name, isFile: true, file: success => success(new File(['%PDF-1.4\n%%EOF'], name, { type: 'application/pdf' })) });
      const folder = (name, batches) => ({ name, isDirectory: true, createReader: () => { let index = 0; return { readEntries: success => success(batches[index++] || []) }; } });
      const nested = folder('nested-drag', [[file('nested.pdf')], []]);
      const root = folder('drag-folder', [Array.from({ length: 100 }, (_, index) => file(`part-${index}.pdf`)), [nested, file('last.pdf')], []]);
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { items: [{ kind: 'file', webkitGetAsEntry: () => root }], files: [] } });
      element.dispatchEvent(event);
    });
    await expect(modal.locator('.upload-file')).toHaveCount(102);
    await expect(modal.locator('.upload-file-path').filter({ hasText: 'nested-drag' })).toBeVisible();
    await modal.getByRole('button', { name: 'Annuler', exact: true }).click();
  });

  await phase('Uploaded PDF preview, fullscreen, saving and recently viewed history', async () => {
    await page.getByLabel('Rechercher des documents').fill('Document individuel de test');
    const card = page.locator('.document-card').filter({ hasText: 'Document individuel de test' });
    await expect(card).toHaveCount(1);
    await card.locator('.save-btn').click();
    await expect(card.locator('.save-btn')).toHaveAttribute('aria-pressed', 'true');
    await card.locator('.document-main').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('.pdf-area iframe')).toHaveAttribute('src', /^blob:/);
    await page.getByRole('button', { name: 'Plein écran', exact: true }).click();
    await expect(page.locator('.preview-modal')).toHaveClass(/fullscreen/);
    await screenshot(page, 'pdf-upload-preview');
    await closeModal(page);
    await navigate(page, '/app/saved');
    await expect(page.locator('.document-card')).toContainText('Document individuel de test');
    await page.getByRole('tab', { name: 'Récemment consultés', exact: true }).click();
    await expect(page.locator('.document-card')).toContainText('Document individuel de test');
  });

  await phase('Community messages, replies, mentions and other academic-year access', async () => {
    await navigate(page, '/app/community');
    await page.getByLabel('Votre message', { exact: true }).fill('Message étudiant de test');
    await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
    await expect(page.locator('.community-message').filter({ hasText: 'Message étudiant de test' })).toBeVisible();
    const ownMessage = page.locator('.community-message').filter({ has: page.locator('.community-message-content', { hasText: /^Message étudiant de test$/ }) });
    await ownMessage.focus();
    await ownMessage.press('Shift+F10');
    await page.getByRole('menuitem', { name: /^Répondre/ }).click();
    await expect(page.locator('.community-composer-reply')).toBeVisible();
    await page.getByLabel('Votre message', { exact: true }).fill('Réponse de test');
    await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
    await expect(page.locator('.community-message').filter({ hasText: 'Réponse de test' }).locator('.community-reply-reference')).toBeVisible();
    await ownMessage.focus();
    await ownMessage.press('Shift+F10');
    await page.getByRole('menuitem', { name: /^Mentionner/ }).click();
    await expect(page.getByLabel('Votre message', { exact: true })).toHaveValue(/@sara/);
    await page.getByLabel('Votre message', { exact: true }).fill('');
    await page.getByRole('button', { name: 'S5–S6', exact: true }).click();
    await expect(page).toHaveURL(/channel=year-5/);
    await page.getByLabel('Votre message', { exact: true }).fill('Participation au semestre 6');
    await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
    await expect(page.locator('.community-message').filter({ hasText: 'Participation au semestre 6' })).toBeVisible();
    await noOverflow(page, 'Desktop community');
    await screenshot(page, 'community-desktop-dark-fr');
  });

  await phase('Global keyboard search and direct document/module navigation', async () => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('.search-modal')).toBeVisible();
    await page.locator('.search-input-row input').fill('Introduction à la linguistique');
    await page.locator('.search-result').filter({ hasText: 'Introduction à la linguistique' }).first().click();
    await expect(page.locator('.preview-modal')).toBeVisible();
    await closeModal(page);
    await page.keyboard.press('Control+k');
    await page.locator('.search-input-row input').fill('unfindable-query-123');
    await expect(page.locator('.search-modal .empty-state')).toBeVisible();
    await closeModal(page);
    await page.keyboard.press('Control+k');
    await page.locator('.search-input-row input').fill('Poésie');
    await page.locator('.search-group').filter({ has: page.locator('.search-group-label', { hasText: /^Module$/ }) }).locator('.search-result').first().click();
    await expect(page).toHaveURL(/\/app\/library\?/);
    await expect(page.locator('.module-choice.selected')).toHaveText('Poésie');
    await expect(page.locator('.semester-choice.selected')).toContainText('S3');
  });

  await phase('Announcements, associated discussion links and notification read states', async () => {
    await navigate(page, '/app/announcements');
    await page.getByLabel('Rechercher Annonces', { exact: true }).fill('inscriptions');
    await expect(page.locator('.announcements-list .announcement-card')).toHaveCount(1);
    await chooseOption(page.getByLabel('Filtres', { exact: true }), 'pinned');
    await page.locator('.announcement-body').click();
    await expect(page.locator('.detail-announcement')).toContainText('démonstration');
    await closeModal(page);
    await page.getByLabel('Rechercher Annonces', { exact: true }).fill('');
    await chooseOption(page.getByLabel('Filtres', { exact: true }), 'all');
    await expect(page.locator('.announcements-list .announcement-card')).toHaveCount(3);
    await page.locator('.notification-button').click();
    await expect(page.locator('.notification-popover')).toBeVisible();
    await page.locator('.notification-popover footer a').click();
    await expect(page).toHaveURL(/\/app\/notifications$/);
    await page.getByRole('button', { name: 'Tout marquer comme lu', exact: true }).click();
    await expect(page.locator('.notification-item.unread')).toHaveCount(0);
    await expect(page.locator('.notification-button')).toHaveAttribute('aria-label', 'Notifications (0)');
  });

  await phase('Profile edits, locked attributes and local preferences', async () => {
    await navigate(page, '/app/profile');
    await expect(page.locator('.locked-field')).toHaveCount(4);
    await page.getByLabel('Nom affiché', { exact: true }).fill('Sara Test');
    await page.getByLabel('À propos').fill('Profil modifié dans la démonstration.');
    await page.getByRole('button', { name: 'Enregistrer les modifications', exact: true }).click();
    await expect(page.locator('.profile-intro h2')).toHaveText('Sara Test');
    await page.getByRole('checkbox', { name: 'Réponses et mentions', exact: true }).uncheck();
    await page.reload();
    await expect(page.locator('.profile-intro h2')).toHaveText('Sara Test');
    await expect(page.getByRole('checkbox', { name: 'Réponses et mentions', exact: true })).not.toBeChecked();
    await page.locator('.app-header button[aria-label="Changer de thème"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  await phase('French, English and Arabic RTL in desktop and intentional mobile navigation', async () => {
    await navigate(page, '/app/library');
    await chooseOption(page.locator('.language-select'), 'en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
    await noOverflow(page, 'Desktop English light library');
    await screenshot(page, 'library-desktop-light-en');
    await chooseOption(page.locator('.language-select'), 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'المكتبة', exact: true })).toBeVisible();
    await noOverflow(page, 'Desktop Arabic light library');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow(page, `Arabic library ${width}px`);
      await screenshot(page, `library-mobile-${width}-light-ar`);
      if (width === 320) {
        await page.locator('.page-actions button').click();
        const modal = page.getByRole('dialog');
        await modal.locator('input[type="file"]').first().setInputFiles(singlePath);
        await modal.locator('.upload-footer .btn-primary').click();
        await modal.locator('.upload-file .upload-icon-button').first().click();
        await noOverflow(page, 'Arabic upload editor 320px');
        const modalWidth = await modal.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
        assert.ok(modalWidth.scrollWidth <= modalWidth.width, 'Mobile upload modal must fit its width');
        await screenshot(page, 'upload-mobile-320-light-ar');
        await closeModal(page);
      }
      await navigate(page, '/app/community');
      await noOverflow(page, `Arabic community ${width}px`);
      await screenshot(page, `community-mobile-${width}-light-ar`);
      await navigate(page, '/app/profile');
      await noOverflow(page, `Arabic profile ${width}px`);
      await navigate(page, '/app/library');
    }
    await chooseOption(page.locator('.language-select'), 'fr');
    await navigate(page, '/app');
    await noOverflow(page, 'French 320px home');
    await screenshot(page, 'home-mobile-320-light-fr');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate(page, '/app/profile');
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
    await expect(page.locator('.login-page, .landing-page')).toBeVisible();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('campuslink-prototype-v1:session'))), null);
    if (new URL(page.url()).pathname === '/login') await page.locator('.public-back-link').click();
    await expect(page).toHaveURL(`${baseURL}/`);
    await page.setViewportSize({ width: 320, height: 844 });
    await noOverflow(page, 'French landing 320px');
    await screenshot(page, 'landing-mobile-320-light-fr');
  });
  await student.tracing.stop({ path: join(output, 'student-trace.zip') });
  await student.close();
  }

  // The administrator has its own storage context; student assignment and
  // account edits are never reused as hidden setup shortcuts for this flow.
  const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', reducedMotion: 'reduce' });
  const adminPage = await admin.newPage();
  activePage = adminPage;
  observe(adminPage);
  await phase('Administrator demo and all eight administrative sections', async () => {
    await login(adminPage, 'admin.demo');
    await expect(adminPage).toHaveURL(/\/app\/admin$/);
    await expect(adminPage.locator('.sidebar .nav-item')).toHaveCount(8);
    const tabs = adminPage.locator('.admin-page > .tabs button');
    await expect(tabs).toHaveCount(8);
    for (let index = 0; index < 8; index += 1) {
      await tabs.nth(index).click();
      await noOverflow(adminPage, `Admin section ${index + 1}`);
    }
    await tabs.first().click();
    await screenshot(adminPage, 'admin-desktop-dark-fr');
  });
  await phase('Local account creation, editing and disabling with explicit confirmations', async () => {
    await adminPage.getByRole('tab', { name: 'Comptes', exact: true }).click();
    await adminPage.getByRole('button', { name: 'Ajouter un compte', exact: true }).click();
    const modal = adminPage.getByRole('dialog');
    await modal.getByLabel('Nom complet', { exact: true }).fill('Étudiant Test');
    await modal.getByLabel('Nom d’utilisateur', { exact: true }).fill('etudiant.test');
    await chooseOption(modal.getByLabel('Établissement'), 'feg');
    await modal.getByLabel('Filière').click();
    await expect(adminPage.getByRole('listbox').getByRole('option')).toHaveCount(2);
    await adminPage.keyboard.press('Escape');
    await chooseOption(modal.getByLabel('Filière'), 'economics');
    await modal.getByRole('button', { name: 'Enregistrer dans la démo', exact: true }).click();
    const row = adminPage.locator('.admin-accounts-table tbody tr').filter({ hasText: 'etudiant.test' });
    await expect(row).toContainText('FEG');
    await expect(row).toContainText('Filière Économie');
    await row.getByRole('button', { name: 'Modifier Étudiant Test', exact: true }).click();
    await adminPage.getByRole('dialog').getByLabel('Nom complet', { exact: true }).fill('Étudiant Test Modifié');
    await adminPage.getByRole('dialog').getByRole('button', { name: 'Enregistrer dans la démo', exact: true }).click();
    await expect(row).toContainText('Étudiant Test Modifié');
    await row.getByRole('button', { name: 'Désactiver Étudiant Test Modifié', exact: true }).click();
    await expect(adminPage.getByRole('dialog')).toContainText('uniquement dans la liste locale');
    await adminPage.getByRole('dialog').getByRole('button', { name: 'Désactiver dans la démo', exact: true }).click();
    await expect(row.locator('.admin-status')).toHaveText('Désactivé');
  });
  await phase('Administrative announcement composition, pinning and resource/discussion links', async () => {
    await adminPage.getByRole('tab', { name: 'Annonces', exact: true }).click();
    await adminPage.getByRole('button', { name: 'Rédiger une annonce', exact: true }).click();
    const modal = adminPage.getByRole('dialog');
    await modal.getByLabel('Titre', { exact: true }).fill('Annonce de test locale');
    await modal.getByLabel('Contenu', { exact: true }).fill('Cette annonce illustre une publication dans la démonstration locale.');
    await chooseOption(modal.getByLabel('Filière concernée'), 'french_studies');
    await chooseOption(modal.getByLabel('Document associé (facultatif)'), 'doc-1');
    await modal.getByLabel('Épingler cette annonce').check();
    await modal.getByRole('button', { name: 'Publier dans la démo', exact: true }).click();
    await expect(adminPage.locator('.admin-announcement-list, .admin-announcements-list')).toContainText('Annonce de test locale');
    await navigate(adminPage, '/app/announcements');
    await adminPage.locator('.announcement-card').filter({ hasText: 'Annonce de test locale' }).locator('.announcement-body').click();
    await expect(adminPage.locator('.detail-announcement')).toContainText('Annonce de test locale');
    await adminPage.getByRole('button', { name: 'Consulter le document', exact: true }).click();
    await expect(adminPage.locator('.preview-modal')).toBeVisible();
    await closeModal(adminPage);
    await adminPage.locator('.announcement-card').filter({ hasText: 'Annonce de test locale' }).locator('.announcement-body').click();
    await adminPage.getByRole('button', { name: 'Voir la discussion associée', exact: true }).click();
    await expect(adminPage).toHaveURL(/channel=important/);
    await navigate(adminPage, '/app/admin');
    await adminPage.getByRole('tab', { name: 'Assistance', exact: false }).click();
    await adminPage.locator('.admin-assistance-row').first().getByRole('button', { name: 'Traiter', exact: true }).click();
    await adminPage.getByRole('dialog').getByLabel('Note de suivi').fill('Demande vérifiée dans la démo.');
    await adminPage.getByRole('dialog').getByRole('button', { name: 'Marquer comme traitée', exact: true }).click();
    await expect(adminPage.locator('.admin-assistance-row').first().locator('.admin-status')).toHaveText('Traité');
    await adminPage.setViewportSize({ width: 320, height: 844 });
    await noOverflow(adminPage, 'Mobile admin assistance');
    await screenshot(adminPage, 'admin-mobile-320-dark-fr');
  });
  await admin.close();

  assert.deepEqual(problems, [], 'Browser console, runtime and backend isolation checks');
  await writeFile(join(output, 'browser-report.json'), JSON.stringify({ passed: completed, browserErrors: problems, baseURL }, null, 2));
  console.log(`\n${completed.length} browser scenarios passed. Screenshots and trace: ${output}`);
} catch (error) {
  if (activePage && !activePage.isClosed()) await screenshot(activePage, 'failure').catch(() => {});
  await writeFile(join(output, 'browser-report.json'), JSON.stringify({ passed: completed, browserErrors: problems, failure: String(error.stack || error), baseURL }, null, 2));
  throw error;
} finally {
  await browser.close();
  await rm(fixtures, { recursive: true, force: true });
}
