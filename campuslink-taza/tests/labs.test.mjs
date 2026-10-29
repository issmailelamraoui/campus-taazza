import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLabSource, practiceEligibility, LABS_POLICY } from '../server/labs.js';
import { parseMathExpression, evaluateMath, sampleGraph } from '../shared/math.js';
const substantial = 'export function moyenne(valeurs) { let total = 0; for (const valeur of valeurs) { total += valeur; } return valeurs.length ? total / valeurs.length : 0; }';

test('real JavaScript parser distinguishes syntax errors with locations and never executes source', () => {
  const invalid = validateLabSource('javascript', 'const bon = 1;\nconst mauvais = ;');
  assert.equal(invalid.status, 'syntax_error');
  assert.equal(invalid.diagnostics[0].line, 2);
  assert.ok(invalid.diagnostics[0].column > 1);
  assert.equal(validateLabSource('javascript', substantial).status, 'valid_syntax');
  assert.equal(validateLabSource('javascript', substantial).eligiblePractice, true);
  assert.equal(validateLabSource('javascript', 'let x = 1').eligiblePractice, false);
  delete globalThis.labsExecuted;
  assert.equal(validateLabSource('javascript', 'globalThis.labsExecuted = true; while (true) {}').status, 'valid_syntax');
  assert.equal(globalThis.labsExecuted, undefined);
});
test('JSON is actually parsed without earning code XP; unsupported compilers and oversized source fail honestly', () => {
  assert.equal(validateLabSource('json', '{"cours":[1,2,3]}').status, 'valid_syntax');
  assert.equal(validateLabSource('json', '{"cours":}').status, 'syntax_error');
  assert.equal(validateLabSource('json', '{"cours":[1,2,3]}').eligiblePractice, false);
  for (const language of ['ruby', 'html', 'css']) assert.throws(() => validateLabSource(language, 'code'), error => error.status === 503);
  for (const source of ['', 'x'.repeat(LABS_POLICY.maximumSourceBytes + 1), 'const x="\0"']) assert.throws(() => validateLabSource('javascript', source), error => error.status === 400);
});
test('normalized program fingerprints deduplicate spacing, comments, renamed identifiers and changed constants', () => {
  const first = validateLabSource('javascript', substantial);
  const variant = validateLabSource('javascript', substantial.replaceAll('moyenne', 'average').replaceAll('valeurs', 'values').replaceAll('total', 'sum').replaceAll('0', '10') + '\n// autre promotion');
  assert.equal(first.fingerprint, variant.fingerprint);
  assert.notEqual(first.fingerprint, validateLabSource('javascript', 'function addition(a,b) { return a + b; }').fingerprint);
});
test('practice eligibility requires voluntary substantial revised activity and only affects session potential', () => {
  const session = { language: 'javascript', voluntary_xp: true, potential: 8, revisions: 2, last_result: validateLabSource('javascript', substantial), created_at: new Date(Date.now() - 100000).toISOString() };
  assert.equal(practiceEligibility(session), null);
  assert.equal(practiceEligibility({ ...session, potential: 0 }), 'potential_exhausted');
  assert.equal(practiceEligibility({ ...session, voluntary_xp: false }), 'practice_not_enabled');
  assert.equal(practiceEligibility({ ...session, revisions: 1 }), 'more_practice_required');
  assert.equal(practiceEligibility({ ...session, created_at: new Date().toISOString() }), 'more_practice_required');
  assert.equal(practiceEligibility({ ...session, last_result: { status: 'validation_unavailable' } }), 'valid_substantial_program_required');
});
test('deterministic graph grammar applies power and unary precedence with real functions', () => {
  const calc = text => evaluateMath(parseMathExpression(text), 2);
  assert.equal(calc('x^3 + 2*x - 1'), 11);
  assert.equal(calc('-2^2'), -4);
  assert.equal(calc('2^3^2'), 512);
  assert.equal(calc('sqrt(9) + abs(-2)'), 5);
  assert.ok(Math.abs(calc('sin(pi/2)') - 1) < 1e-10);
  assert.equal(calc('1e2 / 2'), 50);
  assert.equal(calc('x − 1'), 1);
});
test('graph expressions cannot access globals, execute functions or exhaust recursive parsing', () => {
  for (const text of ['window.alert(1)', 'process.exit()', 'x.constructor', 'sin.constructor(1)', 'eval(x)', 'x;alert(1)', '(()=>1)()', 'x[0]', '__proto__', 'sin(1,2)', '('.repeat(40) + 'x' + ')'.repeat(40), '-'.repeat(40) + 'x', '1'.repeat(257)]) assert.throws(() => parseMathExpression(text));
});
test('graphs preserve discontinuities and cap sample count and axis ranges', () => {
  const points = sampleGraph('1/x', -1, 1, 21);
  assert.equal(points[10].y, null);
  assert.equal(sampleGraph('sqrt(x)', -1, 1, 21)[0].y, null);
  assert.equal(points.length, 21);
  assert.throws(() => sampleGraph('x', 1, -1));
  assert.throws(() => sampleGraph('x', -1, 1, 1001));
  assert.throws(() => sampleGraph('x', -Infinity, 1));
});
