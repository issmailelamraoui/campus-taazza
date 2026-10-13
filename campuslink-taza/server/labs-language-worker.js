import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const grammarPaths = {
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  c: 'tree-sitter-c/tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp/tree-sitter-cpp.wasm',
};
const hash = value => createHash('sha256').update(value).digest('hex');
let parser, tree;
try {
  const { language, source, limits } = workerData;
  if (!Object.hasOwn(grammarPaths, language)) throw new Error('Unsupported grammar');
  // A V8 heap limit does not constrain WebAssembly memory. Set its maximum
  // separately so a malformed parse cannot grow an unbounded external heap.
  await Parser.init({ wasmMemory: new WebAssembly.Memory({ initial: 512, maximum: limits.wasmMb * 16 }) });
  const grammar = await Language.load(require.resolve(grammarPaths[language]));
  parser = new Parser();
  parser.setLanguage(grammar);
  const deadline = Date.now() + 1500;
  tree = parser.parse(source, null, { progressCallback: () => Date.now() >= deadline });
  if (!tree) throw new Error('Parsing deadline exceeded');
  const diagnostics = [];
  const lines = language === 'python' ? source.split('\n') : null;
  // The editor grammar allows an empty Python suite while a student is typing.
  // A completed syntax check requires a statement in that suite. Top-level
  // statements also cannot begin with an indentation token.
  if (language === 'python') {
    for (const node of tree.rootNode.namedChildren) {
      if (node.type !== 'comment' && node.startPosition.column > 0 && /^[\t\f ]*$/.test(lines[node.startPosition.row].slice(0, node.startPosition.column))) {
        diagnostics.push({ message: 'Indentation inattendue en dehors d’un bloc.', line: node.startPosition.row + 1, column: node.startPosition.column + 1 });
        if (diagnostics.length >= limits.maximumDiagnostics) break;
      }
    }
  }
  const pending = [tree.rootNode];
  while (pending.length && diagnostics.length < limits.maximumDiagnostics) {
    const node = pending.pop();
    if (node.isError || node.isMissing) {
      diagnostics.push({
        message: node.isMissing ? `Élément attendu : ${node.type}.` : `Syntaxe invalide près de « ${node.text.replace(/\s+/g, ' ').slice(0, 60)} ».`,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
      });
    } else if (language === 'python' && node.type === 'block' && node.namedChildCount === 0) {
      diagnostics.push({ message: 'Bloc indenté attendu après « : ».', line: node.startPosition.row + 2, column: 1 });
    } else if (node.hasError || language === 'python') {
      for (let index = node.childCount - 1; index >= 0; index--) pending.push(node.child(index));
    }
  }
  if (tree.rootNode.hasError && !diagnostics.length) throw new Error('Parser error without a diagnostic');
  parentPort.postMessage(diagnostics.length ? {
    status: 'syntax_error', diagnostics, eligiblePractice: false,
    errorFingerprint: hash(`${language}:${diagnostics.map(item => `${item.message}:${item.line}`).join('|')}`),
  } : {
    status: 'valid_syntax', diagnostics: [], eligiblePractice: false,
    fingerprint: hash(`${language}:${source.trim()}`),
  });
} catch {
  parentPort.postMessage({ status: 'validation_unavailable', diagnostics: [{ message: 'Le service de validation est temporairement indisponible. Réessayez.' }], eligiblePractice: false });
} finally {
  tree?.delete();
  parser?.delete();
}
