import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
// Clang returns both linked bytes and an already compiled Module. This probe
// catches execution accidentally preferring that original, unbounded Module
// over the program bytes that Campus Labs limits before instantiation.
const source = '#include <stdio.h>\nint main(void) {\n'
  + '  unsigned long before = __builtin_wasm_memory_size(0);\n'
  + '  int growth = (int)__builtin_wasm_memory_grow(0, 2048);\n'
  + '  unsigned long after = __builtin_wasm_memory_size(0);\n'
  + '  printf("before=%lu grow=%d after=%lu\\n", before, growth, after);\n'
  + '  return 0;\n}\n';

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL + '/labs-runtime/NOTICE.txt');
  for (const language of ['c', 'cpp']) {
    const output = await page.evaluate(async ({ language, source }) => {
      const { runLabCode } = await import('/src/lib/labs-runner.js');
      const events = [];
      const result = await runLabCode(language, source, { onEvent: event => events.push(event) });
      return { result, events };
    }, { language, source });
    assert.equal(output.result.status, 'success', JSON.stringify(output));
    const stdout = output.events.filter(event => event.stream === 'stdout').map(event => event.text).join('');
    const memory = /^before=(\d+) grow=(-?\d+) after=(\d+)\n$/.exec(stdout);
    assert.ok(memory, `The compiled program must actually execute and print its memory sizes: ${stdout}`);
    assert.equal(Number(memory[2]), -1, `${language}: growing by 128 MB must fail inside WASM`);
    assert.equal(Number(memory[3]), Number(memory[1]), `${language}: failed growth leaves memory unchanged`);
    assert.ok(Number(memory[3]) <= 2048, `${language}: program memory remains within 128 MB`);
    assert.equal(output.events.some(event => event.stream === 'stderr'), false, JSON.stringify(output));
    await expect.poll(() => page.workers().length).toBe(0);
    console.log(`PASS ${language}: the executed program enforces the patched 128 MB memory ceiling`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
