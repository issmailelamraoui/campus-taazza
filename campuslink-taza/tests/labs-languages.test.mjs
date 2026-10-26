import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateLabSource, LABS_LANGUAGES } from '../server/labs.js';
import { validateAdditionalLabSource, LABS_VALIDATOR_LIMITS } from '../server/labs-language-validator.js';

const programs = {
  python: 'def moyenne(valeurs):\n    total = 0\n    for valeur in valeurs:\n        total += valeur\n    return total / len(valeurs) if valeurs else 0\n',
  c: '#include <stdio.h>\nint main(void) {\n    int total = 0;\n    for (int i = 0; i < 5; i++) total += i;\n    printf("%d\\n", total);\n    return 0;\n}\n',
  cpp: '#include <vector>\n#include <iostream>\nint main() {\n    std::vector<int> valeurs{1, 2, 3};\n    int total = 0;\n    for (const auto valeur : valeurs) total += valeur;\n    std::cout << total << std::endl;\n    return 0;\n}\n',
};
const errors = {
  python: 'valeur = 1\nif valeur > 0\n    print(valeur)\n',
  c: 'int main(void) {\n int valeur = ;\n return valeur;\n}\n',
  cpp: 'int main() {\n auto valeur = ;\n return valeur;\n}\n',
};

for (const language of Object.keys(programs)) {
  test(`${language} uses its real grammar and reports localized syntax errors`, async () => {
    assert.ok(LABS_LANGUAGES.includes(language));
    const good = await validateLabSource(language, programs[language]);
    assert.equal(good.status, 'valid_syntax');
    assert.deepEqual(good.diagnostics, []);
    assert.equal(good.eligiblePractice, false);
    assert.match(good.fingerprint, /^[a-f0-9]{64}$/);
    const bad = await validateLabSource(language, errors[language]);
    assert.equal(bad.status, 'syntax_error', JSON.stringify(bad));
    assert.ok(bad.diagnostics.length > 0);
    assert.ok(bad.diagnostics[0].line >= 2);
    assert.ok(bad.diagnostics[0].column >= 1);
    assert.equal(bad.eligiblePractice, false);
  });
}

test('Python grammar checks incomplete suites and top-level indentation without rejecting multiline expressions', async () => {
  for (const source of ['if True:\nprint("wrong indentation")\n', 'def example():\n    # only a comment\nprint(1)\n', '  print(1)\n']) {
    const result = await validateLabSource('python', source);
    assert.equal(result.status, 'syntax_error', JSON.stringify(result));
    assert.match(result.diagnostics[0].message, /[Ii]ndent/);
  }
  for (const source of ['valeur = (\n    1 + 2\n)\n', 'x = 1; y = 2\n', 'if True:\n    pass\n', '# un commentaire\nprint(1)\n']) assert.equal((await validateLabSource('python', source)).status, 'valid_syntax', source);
});

test('parsing never imports Python source, opens C includes, or executes any program', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'campuslink-labs-noexec-'));
  const marker = join(directory, 'executed');
  // Use a portable header-name token, rather than Windows-native backslashes
  // that the C/C++ grammar interprets as part of malformed include syntax.
  const missingHeader = join(directory, 'nonexistent-secret.h').replaceAll('\\', '/');
  try {
    const python = await validateLabSource('python', `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\nwhile True:\n    pass\n`);
    assert.equal(python.status, 'valid_syntax');
    assert.equal(existsSync(marker), false);
    for (const language of ['c', 'cpp']) {
      const result = await validateLabSource(language, `#include "${missingHeader}"\nint main() { while (1) {} return 0; }\n`);
      // Includes are syntax tokens. These are not successful compilation claims.
      assert.equal(result.status, 'valid_syntax');
      assert.equal(existsSync(marker), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source bounds reject malformed requests before starting any parser worker', async () => {
  for (const language of ['python', 'c', 'cpp']) {
    for (const source of ['', null, 'x'.repeat(LABS_VALIDATOR_LIMITS.maximumSourceBytes + 1), '\0']) await assert.rejects(() => validateAdditionalLabSource(language, source), error => error.status === 400);
  }
  await assert.rejects(() => validateAdditionalLabSource('../../package.json', 'code'), error => error.status === 400);
});

test('concurrent checks are capped, recover after completion, and bound diagnostics', async () => {
  const first = validateLabSource('python', programs.python);
  const second = validateLabSource('c', programs.c);
  const overloaded = await validateLabSource('cpp', programs.cpp);
  assert.equal(overloaded.status, 'validation_unavailable');
  assert.equal(overloaded.eligiblePractice, false);
  const results = await Promise.all([first, second]);
  for (const result of results) assert.equal(result.status, 'valid_syntax');
  assert.equal((await validateLabSource('cpp', programs.cpp)).status, 'valid_syntax');
  const malformed = await validateLabSource('c', 'int x = ;\n'.repeat(500));
  assert.equal(malformed.status, 'syntax_error');
  assert.ok(malformed.diagnostics.length <= LABS_VALIDATOR_LIMITS.maximumDiagnostics);
});
