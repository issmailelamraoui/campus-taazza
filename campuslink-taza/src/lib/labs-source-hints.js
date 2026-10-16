import { javascriptLanguage } from '@codemirror/lang-javascript';
import { jsonLanguage } from '@codemirror/lang-json';
import { pythonLanguage } from '@codemirror/lang-python';
import { cppLanguage } from '@codemirror/lang-cpp';

const grammars = { javascript: javascriptLanguage, json: jsonLanguage, python: pythonLanguage, c: cppLanguage, cpp: cppLanguage };
const quotation = {
  '¨': ['¨', '"'], '“': ['”', '"'], '„': ['“', '"'], '«': ['»', '"'],
  '‘': ['’', "'"], '＂': ['＂', '"'],
};
const unusualQuotes = /[¨“”„«»‘’＂]/gu;

// These are suggestions, never a preprocessing step for execution. Preserve
// punctuation inside genuine strings, comments, regexes and template strings.
export function quotationHint(language, source) {
  if (!grammars[language] || typeof source !== 'string' || source.length > 16000 || !/[¨“”„«»‘’＂]/u.test(source)) return null;
  const ignored = [];
  grammars[language].parser.parse(source).iterate({ enter(node) {
    if (/String|Comment|RegExp|CharLiteral|CharacterLiteral/.test(node.name)) { ignored.push([node.from, node.to]); return false; }
  } });
  const candidates = [...source.matchAll(unusualQuotes)].filter(match => !ignored.some(([from, to]) => match.index >= from && match.index < to));
  if (!candidates.length) return null;
  const changes = new Map();
  for (let index = 0; index < candidates.length; index++) {
    const start = candidates[index], rule = quotation[start[0]], end = candidates[index + 1];
    if (!rule || !end || end[0] !== rule[0]) continue;
    const delimiter = language === 'json' ? '"' : rule[1], content = source.slice(start.index + 1, end.index);
    // Ambiguous or multiline text needs an ordinary edit. Do not guess how to
    // escape its content or change the semantics of the student's program.
    if (/[\r\n]/.test(content) || content.includes(delimiter)) continue;
    changes.set(start.index, delimiter); changes.set(end.index, delimiter); index++;
  }
  const before = source.slice(0, candidates[0].index).split('\n');
  const complete = changes.size === candidates.length;
  return {
    characters: [...new Set(candidates.map(match => match[0]))],
    line: before.length, column: before.at(-1).length + 1,
    correctedSource: complete ? source.split('').map((value, index) => changes.get(index) ?? value).join('') : null,
  };
}
