import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const baseURL = process.env.CAMPUSLINK_TEST_URL || 'http://127.0.0.1:5180';
const browserType = process.env.CAMPUS_TEST_BROWSER === 'firefox' ? firefox : chromium;
const browser = await browserType.launch({ headless: true, ...(browserType === chromium ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const passed = [];
const programs = {
  javascript: 'console.log(Number(prompt()) + 1); console.error("stderr-javascript");',
  python: 'import sys\nprint(int(input()) + 1)\nprint("stderr-python", file=sys.stderr)\n',
  c: '#include <stdio.h>\nint main(void) { int n; scanf("%d", &n); printf("%d\\n", n + 1); fprintf(stderr, "stderr-c\\n"); return 0; }',
  cpp: '#include <iostream>\n#include <vector>\nclass Student { public: int score; Student(int n):score(n){} };\nint main() { int n; std::cin >> n; std::vector<Student> students{Student(n), Student(1)}; std::cout << students[0].score + students[1].score << "\\n"; std::cerr << "stderr-cpp\\n"; }',
};
const broken = { javascript: 'await Promise.reject(new Error("runtime-js"))', python: 'print(1 / 0)', c: 'int main(void) { missing(); }', cpp: 'int main() { unknown_property.run(); }' };
const loops = { javascript: 'while (true) {}', python: 'while True:\n    pass', c: 'int main(void) { while (1) {} }', cpp: 'int main() { while (true) {} }' };
try {
  const page = await browser.newPage();
  // A plain static document keeps this execution suite independent of accounts
  // and API traffic; every runtime still runs as an actual browser Worker.
  await page.goto(baseURL + '/labs-runtime/NOTICE.txt');
  let privilegedRequests = 0;
  await page.context().route('**/api/session', route => { privilegedRequests++; return route.fulfill({ json: { private: true } }); });
  const run = (language, source, options = {}) => page.evaluate(async ({ language, source, options }) => {
    const { runLabCode } = await import('/src/lib/labs-runner.js');
    const events = [], started = performance.now();
    const result = await runLabCode(language, source, { ...options, onEvent: event => events.push(event) });
    return { result, events, elapsedMs: performance.now() - started };
  }, { language, source, options });
  for (const [language, source] of Object.entries(programs)) {
    const output = await run(language, source, { input: '41\n' });
    assert.equal(output.result.status, 'success', JSON.stringify(output));
    assert.equal(output.result.exitCode, 0);
    assert.match(output.events.filter(event => event.stream === 'stdout').map(event => event.text).join(''), /42/);
    assert.match(output.events.filter(event => event.stream === 'stderr').map(event => event.text).join(''), new RegExp(`stderr-${language}`));
    passed.push(`${language}: real execution with stdin, stdout and stderr`);
    console.log('PASS ' + passed.at(-1));
    const error = await run(language, broken[language]);
    assert.equal(error.result.status, 'error', JSON.stringify(error));
    assert.ok(error.events.some(event => event.stream === 'stderr' && event.text.trim()));
    passed.push(`${language}: runtime or compiler errors reach the console`);
    const timeout = await run(language, loops[language], { executionMs: 400 });
    assert.equal(timeout.result.status, 'timeout', JSON.stringify(timeout));
    assert.ok(timeout.elapsedMs < 45000, 'An infinite loop must terminate without blocking the page.');
    assert.equal(await page.evaluate(() => 6 * 7), 42);
    passed.push(`${language}: infinite loop terminated; page remains responsive`);
    console.log('PASS ' + passed.at(-1));
  }
  const primitives = await run('javascript', 'console.log(123n, undefined, null, NaN, Infinity);');
  assert.equal(primitives.result.status, 'success', JSON.stringify(primitives));
  assert.equal(primitives.events.filter(event => event.stream === 'stdout').map(event => event.text).join(''), '123n undefined null NaN Infinity\n');
  passed.push('JavaScript console preserves BigInt, undefined and non-finite numeric values');
  const json = await run('json', '{"module":"Analyse","chapitres":[1,2]}');
  assert.equal(json.result.status, 'success');
  assert.match(json.events.find(event => event.stream === 'stdout').text, /\n  "module": "Analyse"/);
  assert.equal((await run('json', '{"invalid":}')).result.status, 'error');
  passed.push('JSON is validated and formatted as data');
  const scope = await run('python', 'import js\nprint(hasattr(js, "fetch"))\nprint(hasattr(js, "indexedDB"))');
  assert.equal(scope.result.status, 'success');
  assert.equal(scope.events.filter(event => event.stream === 'stdout').map(event => event.text).join(''), 'False\nFalse\n');
  passed.push('Python receives no browser-global bridge');
  const apiRequestProbe = `return (async () => { try { await fetch(${JSON.stringify(new URL('/api/session', baseURL).href)}, { credentials: 'include' }); return false; } catch (error) { return true; } })()`;
  const privateRealm = await run('python', `from pyodide.ffi import to_js
construct = to_js([]).constructor.constructor
print(construct('return self.origin')())
print(construct('try { indexedDB.open("campus-labs-privacy-probe"); return false; } catch (error) { return error.name === "SecurityError"; }')())
print(await construct('return (async () => { try { if (typeof cookieStore === "undefined") return true; await cookieStore.getAll(); return false; } catch (error) { return true; } })()')())
print(await construct(${JSON.stringify(apiRequestProbe)})())
`);
  assert.equal(privateRealm.result.status, 'success', JSON.stringify(privateRealm));
  const realmText = privateRealm.events.filter(event => event.stream === 'stdout').map(event => event.text).join('');
  assert.equal(realmText, 'null\nTrue\nTrue\nTrue\n');
  assert.equal(privilegedRequests, 0, 'Opaque Python Workers cannot send authenticated API requests.');
  assert.equal(await page.locator('iframe[sandbox="allow-scripts"]').count(), 0, 'Completed Python runs dispose their opaque frame and Worker.');
  await expect.poll(() => page.workers().length).toBe(0);
  passed.push('Python ffi remains in an opaque origin and cannot access application IndexedDB, cookies or APIs');
  const forged = await run('python', `from pyodide.ffi import to_js
to_js([]).constructor.constructor('self.postMessage({type:"done",result:{status:"success"}}); self.postMessage({type:"phase",phase:"loading"});')()
while True:
    pass`, { executionMs: 400 });
  assert.equal(forged.result.status, 'timeout', JSON.stringify(forged));
  assert.ok(forged.elapsedMs < 15000, 'Forged phase events cannot extend the execution deadline.');
  passed.push('Python cannot forge successful completion or extend its execution deadline');
  const stopped = await page.evaluate(async () => {
    const { runLabCode } = await import('/src/lib/labs-runner.js');
    const controller = new AbortController(); setTimeout(() => controller.abort(), 100);
    return runLabCode('javascript', 'while (true) {}', { signal: controller.signal });
  });
  assert.equal(stopped.status, 'stopped');
  passed.push('Stop cancels loading or execution and disposes its Worker');
  const stoppedPython = await page.evaluate(async () => {
    const { runLabCode } = await import('/src/lib/labs-runner.js');
    const controller = new AbortController();
    return runLabCode('python', 'while True:\n    pass', { signal: controller.signal, onEvent: event => { if (event.type === 'phase' && event.phase === 'running') setTimeout(() => controller.abort(), 100); } });
  });
  assert.equal(stoppedPython.status, 'stopped');
  assert.equal(await page.locator('iframe[sandbox="allow-scripts"]').count(), 0);
  await expect.poll(() => page.workers().length).toBe(0);
  assert.equal(await page.evaluate(() => 6 * 7), 42);
  passed.push('Stopping executing Python removes its frame and Worker without blocking the page');
  const workerRoute = '**/labs-runtime/runner.js?*';
  await page.context().route(workerRoute, async route => {
    const response = await route.fetch();
    assert.match(response.headers()['content-security-policy'], /connect-src .*\/labs-runtime\//);
    const probe = `\nconst campusOriginalHandler = self.onmessage; self.onmessage = async event => { const results = await Promise.all([fetch('/api/session').then(() => false, () => true), fetch('/labs-runtime/python/pyodide-lock.json').then(response => response.ok, () => false)]); self.postMessage({token:event.data.token,type:'policy-probe',apiBlocked:results[0],runtimeAllowed:results[1]}); return campusOriginalHandler(event); };`;
    await route.fulfill({ response, body: await response.text() + probe });
  });
  const policy = await run('javascript', 'console.log("policy-ok")');
  assert.equal(policy.result.status, 'success', JSON.stringify(policy));
  assert.deepEqual(policy.events.find(event => event.type === 'policy-probe'), { type: 'policy-probe', apiBlocked: true, runtimeAllowed: true });
  assert.equal(privilegedRequests, 0, 'Worker CSP must block the API before a request leaves the worker.');
  await page.context().unroute(workerRoute);
  passed.push('Deployment Worker CSP blocks authenticated API fetches while allowing runtime asset fetches');
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/labs-runtime-browser-report.json', JSON.stringify({ passed }, null, 2));
  writeFileSync(`test-results/labs-runtime-browser-${browserType.name()}.json`, JSON.stringify({ passed }, null, 2));
  console.log(`PASS ${passed.length} runtime checks (${browserType.name()})`);
} finally { await browser.close(); }
