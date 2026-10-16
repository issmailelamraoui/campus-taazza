import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LABS_LANGUAGES, LABS_POLICY, validateLabSource } from '../server/labs.js';
import { chooseOption } from './ui.helpers.mjs';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browserType = process.env.CAMPUS_TEST_BROWSER === 'firefox' ? firefox : chromium;
const browser = await browserType.launch({ headless: true, ...(browserType === chromium ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const passed = [], errors = [], sessions = [];
const greeting = 'hello world !!';
const invalidQuotes = 'console.log(¨ hello world !! ¨);';
const programs = {
  javascript: 'console.log("hello world !!");',
  python: 'print("hello world !!")',
  c: '#include <stdio.h>\nint main(void) { printf("hello world !!\\n"); return 0; }',
  cpp: '#include <iostream>\nint main() { std::cout << "hello world !!" << "\\n"; return 0; }',
  json: '{"message":"hello world !!"}',
};
const user = { id: 3, username: 'hello-fixture', name: 'Étudiant test', role: 'student', account_status: 'approved', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 3, language: 'fr' };
let page;
const editorValue = () => page.locator('.cm-line').allTextContents().then(lines => lines.join('\n'));
const execute = async (language = 'javascript') => {
  const button = page.getByRole('button', { name: language === 'json' ? 'Valider et formater' : 'Exécuter', exact: true });
  await button.click();
  await expect(button).toBeEnabled({ timeout: 120000 });
};
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    window.EventSource = undefined;
    localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
    localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
  });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user } });
    if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'flaa', name: 'Faculté test' }, resources: [], notifications: [], announcements: [], messages: [], saved: [], history: [], channels: [] } });
    if (path === '/api/labs' && request.method() === 'GET') return route.fulfill({ json: { sessions, policy: LABS_POLICY, executionAvailable: true, languages: LABS_LANGUAGES } });
    if (path === '/api/labs' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const session = { id: crypto.randomUUID(), language: body.language, voluntaryXp: false, potential: 0, source: '', result: {}, revisions: 0, updatedAt: new Date().toISOString(), completedAt: null, rewardedPoints: 0 };
      sessions.push(session);
      return route.fulfill({ status: 201, json: { session } });
    }
    const check = /^\/api\/labs\/([^/]+)\/check$/.exec(path);
    if (check) {
      const session = sessions.find(item => item.id === check[1]);
      session.source = request.postDataJSON().source;
      session.result = await validateLabSource(session.language, session.source);
      session.revisions++;
      return route.fulfill({ json: { session } });
    }
    return route.fulfill({ json: {} });
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL + '/app/labs');
  await expect(page.getByRole('heading', { name: 'Campus Labs', exact: true })).toBeVisible();

  for (const [language, source] of Object.entries(programs)) {
    if (language !== 'javascript') await chooseOption(page.getByLabel('Langage', { exact: true }), language);
    await page.getByLabel('Votre code', { exact: true }).fill(source);
    await execute(language);
    await expect(page.locator('.labs-console-status')).toHaveText('Terminé');
    await expect(page.locator('.labs-console-output')).toContainText(greeting);
    await expect(page.locator('.labs-console-output .is-stderr')).toHaveCount(0);
    assert.equal(await editorValue(), source, 'Running code must not silently change it.');
    if (language === 'json') await expect(page.locator('.labs-console-output')).toContainText('\n  "message": "hello world !!"\n');
    passed.push(`${language}: Hello World actually executes from the phone UI`);
    console.log('PASS ' + passed.at(-1));
  }

  await chooseOption(page.getByLabel('Langage', { exact: true }), 'javascript');
  await page.getByLabel('Votre code', { exact: true }).fill(invalidQuotes);
  await expect(page.locator('.labs-source-hint')).toBeVisible();
  assert.equal(await editorValue(), invalidQuotes, 'A proactive hint must leave the submitted source untouched.');
  await execute();
  await expect(page.locator('.labs-console-status')).toHaveText('Erreur');
  await expect(page.locator('.labs-console-output .is-stderr')).toContainText('SyntaxError');
  assert.equal(await editorValue(), invalidQuotes, 'Invalid quote characters must be diagnosed, not silently rewritten.');
  assert.equal(sessions.at(-1).result.status, 'syntax_error');
  passed.push('Exact reported source with ¨ characters receives a real SyntaxError and remains unchanged');
  console.log('PASS ' + passed.at(-1));

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
  }

  const revisions = sessions.at(-1).revisions;
  await page.getByRole('button', { name: 'Corriger les guillemets', exact: true }).click();
  assert.equal(await editorValue(), 'console.log(" hello world !! ");', 'Explicit quote correction must preserve the literal contents, including spaces.');
  await expect(page.locator('.labs-console-status')).toHaveText('Prête');
  await expect(page.locator('.labs-console-output .is-stderr')).toHaveCount(0);
  assert.equal(sessions.at(-1).revisions, revisions, 'Fixing delimiters must not submit or execute the code.');
  await execute();
  await expect(page.locator('.labs-console-status')).toHaveText('Terminé');
  await expect(page.locator('.labs-console-output')).toContainText(greeting);
  await expect(page.locator('.labs-console-output .is-stderr')).toHaveCount(0);
  passed.push('Explicit quote correction preserves the string and executes successfully only after Run');
  console.log('PASS ' + passed.at(-1));
  assert.deepEqual(errors, []);
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/labs-hello-world-${browserType.name()}.json`, JSON.stringify({ passed }, null, 2));
  console.log(`PASS ${passed.length} Hello World checks (${browserType.name()})`);
} catch (error) {
  mkdirSync('test-results', { recursive: true });
  if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/labs-hello-world-failure.png', fullPage: true }).catch(() => {});
  writeFileSync(`test-results/labs-hello-world-${browserType.name()}.json`, JSON.stringify({ passed, error: error.message, errors }, null, 2));
  throw error;
} finally { await browser.close(); }
