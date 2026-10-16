import test from 'node:test';
import assert from 'node:assert/strict';
import { quotationHint } from '../src/lib/labs-source-hints.js';
import { validateLabSource } from '../server/labs.js';

const programs = {
  javascript: ['console.log(¨ hello world !! ¨);', 'console.log(" hello world !! ");'],
  python: ['print(“hello world !!”)', 'print("hello world !!")'],
  c: ['#include <stdio.h>\nint main(void) { printf(«hello world !!»); return 0; }', '#include <stdio.h>\nint main(void) { printf("hello world !!"); return 0; }'],
  cpp: ['#include <iostream>\nint main() { std::cout << “hello world !!”; }', '#include <iostream>\nint main() { std::cout << "hello world !!"; }'],
  json: ['{“message”: “hello world !!”}', '{"message": "hello world !!"}'],
};

test('each supported language offers an explicit quote-only correction that its real syntax checker accepts', async () => {
  for (const [language, [source, expected]] of Object.entries(programs)) {
    const hint = quotationHint(language, source);
    assert.equal(hint.correctedSource, expected, language);
    assert.equal(source, programs[language][0], 'Suggestions must not mutate student source.');
    assert.equal((await validateLabSource(language, expected)).status, 'valid_syntax', language);
    assert.equal(quotationHint(language, expected), null);
  }
});

test('ordinary punctuation inside strings, comments, templates, regexes and raw strings is preserved', () => {
  const valid = {
    javascript: 'const text = "Il dit « salut » et ¨"; const pattern = /¨[“”]/u; console.log(`« texte »`); // “commentaire”\n/* ¨commentaire¨ */',
    python: 'text = "« salut » ¨"\nprint("""‘été’ et “texte”""") # ¨commentaire¨',
    c: '#include <stdio.h>\nint main(void) { puts("« salut » ¨"); return 0; } /* “commentaire” */',
    cpp: '#include <iostream>\nint main() { std::cout << R"tag(« salut » ¨ “texte”)tag"; } // ‘commentaire’',
    json: '{"message": "« salut » ¨ ‘été’"}',
  };
  for (const [language, source] of Object.entries(valid)) assert.equal(quotationHint(language, source), null, language);
});

test('UTF-16 editor positions preserve emoji, accented text, Arabic and exact whitespace', () => {
  const source = '// 🧪 un essai\nconsole.log(¨  مرحبا, été 😀  ¨);';
  const hint = quotationHint('javascript', source);
  assert.equal(hint.line, 2); assert.equal(hint.column, 13);
  assert.equal(hint.correctedSource, '// 🧪 un essai\nconsole.log("  مرحبا, été 😀  ");');
});

test('ambiguous, unbalanced or multiline quotation marks are explained without a guessed edit', () => {
  for (const source of ['console.log(¨hello);', 'console.log(¨hello\nworld¨);', 'console.log(¨say "hello"¨);']) {
    const hint = quotationHint('javascript', source);
    assert.ok(hint); assert.equal(hint.correctedSource, null, source);
  }
});

test('unsupported languages and oversized source do not produce correction suggestions', () => {
  assert.equal(quotationHint('unknown', 'print(¨hello¨)'), null);
  assert.equal(quotationHint('javascript', ' '.repeat(16001) + 'console.log(¨hello¨)'), null);
});
