import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

// Read-only API fixtures exercise the actual UI without changing campus data.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
mkdirSync('test-results/frontend-consistency', { recursive: true });
const reports = [], errors = [], unexpected = [];
const publicOnly = process.env.CAMPUS_DESIGN_SCOPE === 'public';
const now = '2026-10-13T10:00:00Z';
const longTitle = 'Méthodes de lecture et analyse des documents universitaires — طرق تحليل المستندات';
const user = { id: 2, username: 'design-review', name: 'Sara Benali', role: 'global_admin', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', current_academic_year: '2026/2027', preferences: {} };
const student = { ...user, id: 3, role: 'student', name: 'Yassine El Amrani', username: 'yassine' };
const resources = Array.from({ length: 5 }, (_, i) => ({ id: 41 + i, title: i ? `Document ${i + 1}` : longTitle, filename: `document-${i + 1}.pdf`, faculty_id: 'flaa', filiere_id: 'french_studies', semester: 1, category: ['courses', 'exercises', 'td', 'exams', 'corrections'][i], resource_type: 'courses', part_number: String(i + 1), teacher_name: 'Équipe pédagogique', module: i < 3 ? 'Méthodologie universitaire' : 'Littérature française', created_at: now, size: 1048576, mime: 'application/pdf', library_visible: true, academic_year: '2026/2027', author: student, version: 1 }));
const announcements = [0, 1].map(i => ({ id: 51 + i, title: i ? 'Calendrier des examens' : longTitle, content: 'Retrouvez les informations utiles pour préparer vos cours et organiser vos révisions.', faculty_id: 'flaa', created_at: now, author: { name: 'Administration' }, kind: 'administration', pinned: !i }));
const messages = [0, 1, 2].map(i => ({ id: 61 + i, faculty_id: 'flaa', filiere_id: 'french_studies', semester: 1, channel: 'general', content: i ? 'Bonjour, où peut-on retrouver le cours du premier chapitre ?' : longTitle, created_at: now, author: i === 1 ? user : student, reactions: {}, attachments: [] }));
const notifications = [{ id: 71, title: longTitle, body: 'Une nouvelle ressource est disponible dans votre filière.', type: 'resources', path: '/app/library', created_at: now, read: false }, { id: 72, title: 'Votre campus', body: 'Les nouvelles annonces sont disponibles.', type: 'announcements', path: '/app/announcements', created_at: now, read: true }];
const channels = [{ id: 'general', read_only: false }, { id: 'important', read_only: true }];
const knowledge = [{ id: 'note-1', kind: 'note', title: longTitle, content: 'Une note personnelle pour préparer la prochaine séance de méthodologie.', source: { module: 'Méthodologie universitaire' }, resourceId: null, createdAt: now, updatedAt: now, revision: 1 }];
const tools = [{ id: 'card-1', kind: 'flashcard', title: longTitle, data: { front: 'Comment citer une source ?', back: 'Indiquer le document et la page exacte.', module: 'Méthodologie universitaire' }, revision: 1 }, { id: 'check-1', kind: 'checklist', title: 'Préparer les examens', data: { module: 'Méthodologie universitaire', items: [{ id: 'task-1', text: longTitle, done: false }, { id: 'task-2', text: 'Relire mes notes', done: true }] }, revision: 1 }, { id: 'collection-1', kind: 'collection', title: 'Sources de révision', data: { description: longTitle, items: [{ type: 'resource', id: 41 }, { type: 'knowledge', id: 'note-1' }] }, revision: 1 }];
const ticket = { id: 91, title: longTitle, description: 'Le document demande une clarification sur le deuxième chapitre.', category: 'improvement', status: 'reviewing', created_at: now, replies: [{ id: 1, author: student, content: longTitle, created_at: now }], attachments: [] };
const question = { id: 101, title: longTitle, body: 'Comment organiser les références et les notes pour préparer le prochain examen ?', author: student, author_id: 3, module: 'Méthodologie universitaire', answer_count: 1 };

async function fixture({ width, height, theme, language, state = 'approved' }) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const activeUser = state === 'guest' ? null : { ...user, language, ...(state === 'pending' ? { account_status: 'pending' } : {}), ...(state === 'onboarding' ? { role: 'student', has_admin_access: false, faculty_id: null, filiere_id: null } : {}), ...(state === 'password' ? { must_change_password: true } : {}) };
  await context.addInitScript(({ theme, language }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { theme, language });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && !['/api/history', '/api/messages/read', '/api/notifications/visit', '/api/notifications/leave'].includes(path)) {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 503, json: { error: 'Read-only design fixture.' } });
    }
    let data;
    if (path === '/api/session') data = { user: activeUser };
    else if (path === '/api/registration-options') data = { faculties: [{ id: 'flaa', code: 'FLAA', name: 'Faculté des Langues, des Lettres et des Arts', filieres: [{ id: 'french_studies', name: 'Études françaises' }] }] };
    else if (path === '/api/bootstrap') data = { user: activeUser, faculty: { id: 'flaa', code: 'FLAA', name: 'Faculté des Langues, des Lettres et des Arts' }, resources, messages, announcements, notifications, events: [], channels, members: [student, user], saved: [{ type: 'resource', id: 41 }, { type: 'announcement', id: 51 }, { type: 'message', id: 61 }], history: [{ resource_id: 41 }], unread_count: 1 };
    else if (path === '/api/admin') data = { users: [user, student], resources, announcements, reports: [], contacts: [{ ...ticket, name: student.name, email: 'student@example.test', subject: ticket.title, message: ticket.description }], channels };
    else if (path === '/api/admin/appointments') data = { appointments: [{ id: 1, user_id: 3, role: 'moderator', faculty_id: 'flaa', filiere_id: 'french_studies', capabilities: ['content.moderate', 'student.support'] }] };
    else if (path === '/api/admin/registrations') data = { requests: [] };
    else if (path === '/api/chat/blocks') data = { blocks: [] };
    else if (path === '/api/knowledge') data = { items: knowledge };
    else if (path === '/api/study-tools') data = { items: tools };
    else if (path === '/api/reading') data = { positions: [] };
    else if (path === '/api/feedback') data = { tickets: [ticket] };
    else if (path === '/api/feedback/91') data = { ticket };
    else if (path === '/api/labs') data = { sessions: [], languages: ['javascript', 'json', 'python', 'c', 'cpp'], policy: { version: '1' } };
    else if (path === '/api/xp') data = { xp: 125, breakdown: { reading: 60, help: 30, contribution: 25, practice: 10 }, level: { number: 2, xp: 125, threshold: 100, next_threshold: 200 }, achievements: [], ranking: [{ ...student, xp: 125, ranking_score: 120, rank: 1 }], events: [{ id: 1, category: 'reading', points: 5, status: 'valid', created_at: now }] };
    else if (/\/members\/\d+\/achievements$/.test(path)) data = { achievements: [] };
    else if (path === '/api/campus/forum') data = { questions: [question] };
    else if (path === '/api/campus/forum/101') data = { question, answers: [{ id: 1, author: user, author_id: 2, body: longTitle, score: 1 }], comments: [] };
    else if (/\/forum\/101\/attachments$/.test(path)) data = { attachments: [] };
    else if (path === '/api/campus/close-requests') data = { requests: [], rooms: [], expiredRequests: [], safety: { blocks: [] }, expiryDays: 7 };
    else if (path === '/api/campus/groups') data = { groups: [] };
    else if (path === '/api/campus/match') data = { offers: [], requests: [] };
    else if (path === '/api/campus/market') data = { listings: [] };
    else if (path === '/api/campus/reports') data = { reports: [] };
    else if (path === '/api/campus/blocks') data = { blocks: [] };
    else if (path === '/api/document-search') data = { matches: [], items: [], results: [] };
    else if (path === '/api/history' || path === '/api/messages/read') data = { ok: true };
    else { unexpected.push(`${request.method()} ${path}`); return route.fulfill({ status: 503, json: { error: 'Design fixture endpoint unavailable.' } }); }
    return route.fulfill({ json: data });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  return { context, page };
}

async function check(page, label, path) {
  // Login/register use their form heading when the story is hidden on phones.
  await page.locator('h1:visible, h2:visible').first().waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(new URL(page.url()).pathname, new URL(path, baseURL).pathname, `${label}: the intended destination must be displayed`);
  const result = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // Campus tabs intentionally scroll within their own clipped navigation rail.
    const controls = [...document.querySelectorAll('main .btn, main .custom-select, main input:not([hidden]), main textarea')].filter(node => node.getClientRects().length && !node.closest('.campus-tabs')).map(node => {
      const r = node.getBoundingClientRect();
      return { label: node.textContent?.trim().slice(0, 50) || node.getAttribute('aria-label'), left: r.left, right: r.right };
    });
    return { width, scrollWidth: document.documentElement.scrollWidth, outside: controls.filter(r => r.left < -1 || r.right > width + 1) };
  });
  reports.push({ label, ...result });
  assert.ok(result.scrollWidth <= result.width + 1, `${label}: page overflow ${JSON.stringify(result)}`);
  assert.deepEqual(result.outside, [], `${label}: controls leave the viewport`);
}

const routes = ['/app', '/app/library', '/app/library?module=M%C3%A9thodologie+universitaire', '/app/community', '/app/announcements', '/app/notifications', '/app/saved', '/app/profile', '/app/study', '/app/study?tab=flashcard', '/app/study?tab=checklist', '/app/study?tab=collection', '/app/study?tab=roadmap', '/app/study?tab=exam', '/app/scanner', '/app/campus', '/app/campus?tab=forum&question=101', '/app/campus?tab=rooms', '/app/campus?tab=groups', '/app/campus?tab=match', '/app/campus?tab=market', '/app/campus?tab=moderation', '/app/labs', '/app/feedback', '/app/feedback?ticket=91', '/app/xp', '/app/permissions', ...['overview', 'accounts', 'organization', 'resources', 'announcements', 'reports', 'community', 'assistance'].map(tab => '/app/admin?tab=' + tab)];
let activePage;
try {
  const additional=process.env.CAMPUS_DESIGN_SCOPE==='additional';
  for (const config of publicOnly ? [] : additional ? [{width:1024,height:768,theme:'dark',language:'fr'},{width:1920,height:1080,theme:'light',language:'fr'},{width:390,height:844,theme:'dark',language:'fr'}] : [{ width: 1440, height: 900, theme: 'dark', language: 'fr' }, { width: 1440, height: 900, theme: 'light', language: 'fr' }, { width: 768, height: 1024, theme: 'light', language: 'en' }, { width: 320, height: 640, theme: 'dark', language: 'fr' }, { width: 390, height: 844, theme: 'light', language: 'ar' }]) {
    if(process.env.CAMPUS_DESIGN_WIDTHS&&!process.env.CAMPUS_DESIGN_WIDTHS.split(',').includes(String(config.width)))continue;
    const { context, page } = await fixture(config); activePage = page;
    const prefix = `${config.width}-${config.theme}-${config.language}`;
    for (const route of routes) {
      await page.goto(baseURL + route);
      await check(page, `${prefix} ${route}`, route);
      if (process.env.CAMPUS_DESIGN_SCREENSHOTS === '1' && ['/app', '/app/library', '/app/profile', '/app/study', '/app/campus', '/app/feedback', '/app/permissions', '/app/admin?tab=overview', '/app/community'].includes(route)) await page.screenshot({ path: `test-results/frontend-consistency/${prefix}-${route.replace(/\W+/g, '-')}.png`, fullPage: true });
    }
    await page.goto(baseURL + '/app');
    if (config.width < 761) await page.locator('.mobile-menu-button').click();
    const navigation = page.locator('.sidebar a[href="/app/admin"]');
    await navigation.scrollIntoViewIfNeeded();
    const visible = await navigation.evaluate(node => {
      const r = node.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('a') === node;
    });
    assert.ok(visible, `${prefix}: last sidebar destination is unreachable`);
    await context.close();
    console.log(`PASS ${prefix}: ${routes.length} destinations and sidebar navigation`);
  }
  for (const config of additional ? [] : [{ width: 1440, height: 900, theme: 'dark', language: 'fr' }, { width: 320, height: 640, theme: 'light', language: 'fr' }, { width: 390, height: 844, theme: 'dark', language: 'ar' }]) {
    for (const [state, paths] of [['guest', ['/', '/login', '/register']], ['pending', ['/account-review']], ['onboarding', ['/onboarding']], ['password', ['/change-password']]]) {
      const { context, page } = await fixture({ ...config, state }); activePage = page;
      for (const path of paths) {
        await page.goto(baseURL + path);
        await check(page, `${config.width}-${config.theme}-${config.language} ${path}`, path);
        if (process.env.CAMPUS_DESIGN_SCREENSHOTS === '1') await page.screenshot({ path: `test-results/frontend-consistency/${config.width}-${config.theme}-${config.language}-${state}-${path.replace(/\W+/g, '-')}.png`, fullPage: true });
        if (state === 'onboarding') {
          await page.locator('.onboarding-faculty').first().click();
          await page.locator('.onboarding-actions .btn-primary').click();
          await page.locator('.onboarding-programme').waitFor();
          await check(page, `${config.width}-${config.theme}-${config.language} ${path} step 2`, path);
          await page.locator('.onboarding-filieres button').first().click();
          await page.locator('.onboarding-actions .btn-primary').click();
          await page.locator('.onboarding-summary').waitFor();
          await check(page, `${config.width}-${config.theme}-${config.language} ${path} step 3`, path);
          // Confirmation is reviewed without submitting or changing an account.
        }
      }
      await context.close();
    }
  }
  assert.deepEqual(errors, [], 'Browser runtime errors');
  assert.deepEqual(unexpected, [], 'Unexpected fixture requests');
  writeFileSync(`test-results/frontend-consistency/${publicOnly ? 'public-report' : additional ? 'additional-report' : 'report'}.json`, JSON.stringify({ checked: reports.length, reports }, null, 2));
  console.log(`PASS ${reports.length} responsive page checks (${publicOnly ? 'public pages' : 'all pages, both themes, French/English/Arabic'})`);
} catch (error) {
  console.error('Runtime errors:', errors, 'Unmocked requests:', [...new Set(unexpected)]);
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: 'test-results/frontend-consistency/failure.png', fullPage: true });
  throw error;
} finally { await browser.close(); }
