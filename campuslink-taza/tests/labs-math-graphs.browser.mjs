import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect as browserExpect } from '@playwright/test';

// Every API is intercepted. Graph calculation is the actual application code;
// these fixtures never access campus accounts, write to a database or opt in to
// notifications. A submitted function must not become executable JavaScript.
const origin = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const output = 'test-results/labs-math-graphs/chromium';
const expect = browserExpect.configure({ timeout: 15000 });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const report = { passed: [], expressions: [], layouts: [], errors: [], screenshots: [] };
const words = {
  fr: { graphs: 'Graphiques', plot: 'Tracer', code: 'Code', ranges: ['x minimum', 'x maximum', 'y minimum', 'y maximum'] },
  en: { graphs: 'Graphs', plot: 'Plot', code: 'Code', ranges: ['Minimum x', 'Maximum x', 'Minimum y', 'Maximum y'] },
  ar: { graphs: 'الرسوم البيانية', plot: 'رسم', code: 'البرمجة', ranges: ['أدنى x', 'أقصى x', 'أدنى y', 'أقصى y'] },
};
await mkdir(output, { recursive: true });

async function fixture({ width, height = 900, language = 'fr', theme = 'dark' }) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1100, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', JSON.stringify(language));
    localStorage.setItem('campuslink-prototype-v1:theme', JSON.stringify(theme));
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    window.__graphUnexpectedExecution = 0;
  }, { language, theme });
  let user = { id: 83, username: 'math-graph-fixture', name: 'Graph fixture', role: 'student', account_status: 'approved', faculty_id: 'fsa', filiere_id: 'data_science', current_semester: 3, language, preferences: {} };
  const errors = [], writes = [];
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (method === 'GET' && path === '/api/session') return send({ user });
    if (method === 'GET' && ['/api/bootstrap', '/api/live'].includes(path)) return send({ user, faculty: { id: 'fsa', code: 'FSA', name: 'Mathematics fixture faculty' }, resources: [], notifications: [], announcements: [], messages: [], saved: [], history: [], channels: [], members: [] });
    if (method === 'GET' && path === '/api/labs') return send({ sessions: [], languages: ['javascript', 'python', 'c', 'cpp', 'json'] });
    if (method === 'PATCH' && path === '/api/profile' && Object.keys(request.postDataJSON()).join(',') === 'language') {
      user = { ...user, language: request.postDataJSON().language }; writes.push({ path, body: request.postDataJSON() }); return send({ user });
    }
    errors.push(`Unexpected isolated graph API: ${method} ${path}`);
    return send({ error: 'Unexpected isolated graph API' }, 500);
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`Console: ${message.text()}`); });
  await page.goto(`${origin}/app/labs`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.labs-code-editor .cm-content')).toBeVisible();
  const draft = 'const graphDraft = "Keep my programming draft";';
  await page.locator('.labs-code-editor .cm-content').fill(draft);
  await page.getByRole('tab', { name: words[language].graphs, exact: true }).click();
  await expect(page.locator('.labs-graph')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { width, height, language, theme, context, page, errors, writes, draft, words: words[language] };
}
const input = f => f.page.getByLabel('f(x)', { exact: true });
async function range(f, values) { for (let i = 0; i < values.length; i++) await f.page.getByLabel(f.words.ranges[i], { exact: true }).fill(String(values[i])); }
async function plot(f, expression) {
  await input(f).fill(expression);
  await f.page.getByRole('button', { name: f.words.plot, exact: true }).click();
  await expect(input(f)).toHaveValue(expression);
}
async function table(f) {
  const details = f.page.locator('.labs-values');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  return f.page.locator('.labs-values tbody tr').evaluateAll(rows => rows.map(row => {
    const cells = [...row.querySelectorAll('td')].map(cell => cell.textContent.trim());
    return { x: Number(cells[0]), y: cells[1] === '—' ? null : Number(cells[1]) };
  }));
}
async function values(f, evaluate, samples = [-2, -1, 0, 1, 2]) {
  const rows = await table(f);
  for (const x of samples) {
    const row = rows.find(value => Math.abs(value.x - x) < 1e-6); assert.ok(row, `Value table includes x=${x}`);
    const expected = evaluate(x);
    if (!Number.isFinite(expected)) assert.equal(row.y, null, `Undefined at x=${x}`);
    else { assert.ok(row.y !== null && Number.isFinite(row.y), `f(${x}) must be a finite real value`); assert.ok(Math.abs(row.y - expected) <= 0.00011, `f(${x})=${row.y}, expected ${expected}`); }
  }
}
async function fits(f) {
  const layout = await f.page.evaluate(() => {
    const graph = document.querySelector('.labs-graph').getBoundingClientRect(), form = document.querySelector('.labs-graph-workspace').getBoundingClientRect();
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, graph: { left: graph.left, right: graph.right, width: graph.width }, form: { left: form.left, right: form.right }, direction: getComputedStyle(document.querySelector('.labs-graph-workspace input')).direction, theme: document.documentElement.dataset.theme, language: document.documentElement.lang };
  });
  assert.ok(layout.scrollWidth <= layout.width + 1, 'Graphs do not cause horizontal page scrolling');
  assert.ok(layout.form.left >= -1 && layout.form.right <= layout.width + 1, 'Controls fit the viewport');
  assert.ok(layout.graph.left >= -1 && layout.graph.right <= layout.width + 1, 'Graph fits the viewport');
  assert.equal(layout.direction, 'ltr', 'Mathematical input stays LTR in the Arabic UI');
  report.layouts.push({ label: `${f.width}-${f.language}-${f.theme}`, ...layout });
}
async function checked(label, settings, action) {
  const f = await fixture(settings);
  try { await action(f); assert.deepEqual(f.errors, []); report.passed.push(label); }
  catch (error) { await f.page.screenshot({ path: `${output}/${f.width}-${f.language}-failure.png`, fullPage: true }).catch(() => {}); throw error; }
  finally { report.errors.push(...f.errors); await f.context.close(); }
}

try {
  await checked('Desktop evaluates all required conventional expressions with correct domains and exact input preservation', { width: 1440 }, async f => {
    await range(f, [-2, 2, -20, 20]);
    const cases = [
      ['|x|', Math.abs], ['|x-3|', x => Math.abs(x - 3)], ['|x^2-4|', x => Math.abs(x * x - 4)],
      ['ln(x)', Math.log], ['log(x)', Math.log10], ['e^x', Math.exp], ['exp(x)', Math.exp], ['e(x)', Math.exp],
      ['sqrt(x)', Math.sqrt], ['x^2', x => x * x], ['x^3-2*x', x => x ** 3 - 2 * x], ['1/x', x => 1 / x],
      ['sin(x)', Math.sin], ['cos(x)', Math.cos], ['tan(x)', Math.tan], ['ln(|x|)', x => Math.log(Math.abs(x))],
      ['exp(-x^2)', x => Math.exp(-(x ** 2))], ['sqrt(x^2+1)', x => Math.sqrt(x * x + 1)], ['|sin(x)|', x => Math.abs(Math.sin(x))],
      ['  2x + 3(x+1)  ', x => 2 * x + 3 * (x + 1)], ['(x+1)(x-1)', x => (x + 1) * (x - 1)], ['sin(pi/2)+cos(0)', () => 2], ['-x^2', x => -(x ** 2)],
    ];
    for (const [expression, evaluate] of cases) {
      await plot(f, expression); await expect(f.page.locator('.labs-alert.is-error')).toHaveCount(0);
      await expect(f.page.locator('.labs-graph')).toBeVisible(); await expect(f.page.locator('.labs-graph')).toHaveAttribute('aria-label', `f(x) = ${expression}`);
      await values(f, evaluate); report.expressions.push(expression);
    }
    await fits(f); assert.deepEqual(f.writes, [], 'Plotting never creates or modifies a code session');
    const path = `${output}/desktop-dark-polynomial.png`; await f.page.screenshot({ path }); report.screenshots.push(path);
  });
  await checked('Off-grid odd/even poles and tangent split into separate SVG segments even inside a broad vertical range', { width: 1440, language: 'en', theme: 'light' }, async f => {
    await range(f, [-2, 2, -100000, 100000]);
    for (const [expression, segments] of [['1/(x-0.037)', 2], ['1/(x-0.037)^2', 2], ['tan(x)', 3]]) {
      await plot(f, expression); await expect(f.page.locator('.labs-alert.is-error')).toHaveCount(0);
      const path = await f.page.locator('.labs-function').getAttribute('d');
      assert.ok((path.match(/M/g) || []).length >= segments, `${expression} cannot bridge a vertical asymptote`);
      assert.doesNotMatch(path, /NaN|Infinity/);
    }
    await fits(f); assert.deepEqual(f.writes, []);
  });
  await checked('Arabic phone preserves domains, code draft, native range controls and readable invalid-input feedback', { width: 390, height: 844, language: 'ar', theme: 'light' }, async f => {
    await range(f, [-2, 2, -10, 10]);
    await plot(f, 'ln(|x|)'); await values(f, x => Math.log(Math.abs(x)));
    const previous = await f.page.locator('.labs-function').getAttribute('d');
    for (const expression of ['sin(', 'x+*2', 'window.__graphUnexpectedExecution=1', 'constructor(x)', '|x', '('.repeat(40) + 'x' + ')'.repeat(40)]) {
      await plot(f, expression); await expect(f.page.locator('.labs-alert.is-error')).toBeVisible();
      assert.ok((await f.page.locator('.labs-alert.is-error').textContent()).trim().length > 12, 'Invalid expressions explain the problem');
      assert.equal(await f.page.locator('.labs-function').getAttribute('d'), previous, 'Invalid input does not destroy the last valid graph');
    }
    assert.equal(await f.page.evaluate(() => window.__graphUnexpectedExecution), 0);
    await plot(f, 'e(x)'); await values(f, Math.exp); await fits(f);
    await f.page.getByRole('tab', { name: f.words.code, exact: true }).click();
    assert.equal((await f.page.locator('.labs-code-editor .cm-line').allTextContents()).join('\n'), f.draft);
    await f.page.getByRole('tab', { name: f.words.graphs, exact: true }).click(); await expect(input(f)).toHaveValue('e(x)');
    await range(f, [2, -2, -10, 10]); await f.page.getByRole('button', { name: f.words.plot, exact: true }).click();
    await expect(f.page.locator('.labs-alert.is-error')).toBeVisible();
    await range(f, [-2, 2, -10, 10]); await plot(f, 'sqrt(x)'); await values(f, Math.sqrt);
    await fits(f); assert.deepEqual(f.writes, []);
    const path = `${output}/phone-arabic-light-square-root.png`; await f.page.screenshot({ path }); report.screenshots.push(path);
  });
  await checked('Tablet language and theme switching keep the current graph and expression intact', { width: 768, height: 1024, language: 'fr', theme: 'dark' }, async f => {
    await range(f, [-2, 2, -10, 10]); await plot(f, '|sin(x)|'); await values(f, x => Math.abs(Math.sin(x)));
    const prior = await f.page.locator('.labs-function').getAttribute('d');
    await f.page.locator('.language-select').click(); await f.page.getByRole('option', { name: 'EN', exact: true }).click();
    await expect(f.page.locator('html')).toHaveAttribute('lang', 'en'); f.language = 'en'; f.words = words.en;
    await expect(f.page.getByRole('button', { name: 'Plot', exact: true })).toBeVisible();
    await expect(input(f)).toHaveValue('|sin(x)|'); assert.equal(await f.page.locator('.labs-function').getAttribute('d'), prior);
    await f.page.getByRole('button', { name: 'Switch theme', exact: true }).click();
    await expect(f.page.locator('html')).toHaveAttribute('data-theme', 'light'); f.theme = 'light';
    await fits(f); assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0], { path: '/api/profile', body: { language: 'en' } });
    const path = `${output}/tablet-english-light-absolute-sine.png`; await f.page.screenshot({ path }); report.screenshots.push(path);
  });
  await checked('Narrow 320px phone keeps function, ranges, graph and values within the existing responsive layout', { width: 320, height: 740, language: 'fr', theme: 'dark' }, async f => {
    await range(f, [-2, 2, -10, 10]); await plot(f, '|x-3|'); await values(f, x => Math.abs(x - 3)); await fits(f);
    const path = `${output}/phone-320-dark-absolute.png`; await f.page.screenshot({ path }); report.screenshots.push(path); assert.deepEqual(f.writes, []);
  });
  console.log(JSON.stringify({ passed: report.passed.length, expressions: report.expressions.length, errors: report.errors }, null, 2));
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); }
