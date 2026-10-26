import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, firefox, expect } from '@playwright/test';
import { chooseOption } from './ui.helpers.mjs';

// UI and real local execution with every API mocked: never use campus accounts,
// the database, or object storage for editor regressions.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const engine = process.env.CAMPUS_TEST_BROWSER || 'chromium';
const redoKey = process.platform === 'win32' ? 'Control+y' : 'Control+Shift+Z';
assert.ok(['chromium', 'firefox'].includes(engine));
const browser = await ({ chromium, firefox })[engine].launch({ headless: true,
  ...(engine === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const output = `test-results/labs-editor/${engine}`;
await mkdir(output, { recursive: true });
const passed = [], timings = [];
const variants = [
  { width: 320, language: 'fr', theme: 'dark' },
  { width: 390, language: 'ar', theme: 'light' },
  { width: 768, language: 'fr', theme: 'light' },
  { width: 1024, language: 'ar', theme: 'dark' },
  { width: 1440, language: 'fr', theme: 'dark' },
  { width: 1440, language: 'en', theme: 'light' },
];
const widths = process.env.CAMPUS_EDITOR_WIDTH?.split(',').map(Number);
const selectedVariants = variants.filter(item => !widths || widths.includes(item.width));
assert.ok(selectedVariants.length, 'No editor scenarios match CAMPUS_EDITOR_WIDTH');
const sample = `// Editor color and readability fixture
class Student {
  constructor(score) { this.score = score; }
  total(extra) { return this.score + extra; }
}
function sum(value) { return value + 2; }
const student = new Student(12);
const message = "hello";
console.log(sum(student.score));`;

async function fixture(settings) {
  const { width, language, theme } = settings;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 1100,
    ...(engine === 'chromium' ? { isMobile: width < 1100 } : {}), serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(({ language, theme }) => {
    if (window !== window.top) return;
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  }, { language, theme });
  const user = { id: 3, username: 'editor-fixture', name: 'Editor fixture', role: 'student', account_status: 'approved',
    faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 3, language };
  const sessions = [{ id: 'restored', language: 'javascript', source: 'console.log("saved session");', result: { status: 'valid_syntax' }, updatedAt: new Date().toISOString(), completedAt: null, voluntaryXp: false }];
  const requests = [], errors = [];
  let releaseSave;
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if ((path === '/api/bootstrap' || path === '/api/live') && request.method() === 'GET') return route.fulfill({ json: { user, faculty: { id: 'flaa', code: 'FLAA', name: 'Fixture faculty' }, resources: [], notifications: [], announcements: [], messages: [], saved: [], history: [], channels: [] } });
    if (path === '/api/labs' && request.method() === 'GET') return route.fulfill({ json: { sessions, languages: ['javascript', 'json', 'python', 'c', 'cpp'] } });
    if (path === '/api/labs' && request.method() === 'POST') {
      const session = { id: `fixture-${sessions.length}`, ...request.postDataJSON(), source: '', result: {}, updatedAt: new Date().toISOString(), completedAt: null };
      sessions.push(session);
      return route.fulfill({ status: 201, json: { session } });
    }
    const match = /^\/api\/labs\/([^/]+)\/(check|complete)$/.exec(path);
    if (match) {
      const session = sessions.find(item => item.id === match[1]);
      assert.ok(session);
      if (match[2] === 'complete') {
        session.completedAt = new Date().toISOString();
        return route.fulfill({ json: { session, reason: 'practice_not_enabled' } });
      }
      const body = request.postDataJSON();
      requests.push(body.source);
      const finish = async () => { session.source = body.source; session.result = { status: 'valid_syntax' }; await route.fulfill({ json: { session } }); };
      if (body.source.includes('slow-save')) { releaseSave = finish; return; }
      return finish();
    }
    errors.push(`Unexpected fixture request: ${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected editor fixture request' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/app/labs`);
  await expect(page.locator('.labs-code-editor .cm-content')).toBeVisible();
  return { page, context, errors, requests, release: async () => { await expect.poll(() => Boolean(releaseSave)).toBe(true); await releaseSave(); releaseSave = null; } };
}
const text = page => page.locator('.labs-code-editor .cm-content .cm-line').allTextContents().then(lines => lines.join('\n'));
async function pasteDocument(page, editor, source) {
  await editor.focus();
  await page.keyboard.press('Control+a');
  await editor.evaluate((element, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    // Firefox does not expose data from a synthetic clipboard event unless
    // explicitly provided. Exercise the same editor boundary as native paste.
    Object.defineProperty(event, 'clipboardData', { value: data });
    element.dispatchEvent(event);
  }, source);
}
async function fits(page) {
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const elements = ['.labs-editor-frame', '.labs-editor-status', '.cm-content'];
    return { width: root.clientWidth, scroll: root.scrollWidth, boxes: elements.map(selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { selector, left: r.left, right: r.right };
    }), direction: getComputedStyle(document.querySelector('.cm-content')).direction };
  });
  assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry));
  for (const box of geometry.boxes) assert.ok(box.left >= -1 && box.right <= geometry.width + 1, JSON.stringify(box));
  assert.equal(geometry.direction, 'ltr');
}

try {
  for (const settings of selectedVariants) {
    const { width, language, theme } = settings;
    const f = await fixture(settings), { page, context } = f;
    const editor = page.locator('.labs-code-editor .cm-content');
    const label = `${width}-${language}-${theme}`;
    try {
      await editor.fill(sample);
      await expect.poll(() => page.locator('.labs-semantic-function').count()).toBeGreaterThan(0);
      await fits(page);
      const palette = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const painter = canvas.getContext('2d');
        function rgb(color) { painter.clearRect(0, 0, 1, 1); painter.fillStyle = color; painter.fillRect(0, 0, 1, 1); return [...painter.getImageData(0, 0, 1, 1).data].slice(0, 3); }
        function luminance(color) { return rgb(color).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0); }
        const background = getComputedStyle(document.querySelector('.cm-editor')).backgroundColor, bg = luminance(background);
        const palette = getComputedStyle(document.querySelector('.labs-page'));
        const entries = ['keyword', 'function', 'variable', 'property', 'class', 'string', 'number', 'comment'].map(type => {
          const color = `rgb(${rgb(palette.getPropertyValue(`--labs-${type}`)).join(', ')})`, l = luminance(color);
          return { type, color, contrast: (Math.max(bg, l) + .05) / (Math.min(bg, l) + .05) };
        });
        function leafColor(selector) { let leaf = document.querySelector(selector); while (leaf.firstElementChild) leaf = leaf.firstElementChild; return getComputedStyle(leaf).color; }
        const classColor = leafColor('.labs-semantic-class');
        const functionColor = leafColor('.labs-semantic-function');
        return { entries, classColor, functionColor };
      });
      assert.equal(new Set(palette.entries.map(item => item.color)).size, 8, 'Each token category should have its own color');
      for (const token of palette.entries) assert.ok(token.contrast >= 4.5, `${label}: ${token.type} contrast ${token.contrast}`);
      assert.equal(palette.classColor, palette.entries.find(item => item.type === 'class').color);
      assert.equal(palette.functionColor, palette.entries.find(item => item.type === 'function').color);
      await page.screenshot({ path: `${output}/${label}.png`, fullPage: true });

      const search = page.locator('.labs-editor-tools button').first();
      await search.click();
      const find = page.locator('.cm-search input[name="search"]');
      await expect(find).toBeFocused();
      await find.fill('score'); await find.press('a'); await find.press('Backspace');
      await expect.poll(() => page.locator('.cm-searchMatch').count()).toBeGreaterThan(0);
      await page.locator('.cm-search input[name="replace"]').fill('points');
      await page.locator('.cm-search button[name="replaceAll"]').click();
      await expect.poll(() => text(page)).not.toContain('score');
      await expect.poll(() => text(page)).toContain('points');
      await find.press('Escape');
      await expect(page.locator('.cm-search')).toHaveCount(0);
      const wrap = page.locator('.labs-editor-tools button[aria-pressed]');
      await wrap.click(); await expect(wrap).toHaveAttribute('aria-pressed', 'false');
      await wrap.click(); await expect(wrap).toHaveAttribute('aria-pressed', 'true');
      await fits(page);

      if (width === 1440 && language === 'fr') {
        await editor.fill('console.log(¨hello¨);');
        await page.getByRole('button', { name: 'Corriger les guillemets', exact: true }).click();
        await expect.poll(() => text(page)).toBe('console.log("hello");');
        await editor.press('Control+z');
        assert.equal(await text(page), 'console.log(¨hello¨);', 'Explicit quote correction should be independently undoable');
        await editor.press(redoKey);
        await expect.poll(() => text(page)).toBe('console.log("hello");');
        await editor.press('Control+End'); await page.keyboard.type(' // next draft');
        const beforeGraphsPosition = await page.locator('.labs-editor-position').textContent();
        await page.getByRole('tab', { name: 'Graphiques', exact: true }).click();
        await page.getByRole('tab', { name: 'Code', exact: true }).click();
        assert.equal(await text(page), 'console.log("hello"); // next draft', 'Returning to Code must not replay an old replacement command');
        assert.equal(await page.locator('.labs-editor-position').textContent(), beforeGraphsPosition, 'Graphs must preserve the code cursor position');
        await editor.press('Control+z');
        assert.equal(await text(page), 'console.log("hello");', 'Switching to Graphs must preserve the code undo history');
        await editor.press(redoKey);
        assert.equal(await text(page), 'console.log("hello"); // next draft');
        await editor.fill('const privateDraft = 123;');
        await page.locator('details').filter({ has: page.locator('.labs-session-list') }).locator('summary').click();
        await page.locator('.labs-session-list button').first().click();
        await expect.poll(() => text(page)).toBe('console.log("saved session");');
        await editor.press('Control+z');
        assert.equal(await text(page), 'console.log("saved session");', 'Undo must not restore an unrelated session');
        await chooseOption(page.getByLabel('Langage', { exact: true }), 'python');
        await editor.press('Control+z');
        assert.match(await text(page), /^def moyenne/);
        await chooseOption(page.getByLabel('Langage', { exact: true }), 'javascript');
        await editor.fill('const myScore = 7;\nmySc');
        await editor.press('Control+Space');
        await expect(page.locator('.cm-completionLabel').filter({ hasText: 'myScore' })).toBeVisible();
        await editor.press('Enter');
        assert.match(await text(page), /mySc\n$/, 'Unselected completion must not hijack Enter');
        await editor.fill('const myScore = 7;\nmySc');
        await editor.press('Control+Space');
        await expect(page.locator('.cm-completionLabel').filter({ hasText: 'myScore' })).toBeVisible();
        await page.locator('.cm-completionLabel').filter({ hasText: 'myScore' }).click();
        assert.match(await text(page), /\nmyScore$/);
        for (const [id, prefix, option] of [['python', 'pri', 'print'], ['c', 'retu', 'return'], ['cpp', 'namesp', 'namespace'], ['json', 'fal', 'false']]) {
          await chooseOption(page.getByLabel('Langage', { exact: true }), id);
          await editor.fill(prefix); await editor.press('Control+Space');
          await page.locator('.cm-completionLabel').filter({ hasText: new RegExp(`^${option}$`) }).click();
          assert.equal(await text(page), option, `${id} completion should insert the selected item`);
        }
        await chooseOption(page.getByLabel('Langage', { exact: true }), 'javascript');
        await editor.fill('function folded() {\n  return 42;\n}\nconsole.log(folded());');
        await page.locator('.cm-foldGutter [title]:visible').first().click();
        await expect(page.locator('.cm-foldPlaceholder')).toBeVisible();
        await page.locator('.cm-foldPlaceholder').click();
        await expect(page.locator('.cm-foldPlaceholder')).toHaveCount(0);
        await editor.focus();
        // Let the clicked folding widget finish its DOM/selection measurement
        // before starting a separate keyboard focus-navigation interaction.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        // Automation's fill can use an IME. Escape belongs to that IME until
        // CodeMirror's documented composition grace period has ended.
        await expect.poll(() => editor.evaluate(async element => {
          const { EditorView } = await import('/node_modules/.vite/deps/@codemirror_view.js');
          return EditorView.findFromDOM(element).composing;
        })).toBe(false);
        const beforeTab = await text(page);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Tab');
        await expect(editor).not.toBeFocused();
        assert.equal(await text(page), beforeTab, 'Escape/Tab must leave the buffer unchanged');

        await editor.fill('console.log("slow-save");');
        await editor.press('Control+Enter');
        await expect(page.locator('.labs-console-output')).toContainText('slow-save', { timeout: 30000 });
        await expect(page.locator('.labs-console-status')).toContainText('Terminé');
        await expect(editor).toBeEditable();
        await expect(page.getByRole('button', { name: 'Arrêter', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Enregistrement…', exact: true })).toBeDisabled();
        await editor.fill('console.log("next draft");');
        await f.release();
        await expect(page.getByRole('button', { name: 'Exécuter', exact: true })).toBeEnabled();
        assert.equal(await text(page), 'console.log("next draft");');
        await expect(page.getByRole('button', { name: 'Terminer la session', exact: true })).toBeDisabled();
        await editor.press('Control+Enter');
        await expect(page.locator('.labs-console-output')).toContainText('next draft');
        await expect(page.getByRole('button', { name: 'Exécuter', exact: true })).toBeEnabled();
        assert.equal(f.requests.at(-1), 'console.log("next draft");');

        const program = 'for (let i = 0; i < 600; i++) console.log(i); console.error("stderr-tail"); console.log("stdout-tail");';
        await editor.fill(program); await editor.press('Control+Enter');
        await expect(page.getByRole('button', { name: 'Exécuter', exact: true })).toBeEnabled({ timeout: 30000 });
        assert.equal(await page.locator('.labs-console-output pre').textContent(), Array.from({ length: 600 }, (_, i) => `${i}\n`).join('') + 'stderr-tail\nstdout-tail\n');
        assert.ok(await page.locator('.labs-console-output pre > span').count() <= 3, 'Consecutive output must be batched without losing stream order');
        await page.getByRole('tab', { name: 'Graphiques', exact: true }).click();
        await page.getByRole('tab', { name: 'Code', exact: true }).click();
        await expect.poll(() => page.locator('.labs-console-output').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2);

        const huge = Array.from({ length: 14000 }, (_, i) => `function task${i}(value) { return value + ${i}; } // viewport stress`).join('\n');
        const before = performance.now();
        await pasteDocument(page, editor, huge);
        await expect(page.locator('.labs-editor-position')).toContainText('14000');
        await expect.poll(() => page.locator('.cm-content .cm-line').count()).toBeLessThan(500);
        // The editor grows from its minimum to its maximum height here. Keep
        // the whole workspace in view so the last line is actually visible,
        // rather than asking a viewport-only parser to color off-screen text.
        await page.locator('.labs-editor-frame').scrollIntoViewIfNeeded();
        await editor.focus();
        await page.keyboard.press('Control+End');
        await expect(editor).toBeFocused();
        await expect.poll(() => page.locator('.labs-semantic-function').allTextContents(), { timeout: 20000 }).toContain('task13999');
        const sampleTimings = [];
        for (let i = 0; i < 8; i++) { const start = performance.now(); await page.keyboard.type('x'); sampleTimings.push(performance.now() - start); }
        assert.ok(Math.max(...sampleTimings) < 1500, `Large document typing stalled: ${sampleTimings}`);
        timings.push({ engine, bytes: huge.length, loadAndScrollMs: performance.now() - before, keyMs: sampleTimings, drawnLines: await page.locator('.cm-content .cm-line').count() });
        await pasteDocument(page, editor, 'console.log("readonly");');
        await editor.press('Control+Enter');
        await expect(page.getByRole('button', { name: 'Terminer la session', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Terminer la session', exact: true }).click();
        await expect(editor).toHaveAttribute('contenteditable', 'false');
        await editor.focus(); await page.keyboard.type('x');
        assert.equal(await text(page), 'console.log("readonly");');
        await page.locator('.labs-console-clear').click();
        await editor.focus(); await page.keyboard.press('Control+Enter');
        await expect(page.locator('.labs-console-output')).toContainText('readonly');
        await expect(page.getByRole('button', { name: 'Exécuter', exact: true })).toBeEnabled();
        await expect(editor).toHaveAttribute('contenteditable', 'false');
      }
      assert.deepEqual(f.errors, []);
      passed.push(label);
      console.log(`PASS ${engine} ${label}: clear accessible syntax colors, responsive LTR editor, search/replace and wrap${width === 1440 && language === 'fr' ? ', completions, history isolation, current-source run, batched output, large-document typing, readonly' : ''}`);
    } catch (error) {
      await page.screenshot({ path: `${output}/${label}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(`${output}/report${widths ? '-' + widths.join('-') : ''}.json`, JSON.stringify({ passed, timings }, null, 2));
}
