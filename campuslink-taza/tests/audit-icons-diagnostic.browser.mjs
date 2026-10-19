import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';

// Route every API call locally: these touch regressions never write to a database.
const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const installed = '/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ ...(existsSync(installed) ? { executablePath: installed } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
mkdirSync('test-results', { recursive: true });

async function fixture(viewport, theme, mobile = true) {
  const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, reducedMotion: 'reduce' });
  const errors = [], writes = [];
  await context.addInitScript(theme => {
    window.EventSource = undefined;
    // These regressions exercise returning visitors; installation has its own suite.
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    window.__copies = [];
    window.__touchTrace = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__copies.push(text) } });
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) {
      document.addEventListener(type, event => window.__touchTrace.push({ type, pointerId: event.pointerId, pointerType: event.pointerType, detail: event.detail, action: event.target.closest?.('[role^="menuitem"]')?.textContent || '' }), true);
    }
  }, theme);
  const user = { id: 2, username: 'student-fixture', name: 'Fixture Student', role: 'student', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 1, account_status: 'approved', language: 'fr' };
  const author = { id: 3, name: 'Other Student', username: 'other' };
  const messages = [
    { id: 101, content: 'Un message court.', author, created_at: '2026-10-10T09:00:00Z' },
    { id: 102, content: 'Une autre ligne.', author, created_at: '2026-10-10T09:01:00Z' },
    { id: 103, content: 'Ma réponse, facile à lire.', author: user, reply_to: 101, created_at: '2026-10-10T09:02:00Z' },
  ].map(message => ({ ...message, channel: 'general', faculty_id: 'flaa', filiere_id: 'french_studies', reactions: {} }));
  await context.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'flaa', code: 'FLAA', name: 'Fixture faculty' }, resources: [], announcements: [], messages, notifications: [], events: [], saved: [], history: [], channels: [{ id: 'general', read_only: false }], members: [] } });
    if (path === '/api/messages/read') return route.fulfill({ json: { discussion_unread_count: 0 } });
    writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseURL}/app/community?channel=general`);
  await page.locator('[data-message-id="101"]').waitFor({ timeout: 30000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  return { context, page, errors, writes };
}


try {
 for (const width of [1440,1024,390]) {
  const {context,page,errors}=await fixture({width,height:900},'dark',width<700);
  const icons=await page.locator('.sidebar .nav-icon-wrap').evaluateAll(nodes=>nodes.map(n=>({label:n.closest('a').getAttribute('aria-label')||n.closest('a').textContent,display:getComputedStyle(n).display,width:n.getBoundingClientRect().width})));
  console.log(JSON.stringify({width,icons,errors}));
  await page.screenshot({path:`test-results/audit-next/icons-before-${width}.png`});
  await context.close();
 }
} finally {await browser.close();}
