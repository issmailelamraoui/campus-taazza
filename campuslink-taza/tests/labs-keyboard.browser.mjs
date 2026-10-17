import assert from 'node:assert/strict';
import { chromium, firefox, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { validateLabSource, LABS_LANGUAGES, LABS_POLICY } from '../server/labs.js';
import { chooseOption } from './ui.helpers.mjs';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browserTypes = process.env.CAMPUS_TEST_BROWSER === 'firefox' ? [firefox]
  : process.env.CAMPUS_TEST_BROWSER === 'chromium' ? [chromium] : [chromium, firefox];
const passed = [];
mkdirSync('test-results', { recursive: true });

for (const browserType of browserTypes) {
  const browser = await browserType.launch({ headless: true, ...(browserType === chromium ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
    const user = { id: 3, username: 'keyboard-fixture', name: 'Keyboard test', role: 'student', account_status: 'approved', faculty_id: 'flaa', filiere_id: 'french_studies', current_semester: 3, language: 'fr' };
    const sessions = [], errors = [];
    await context.addInitScript(() => {
      if (window !== window.top) return;
      window.EventSource = undefined;
      localStorage.setItem('campuslink-prototype-v1:language', '"fr"');
      localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1', 'true');
    });
    await context.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path === '/api/session') return route.fulfill({ json: { user } });
      if (path === '/api/bootstrap') return route.fulfill({ json: { user, faculty: { id: 'flaa', name: 'Faculté test' }, resources: [], notifications: [], announcements: [], messages: [], saved: [], history: [], channels: [] } });
      if (path === '/api/labs' && req.method() === 'GET') return route.fulfill({ json: { sessions, policy: LABS_POLICY, executionAvailable: true, languages: LABS_LANGUAGES } });
      if (path === '/api/labs' && req.method() === 'POST') {
        const { language, voluntaryXp } = req.postDataJSON();
        const session = { id: crypto.randomUUID(), language, voluntaryXp, potential: 0, source: '', result: {}, revisions: 0, updatedAt: new Date().toISOString(), completedAt: null, rewardedPoints: 0 };
        sessions.push(session);
        return route.fulfill({ status: 201, json: { session } });
      }
      const action = /^\/api\/labs\/([^/]+)\/(check|complete)$/.exec(path);
      if (action) {
        const session = sessions.find(item => item.id === action[1]);
        if (action[2] === 'check') {
          session.source = req.postDataJSON().source;
          session.result = await validateLabSource(session.language, session.source);
          session.revisions++;
        } else session.completedAt = new Date().toISOString();
        return route.fulfill({ json: { session, reason: 'practice_not_enabled' } });
      }
      return route.fulfill({ json: {} });
    });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL + '/app/labs');
    const editor = page.getByLabel('Votre code', { exact: true });
    await expect(editor).toBeVisible();
    const value = () => page.locator('.cm-line').allTextContents().then(lines => lines.join('\n'));
    const key = init => editor.evaluate((element, options) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, init);
    const input = init => editor.evaluate((element, options) => {
      const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, ...options });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, init);
    const deadQuote = () => key({ key: 'Dead', code: 'Quote', shiftKey: true });

    await editor.fill('');
    await page.keyboard.press('Shift+Quote');
    assert.equal(await value(), '"', 'A standard physical quote key stays a straight quote.');
    await editor.fill('');
    await page.waitForTimeout(550);
    assert.equal(await deadQuote(), true);
    assert.equal(await value(), '"');
    await page.keyboard.press('Control+z');
    assert.equal(await value(), '', 'A normalized quote participates in normal editor undo.');
    await page.keyboard.press('Control+Shift+Z');
    assert.equal(await value(), '"', 'A normalized quote participates in normal editor redo.');
    passed.push(`${browserType.name()}: physical and International dead quote keys, undo and redo`);

    // Match the native Linux event order: a prevented Dead keydown can still
    // start a non-cancellable composition and insert a second diaeresis.
    // This is materially different from asserting defaultPrevented alone.
    for (const physicalKey of ['Dead', 'Process']) {
      await editor.fill('');
      await page.waitForTimeout(550);
      await key({ key: physicalKey, code: 'Quote', shiftKey: true, keyCode: physicalKey === 'Process' ? 229 : 0 });
      if (browserType === chromium) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.imeSetComposition', { text: '¨', selectionStart: 1, selectionEnd: 1 });
        await cdp.detach();
      } else {
        await editor.evaluate(element => {
          element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
          element.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '¨' }));
          element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: false, inputType: 'insertCompositionText', data: '¨', isComposing: true }));
          const selection = window.getSelection();
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const text = document.createTextNode('¨');
          range.insertNode(text);
          selection.collapse(text, 1);
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '¨', isComposing: true }));
        });
      }
      await expect.poll(value).toBe('"');
      await page.waitForTimeout(80);
      await expect(editor).toBeFocused();
      await page.keyboard.type('u');
      assert.equal(await value(), '"u', `${physicalKey}: the next letter follows the quote and cannot inherit its dead key.`);
      await page.keyboard.press('Control+z');
      const firstUndo = await value();
      assert.ok(['', '"'].includes(firstUndo), 'Undo removes a normal typing group, never restores a diaeresis.');
      if (firstUndo === '"') await page.keyboard.press('Control+z');
      await expect.poll(value).toBe('');
      await page.keyboard.press('Control+Shift+Z');
      if (firstUndo === '"') await page.keyboard.press('Control+Shift+Z');
      await expect.poll(value).toBe('"u');
    }
    passed.push(`${browserType.name()}: native-style dead-key composition, no duplicate diaeresis, settled caret and history`);

    await editor.fill('');
    assert.equal(await key({ key: '¨', code: 'BracketLeft' }), true);
    assert.equal(await value(), '"');
    await editor.fill('');
    assert.equal(await input({ inputType: 'insertText', data: '¨' }), true);
    assert.equal(await value(), '"', 'A software keyboard spacing diaeresis becomes a delimiter.');
    await editor.fill('');
    await editor.evaluate(element => {
      window.quoteInputTrace = [];
      for (const type of ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionend']) element.addEventListener(type, event => {
        window.quoteInputTrace.push({ type, data: event.data, key: event.key, inputType: event.inputType, isComposing: event.isComposing, cancelable: event.cancelable });
      });
    });
    await page.keyboard.insertText('¨');
    const nativeInput = await page.evaluate(() => window.quoteInputTrace);
    // Firefox's automation insertText command deliberately emits an IME
    // composition. Chromium uses direct text input / EditContext instead.
    const nativeComposition = nativeInput.some(event => event.type === 'compositionstart');
    assert.equal(await value(), nativeComposition ? '¨' : '"', JSON.stringify(nativeInput));
    for (const change of [
      { inputType: 'insertFromPaste', data: '¨' },
      { inputType: 'insertReplacementText', data: '¨' },
      { inputType: 'insertCompositionText', data: '¨', isComposing: true },
    ]) assert.equal(await input(change), false);
    for (const pasted of ['const accent = "¨ ü";', '¨']) {
      await editor.fill('');
      await editor.evaluate((element, text) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
        const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
        // Firefox deliberately empties synthetic clipboard event data. Supply
        // the payload that a trusted browser paste exposes to the editor.
        Object.defineProperty(event, 'clipboardData', { value: clipboardData });
        element.dispatchEvent(event);
      }, pasted);
      await expect.poll(value).toBe(pasted);
    }
    passed.push(`${browserType.name()}: software keyboard fallback and verbatim paste`);

    await editor.fill('');
    await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
    assert.equal(await deadQuote(), false, 'An active composition owns dead keys.');
    assert.equal(await input({ inputType: 'insertText', data: '¨' }), false, 'An active composition also owns beforeinput.');
    await editor.evaluate(element => {
      element.firstChild.textContent = 'ü';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'ü', isComposing: true }));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ü' }));
    });
    assert.equal(await input({ inputType: 'insertText', data: '¨' }), false, 'The final composition event must not be rewritten.');
    await expect.poll(value).toBe('ü');
    await page.waitForTimeout(150);
    for (const modified of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }]) {
      assert.equal(await key({ key: '¨', code: 'Quote', ...modified }), false);
      if (!modified.isComposing) assert.equal(await input({ inputType: 'insertText', data: '¨' }), false, 'AltGr and shortcut input remains unchanged.');
    }
    assert.equal(await key({ key: 'Dead', code: 'Quote', shiftKey: false }), false, 'The acute accent dead key is preserved.');
    assert.equal(await key({ key: 'Dead', code: 'BracketLeft', shiftKey: true }), false);
    assert.equal(await value(), 'ü');
    passed.push(`${browserType.name()}: IME accents, final composition input and keyboard shortcuts preserved`);

    for (const language of ['json', 'python', 'c', 'cpp', 'javascript']) {
      await chooseOption(page.getByLabel('Langage', { exact: true }), language);
      await editor.fill('');
      assert.equal(await deadQuote(), true);
      assert.equal(await value(), '"', `${language} uses the same keyboard correction.`);
    }
    await editor.fill('');
    await page.keyboard.type('console.log(');
    await deadQuote();
    await page.keyboard.type('hello world !!');
    await deadQuote();
    await page.keyboard.type(');');
    assert.equal(await value(), 'console.log("hello world !!");');
    await page.getByRole('button', { name: 'Exécuter', exact: true }).click();
    await expect(page.locator('.labs-console-output')).toContainText('hello world !!', { timeout: 30000 });
    await expect(page.locator('.labs-console-status')).toContainText('Terminé');
    await expect(page.getByRole('button', { name: 'Exécuter', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Terminer la session', exact: true }).click();
    await expect(page.locator('.labs-code-editor')).toHaveAttribute('data-readonly', 'true');
    const completed = await value();
    assert.equal(await deadQuote(), false);
    assert.equal(await input({ inputType: 'insertText', data: '¨' }), false);
    await editor.focus();
    await page.keyboard.press('Shift+Quote');
    assert.equal(await value(), completed);
    assert.deepEqual(errors, []);
    passed.push(`${browserType.name()}: all languages, actual typed Hello World execution and read-only session`);

    if (browserType === chromium) {
      // CodeMirror uses EditContext on Android. Its composition events target
      // that context, not contentDOM, so exercise this distinct native boundary.
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
        platform: 'Linux armv8l',
      });
      await page.reload();
      await expect(editor).toBeVisible();
      assert.equal(await editor.evaluate(element => !!element.editContext), true, 'This check must use an actual EditContext.');
      for (const physicalKey of ['Dead', 'Process']) {
        await editor.fill('');
        await page.waitForTimeout(550);
        await editor.evaluate(element => {
          const trace = window.quoteEditContextTrace = { ends: 0, nextComposing: null };
          element.editContext.addEventListener('compositionend', () => { trace.ends++; }, { once: true });
          const nextLetter = event => {
            if (event.key !== 'u') return;
            trace.nextComposing = event.isComposing;
            element.removeEventListener('keydown', nextLetter);
          };
          element.addEventListener('keydown', nextLetter);
        });
        await key({ key: physicalKey, code: 'Quote', shiftKey: true, keyCode: physicalKey === 'Process' ? 229 : 0 });
        await cdp.send('Input.imeSetComposition', { text: '¨', selectionStart: 1, selectionEnd: 1 });
        await expect.poll(value).toBe('"');
        await page.waitForTimeout(80);
        await page.keyboard.type('u');
        await expect.poll(value).toBe('"u');
        const composition = await editor.evaluate(element => ({
          ...window.quoteEditContextTrace,
          underlines: [...element.querySelectorAll('[style]')].filter(node => node.textContent && node.style.textDecoration.includes('underline')).map(node => node.textContent),
        }));
        assert.ok(composition.ends > 0, 'The browser must actually end the quote composition.');
        assert.equal(composition.nextComposing, false, 'The next real letter must start outside the IME.');
        assert.deepEqual(composition.underlines, [], 'A finished quote must not keep an IME underline.');
      }
      await editor.fill('');
      await page.waitForTimeout(150);
      await key({ key: 'Process', code: 'Quote', shiftKey: true, keyCode: 229 });
      await cdp.send('Input.imeSetComposition', { text: 'مرحبا', selectionStart: 5, selectionEnd: 5 });
      await cdp.send('Input.insertText', { text: 'مرحبا' });
      await expect.poll(value).toBe('مرحبا');
      await cdp.detach();
      assert.deepEqual(errors, []);
      passed.push('chromium: Android EditContext dead quotes, next-letter caret and genuine Arabic composition');
    }
    await context.close();
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: `test-results/labs-keyboard-${browserType.name()}-failure.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
    writeFileSync('test-results/labs-keyboard-browser-report.json', JSON.stringify({ passed }, null, 2));
  }
}
console.log(`PASS ${passed.length} keyboard regression groups`);
