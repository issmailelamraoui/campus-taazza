import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FILIERES_BY_FACULTY } from '../src/data/studies.js';
import {
  CHAT_BACKGROUND_THEMES,
  FACULTY_CHAT_BACKGROUNDS,
  FILIERE_CHAT_BACKGROUNDS,
  resolveChatBackground,
} from '../src/lib/chat-backgrounds.js';

const faculties = ['fsa', 'flaa', 'feg', 'fsjp'];
const yearChannels = ['year-1', 'year-3', 'year-5'];
const programs = Object.entries(FILIERES_BY_FACULTY)
  .flatMap(([facultyId, entries]) => entries.map(({ id }) => ({ facultyId, filiereId: id })));

function expectTheme(context, id, scope) {
  const result = resolveChatBackground(context);
  assert.equal(result.id, id, JSON.stringify(context));
  assert.equal(result.scope, scope, JSON.stringify(context));
  assert.equal(result.image, `/chat-backgrounds/${id}.svg`, JSON.stringify(context));
  return result;
}

test('every registered background ships a distinct lightweight self-contained SVG', async () => {
  const tiles = new Set();
  for (const { id, image } of Object.values(CHAT_BACKGROUND_THEMES)) {
    const svg = await readFile(new URL(`../public${image}`, import.meta.url), 'utf8');
    assert.ok(Buffer.byteLength(svg) < 16 * 1024, `${id}: wallpaper stays below 16 KB`);
    assert.match(svg, /<svg\b[^>]*viewBox="0 0 600 480"/, `${id}: consistent motif scale`);
    assert.doesNotMatch(svg, /<(script|image|foreignObject|text|animate|style)\b/i, `${id}: vector paths without runtime or font dependencies`);
    const symbols = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    for (const [, reference] of svg.matchAll(/\bhref="([^"]+)"/g)) {
      assert.ok(reference.startsWith('#') && symbols.has(reference.slice(1)), `${id}: internal, resolvable vector reference`);
    }
    assert.ok(!tiles.has(svg), `${id}: its own academic composition`);
    tiles.add(svg);
  }
});

test('the theme catalog covers every real faculty and academic program', () => {
  assert.ok(Object.hasOwn(CHAT_BACKGROUND_THEMES, 'academic'));
  for (const facultyId of faculties) {
    assert.ok(Object.hasOwn(FACULTY_CHAT_BACKGROUNDS, facultyId), `Missing faculty ${facultyId}`);
    assert.ok(Object.hasOwn(CHAT_BACKGROUND_THEMES, facultyId), `Missing faculty theme ${facultyId}`);
  }
  for (const { filiereId } of programs) {
    assert.ok(Object.hasOwn(FILIERE_CHAT_BACKGROUNDS, filiereId), `Missing program ${filiereId}`);
    assert.ok(Object.hasOwn(CHAT_BACKGROUND_THEMES, filiereId), `Missing program theme ${filiereId}`);
  }
});

test('faculty conversations keep the same background across all student programs', () => {
  for (const facultyId of faculties) {
    for (const channel of ['general', 'important']) {
      // A faculty conversation includes people from different programs. Its
      // identity must not depend on a sender or the first available message.
      for (const filiereId of [undefined, ...programs.map(program => program.filiereId)]) {
        expectTheme({ channel, facultyId, filiereId }, facultyId, 'faculty');
      }
    }
  }
});

test('each program has its own background in all three academic-year conversations', () => {
  for (const { facultyId, filiereId } of programs) {
    for (const channel of yearChannels) {
      expectTheme({ channel, facultyId, filiereId }, filiereId, 'filiere');
    }
  }
  const general = resolveChatBackground({ channel: 'general', facultyId: 'fsa', filiereId: 'data_science' });
  const program = resolveChatBackground({ channel: 'year-1', facultyId: 'fsa', filiereId: 'data_science' });
  assert.notEqual(general.image, program.image);
});

test('legacy chat links retain faculty versus program background selection', () => {
  for (const { facultyId, filiereId } of programs) {
    for (const channel of ['help', 'life']) {
      expectTheme({ channel, facultyId, filiereId }, facultyId, 'faculty');
    }
    for (const channel of ['filiere', ...[1, 2, 3, 4, 5, 6].map(semester => `semester-${semester}`)]) {
      expectTheme({ channel, facultyId, filiereId }, filiereId, 'filiere');
    }
  }
});

test('program metadata cannot borrow a theme from another faculty', () => {
  for (const { facultyId, filiereId } of programs) {
    for (const otherFaculty of faculties.filter(id => id !== facultyId)) {
      for (const channel of yearChannels) {
        expectTheme({ channel, facultyId: otherFaculty, filiereId }, otherFaculty, 'faculty');
      }
    }
  }
});

test('missing and future academic metadata falls back without guessing a program', () => {
  for (const channel of yearChannels) {
    for (const filiereId of [undefined, null, '', 'future_program']) {
      expectTheme({ channel, facultyId: 'fsa', filiereId }, 'fsa', 'faculty');
    }
  }
  for (const facultyId of [undefined, null, '', 'future_faculty']) {
    for (const channel of ['general', 'important', ...yearChannels]) {
      expectTheme({ channel, facultyId, filiereId: 'data_science' }, 'academic', 'academic');
    }
  }
});

test('unrecognized conversation types do not imply an academic scope', () => {
  for (const channel of [undefined, null, '', 'direct', 'year-2', 'year-0', 'semester-7', 'GENERAL', '__proto__', 'constructor', 'toString']) {
    expectTheme({ channel, facultyId: 'fsa', filiereId: 'data_science' }, 'academic', 'academic');
  }
});

test('prototype names and malformed identifiers cannot select inherited registry entries', () => {
  const invalidIds = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 1, true, {}, []];
  for (const facultyId of invalidIds) {
    expectTheme({ channel: 'year-1', facultyId, filiereId: 'data_science' }, 'academic', 'academic');
    expectTheme({ channel: 'general', facultyId, filiereId: 'data_science' }, 'academic', 'academic');
  }
  for (const filiereId of invalidIds) {
    expectTheme({ channel: 'year-1', facultyId: 'fsa', filiereId }, 'fsa', 'faculty');
  }
  for (const channel of [1, true, {}, []]) {
    expectTheme({ channel, facultyId: 'fsa', filiereId: 'data_science' }, 'academic', 'academic');
  }
});
