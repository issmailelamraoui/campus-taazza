import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect as browserExpect } from '@playwright/test';

// Keep every account/session request in this fixture. Execution uses the actual
// browser runtime; no campus credentials, database, or saved user code is used.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = 'test-results/labs-compact/chromium';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const expect = browserExpect.configure({ timeout: 15000 });
const report = { passed: [], layouts: [], errors: [] };
const words = {
  fr: { run: 'Exécuter', stop: 'Arrêter', completed: 'Terminé', stopped: 'Arrêté', fresh: 'Nouvelle session', finish: 'Terminer la session', graphs: 'Graphiques', code: 'Code' },
  en: { run: 'Run code', stop: 'Stop', completed: 'Completed', stopped: 'Stopped', fresh: 'New session', finish: 'Finish session', graphs: 'Graphs', code: 'Code' },
  ar: { run: 'تشغيل', stop: 'إيقاف', completed: 'اكتمل', stopped: 'أُوقف', fresh: 'جلسة جديدة', finish: 'إنهاء الجلسة', graphs: 'الرسوم البيانية', code: 'البرمجة' },
};
const variants = [
  { width: 320, height: 700, language: 'fr', theme: 'dark' },
  { width: 390, height: 844, language: 'ar', theme: 'light' },
  { width: 768, height: 1024, language: 'ar', theme: 'dark' },
  { width: 1440, height: 960, language: 'fr', theme: 'dark' },
  { width: 1440, height: 960, language: 'en', theme: 'light' },
];

async function fixture(settings) {
  const { width, height, language, theme } = settings;
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1100,
    serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(({ language, theme }) => {
    if (window !== window.top) return;
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { language, theme });
  const user = { id: 3, username: 'compact-labs-fixture', name: 'Compact Labs fixture', role: 'student',
    account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 3, language };
  const sessions = [{ id: 'restored-fixture', language: 'javascript', source: 'console.log("restored private code");',
    result: { status: 'valid_syntax' }, updatedAt: new Date().toISOString(), completedAt: null, voluntaryXp: false }];
  const errors = [], writes = [], completions = [];
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session') return send({ user });
    if (path === '/api/bootstrap' || path === '/api/live') return send({ user,
      faculty: { id: 'fsa', code: 'FSA', name: 'Faculté des Sciences Appliquées' },
      resources: [], notifications: [], announcements: [], messages: [], saved: [], history: [], channels: [], members: [] });
    if (path === '/api/labs' && method === 'GET') return send({ sessions, languages: ['javascript', 'python', 'c', 'cpp', 'json'] });
    if (path === '/api/labs' && method === 'POST') {
      const body = request.postDataJSON();
      const session = { id: `compact-${sessions.length}`, ...body, source: '', result: {}, revisions: 0,
        updatedAt: new Date().toISOString(), completedAt: null, potential: body.voluntaryXp ? 10 : 0, rewardedPoints: 0 };
      sessions.unshift(session);
      return send({ session }, 201);
    }
    const action = /^\/api\/labs\/([^/]+)\/(check|complete)$/.exec(path);
    if (action && method === 'POST') {
      const session = sessions.find(item => item.id === action[1]);
      assert.ok(session, 'Only this fixture’s private sessions may be changed');
      if (action[2] === 'check') {
        session.source = request.postDataJSON().source;
        session.result = { status: 'valid_syntax' };
        session.revisions++;
        writes.push({ id: session.id, source: session.source });
        return send({ session });
      }
      session.completedAt = new Date().toISOString();
      completions.push(session.id);
      return send({ session, reason: 'practice_not_enabled' });
    }
    errors.push(`Unexpected fixture API: ${method} ${path}`);
    return send({ error: 'Unexpected compact Labs fixture request' }, 500);
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`Console: ${message.text()}`); });
  page.on('requestfailed', request => {
    if (!request.failure()?.errorText?.includes('ABORTED')) errors.push(`Failed request: ${request.url()} ${request.failure()?.errorText}`);
  });
  await page.goto(`${origin}/app/labs`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.labs-code-editor .cm-content')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const run = page.getByRole('button', { name: words[language].run, exact: true });
  await expect(run).toBeEnabled();
  return { ...settings, context, page, errors, writes, completions, sessions, run, words: words[language] };
}

const editor = page => page.locator('.labs-code-editor .cm-content');
const buffer = page => page.locator('.labs-code-editor .cm-line').allTextContents().then(lines => lines.join('\n'));
async function run(f, source) {
  await editor(f.page).fill(source);
  await f.run.click();
  await expect(f.run).toBeEnabled({ timeout: 30000 });
  await expect(f.page.locator('.labs-console-status')).toHaveText(f.words.completed);
  assert.equal(await buffer(f.page), source, 'Run must preserve exactly the submitted code');
  assert.equal(f.writes.at(-1).source, source, 'The same draft must be saved without runtime output substitution');
}

async function geometry(f) {
  await f.page.evaluate(() => scrollTo(0, 0));
  const boxes = await f.page.evaluate(runName => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const run = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === runName);
    const code = document.querySelector('.labs-editor-frame');
    const topbar = document.querySelector('.labs-editor-title');
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      run: rect(run), editor: rect(code), console: rect(document.querySelector('.labs-console')),
      code: rect(document.querySelector('.labs-code-editor')), topbar: rect(topbar),
      runInsideTopbar: topbar.contains(run), direction: getComputedStyle(document.querySelector('.cm-content')).direction };
  }, f.words.run);
  assert.ok(boxes.scrollWidth <= boxes.width + 1, 'Labs never causes horizontal page scrolling');
  assert.ok(boxes.runInsideTopbar, 'Run belongs to the editor’s top bar');
  assert.ok(boxes.run.top >= 0 && boxes.run.bottom <= boxes.height, 'Run is visible immediately without scrolling');
  assert.ok(boxes.run.bottom <= boxes.code.top + 1, 'Run stays above editable code');
  for (const [name, box] of Object.entries({ run: boxes.run, editor: boxes.editor, console: boxes.console })) {
    assert.ok(box.left >= -1 && box.right <= boxes.width + 1, `${name} stays within the available width`);
  }
  if (f.width >= 1100) {
    assert.ok(boxes.console.left >= boxes.editor.right - 1 || boxes.console.right <= boxes.editor.left + 1, 'Desktop console is beside the editor');
    assert.ok(Math.abs(boxes.console.top - boxes.editor.top) <= 4, 'Desktop code and console start on the same row');
  } else if (f.width <= 650) assert.ok(boxes.console.top >= boxes.editor.bottom - 1, 'Phone console follows the editor');
  assert.equal(boxes.direction, 'ltr', 'Code remains LTR inside Arabic UI');
  report.layouts.push({ label: `${f.width}-${f.language}-${f.theme}`, ...boxes });
}

async function compactDetails(f) {
  const { page } = f;
  await expect(page.locator('.labs-ide-heading, .labs-editor-legend, .labs-sidebar')).toHaveCount(0);
  const details = page.locator('.labs-page details:visible');
  assert.ok(await details.count() >= 3, 'Input, saved sessions and supplementary practice information can stay collapsed');
  for (const detail of await details.all()) assert.equal(await detail.getAttribute('open'), null, 'Supplementary sections start collapsed');
  await expect(page.locator('.labs-session-list button')).toHaveCount(1);
  await expect(page.locator('.labs-session-list button')).toBeHidden();
}

try {
  for (const settings of variants) {
    const f = await fixture(settings), label = `${settings.width}-${settings.language}-${settings.theme}`;
    try {
      await compactDetails(f);
      await geometry(f);
      await run(f, 'console.log("compact labs output");');
      await expect(f.page.locator('.labs-console-output')).toContainText('compact labs output');
      await expect(f.page.locator('.labs-console-output .is-stderr')).toHaveCount(0);
      await geometry(f);
      await f.page.screenshot({ path: `${output}/${label}.png`, fullPage: true });

      await run(f, 'const total = 2 + 3;');
      await expect(f.page.locator('.labs-console-output pre')).toHaveCount(0);
      const noOutput = f.page.locator('.labs-console-placeholder');
      await expect(noOutput).toBeVisible();
      assert.match(await noOutput.textContent(), /sans sortie|aucune sortie|without output|no output|دون|بدون/i, 'A completed silent program gets a truthful no-output message');
      await expect(f.page.locator('.labs-console-footer')).toContainText('0');

      if (settings.width === 1440 && settings.language === 'fr') {
        await editor(f.page).fill('while (true) {}');
        await f.run.click();
        const stop = f.page.getByRole('button', { name: f.words.stop, exact: true });
        await expect(stop).toBeVisible();
        assert.ok(await stop.evaluate(node => Boolean(node.closest('.labs-editor-title'))), 'Stop stays beside Run above the code');
        await stop.click();
        await expect(f.page.locator('.labs-console-status')).toHaveText(f.words.stopped);
        await expect(f.run).toBeEnabled();

        const sessions = f.page.locator('details').filter({ has: f.page.locator('.labs-session-list') });
        await sessions.locator('summary').click();
        await sessions.locator('.labs-session-list button').last().click();
        await expect.poll(() => buffer(f.page)).toBe('console.log("restored private code");');
        await f.run.click();
        await expect(f.page.locator('.labs-console-output')).toContainText('restored private code');
        await expect(f.run).toBeEnabled();
        const finish = f.page.getByRole('button', { name: f.words.finish, exact: true });
        await expect(finish).toBeEnabled();
        await finish.click();
        await expect(editor(f.page)).toHaveAttribute('contenteditable', 'false');
        assert.ok(f.completions.includes('restored-fixture'));
        await f.page.getByRole('button', { name: f.words.fresh, exact: true }).click();
        await expect(editor(f.page)).toHaveAttribute('contenteditable', 'true');
        await editor(f.page).fill('console.log("new private draft");');
        await f.page.getByRole('tab', { name: f.words.graphs, exact: true }).click();
        await expect(f.page.locator('.labs-graph')).toBeVisible();
        await f.page.getByRole('tab', { name: f.words.code, exact: true }).click();
        assert.equal(await buffer(f.page), 'console.log("new private draft");', 'Graphs preserve the current code draft');
        await geometry(f);
        report.passed.push('Actual Stop, restored/private/new/finished sessions, read-only completed source, and Graphs preserve existing behavior');
      }
      assert.deepEqual(f.errors, []);
      report.passed.push(`${label}: initial top Run, console placement, compact details, actual JavaScript output and truthful completed-without-output state`);
    } catch (error) {
      await f.page.screenshot({ path: `${output}/${label}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { report.errors.push(...f.errors); await f.context.close(); }
  }
  console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors }, null, 2));
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
