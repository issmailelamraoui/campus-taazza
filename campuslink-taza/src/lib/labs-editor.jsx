import React, { memo, useEffect, useId, useRef, useState } from 'react';
import { Search, WrapText } from 'lucide-react';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { EditorView, ViewPlugin, Decoration, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, dropCursor, tooltips } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, temporarilySetTabFocusMode, isolateHistory } from '@codemirror/commands';
import { syntaxTree, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { autocompletion, completeFromList, closeCompletion, clearSnippet } from '@codemirror/autocomplete';
import { search, searchKeymap, openSearchPanel, closeSearchPanel, highlightSelectionMatches } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { tags } from '@lezer/highlight';
import { programmingQuotes } from './labs-keyboard.js';

const cWords = 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while';
const cppWords = 'alignas alignof bool catch class constexpr decltype delete explicit false friend mutable namespace new noexcept nullptr operator private protected public static_cast template this throw true try typename using virtual';
const languageCache = new Map();
function syntax(language) {
  if (languageCache.has(language)) return languageCache.get(language);
  const support = ({ javascript, json, python, c: cpp, cpp }[language] || javascript)();
  const extensions = [support];
  if (['c', 'cpp', 'json'].includes(language)) {
    const words = language === 'json' ? 'true false null' : `${cWords} ${language === 'cpp' ? cppWords : ''}`;
    const complete = completeFromList(words.trim().split(/\s+/).map(label => ({ label, type: 'keyword' })));
    extensions.push(support.language.data.of({ autocomplete: context => {
      if (/String|Comment|CharLiteral/.test(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null;
      return complete(context);
    } }));
  }
  languageCache.set(language, extensions);
  return extensions;
}

const colors = HighlightStyle.define([
  { tag: tags.keyword, class: 'labs-token-keyword' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: 'labs-token-function' },
  { tag: [tags.definition(tags.variableName), tags.variableName], class: 'labs-token-variable' },
  { tag: [tags.propertyName, tags.attributeName], class: 'labs-token-property' },
  { tag: [tags.className, tags.typeName, tags.namespace], class: 'labs-token-class' },
  { tag: [tags.string, tags.character], class: 'labs-token-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'labs-token-number' },
  { tag: [tags.comment, tags.meta], class: 'labs-token-comment' },
  { tag: [tags.operator, tags.punctuation], class: 'labs-token-operator' },
]);

const semanticMarks = {
  function: Decoration.mark({ class: 'labs-semantic-function' }),
  class: Decoration.mark({ class: 'labs-semantic-class' }),
};
// Keep declaration colors consistent with calls. Only inspect visible ranges:
// scanning the entire tree on each keystroke defeats editor virtualization.
const declarations = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = this.build(update.view);
  }
  build(view) {
    const marks = [], seen = new Set(), tree = syntaxTree(view.state);
    for (const { from, to } of view.visibleRanges) tree.iterate({ from, to, enter(cursor) {
      const node = cursor.node, parent = node.parent?.name;
      let type;
      if ((node.name === 'VariableDefinition' && parent === 'FunctionDeclaration') || (node.name === 'VariableName' && parent === 'FunctionDefinition') || (['Identifier', 'FieldIdentifier'].includes(node.name) && parent === 'FunctionDeclarator') || (node.name === 'PropertyDefinition' && parent === 'MethodDeclaration')) type = 'function';
      if ((node.name === 'VariableDefinition' && parent === 'ClassDeclaration') || (node.name === 'VariableName' && parent === 'ClassDefinition')) type = 'class';
      if (node.name === 'VariableDefinition' && parent === 'VariableDeclaration' && ['ArrowFunction', 'FunctionExpression'].includes(node.nextSibling?.nextSibling?.name)) type = 'function';
      const key = `${node.from}:${node.to}`;
      if (type && !seen.has(key) && node.to > from && node.from < to) {
        seen.add(key);
        marks.push(semanticMarks[type].range(node.from, node.to));
      }
    } });
    return Decoration.set(marks, true);
  }
}, { decorations: plugin => plugin.decorations });

const phrases = {
  fr: { Find: 'Rechercher', Replace: 'Remplacer', next: 'suivant', previous: 'précédent', all: 'tout sélectionner', 'match case': 'respecter la casse', regexp: 'expression régulière', 'by word': 'mot entier', replace: 'remplacer', 'replace all': 'tout remplacer', close: 'Fermer', 'Fold line': 'Replier le bloc', 'Unfold line': 'Déplier le bloc', unfold: 'Déplier', 'folded code': 'Code replié', 'Go to line': 'Aller à la ligne', go: 'Aller' },
  ar: { Find: 'بحث', Replace: 'استبدال', next: 'التالي', previous: 'السابق', all: 'تحديد الكل', 'match case': 'مطابقة حالة الأحرف', regexp: 'تعبير نمطي', 'by word': 'كلمة كاملة', replace: 'استبدال', 'replace all': 'استبدال الكل', close: 'إغلاق', 'Fold line': 'طيّ المقطع', 'Unfold line': 'فتح المقطع', unfold: 'فتح', 'folded code': 'شيفرة مطوية', 'Go to line': 'الانتقال إلى السطر', go: 'انتقال' },
};
const ui = {
  fr: { find: 'Rechercher / remplacer', wrap: 'Retour à la ligne', line: 'L', column: 'Col', lines: 'lignes', escape: 'Échap puis Tab pour quitter l’éditeur.' },
  en: { find: 'Find / replace', wrap: 'Wrap lines', line: 'Ln', column: 'Col', lines: 'lines', escape: 'Press Escape, then Tab to leave the editor.' },
  ar: { find: 'بحث واستبدال', wrap: 'التفاف الأسطر', line: 'سطر', column: 'عمود', lines: 'أسطر', escape: 'اضغط Escape ثم Tab للخروج من المحرّر.' },
};
const contentAttributes = (label, hint, disabled) => ({ 'aria-label': label, 'aria-describedby': hint, 'aria-multiline': 'true', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', dir: 'ltr', ...(disabled ? { tabindex: '0' } : {}) });
const enabled = disabled => [EditorState.readOnly.of(!!disabled), EditorView.editable.of(!disabled)];

export const LabsEditor = memo(function LabsEditor({ initialValue, replacement, onReplacementApplied, onChange, language, disabled, label, onRun, uiLanguage = 'fr' }) {
  const host = useRef(null), view = useRef(null), callback = useRef(onChange), run = useRef(onRun);
  const hintId = useId();
  const [wrap, setWrap] = useState(true);
  const [position, setPosition] = useState({ line: 1, column: 1, lines: 1 });
  const config = useRef({ language: new Compartment(), enabled: new Compartment(), attributes: new Compartment(), phrases: new Compartment(), wrap: new Compartment() });
  const words = ui[uiLanguage] || ui.en;
  callback.current = onChange; run.current = onRun;
  useEffect(() => {
    const configuration = config.current;
    function report(state) {
      const at = state.selection.main.head, line = state.doc.lineAt(at);
      setPosition(previous => previous.line === line.number && previous.column === at - line.from + 1 && previous.lines === state.doc.lines ? previous : { line: line.number, column: at - line.from + 1, lines: state.doc.lines });
    }
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: initialValue, extensions: [
      lineNumbers(), foldGutter(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(), dropCursor(), highlightSpecialChars(), history(), bracketMatching(), indentOnInput(), declarations, programmingQuotes,
      search({ top: true }), highlightSelectionMatches({ minSelectionLength: 2, maxMatches: 100 }),
      autocompletion({ activateOnTypingDelay: 180, selectOnOpen: false, maxRenderedOptions: 30, tooltipClass: () => 'labs-completion-tooltip' }),
      tooltips({ parent: document.body }),
      Prec.highest(keymap.of([{ key: 'Escape', run: editor => {
        closeCompletion(editor); clearSnippet(editor); closeSearchPanel(editor);
        return temporarilySetTabFocusMode(editor);
      } }])),
      keymap.of([{ key: 'Mod-Enter', run: () => { run.current?.(); return true; } }, ...searchKeymap, ...foldKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      configuration.language.of(syntax(language)), configuration.enabled.of(enabled(disabled)),
      configuration.attributes.of(EditorView.contentAttributes.of(contentAttributes(label, hintId, disabled))),
      configuration.phrases.of(EditorState.phrases.of(phrases[uiLanguage] || {})), configuration.wrap.of(EditorView.lineWrapping),
      syntaxHighlighting(colors), EditorState.tabSize.of(2), EditorView.updateListener.of(update => {
        if (update.docChanged) {
          callback.current(update.state.doc.toString());
        }
        if (update.docChanged || update.selectionSet) report(update.state);
      }),
    ] }) });
    view.current = editor;
    report(editor.state);
    return () => { view.current = null; editor.destroy(); };
  }, []);
  useEffect(() => {
    // CodeMirror owns the live buffer. React can commit an older render while
    // another key arrives, so a normal prop echo must never replace this text.
    // Only explicit commands (such as fixing pasted quotes) replace a document.
    if (view.current && replacement) {
      view.current.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: replacement.text }, userEvent: 'input.replace', annotations: isolateHistory.of('full') });
      onReplacementApplied?.(null);
    }
  }, [replacement, onReplacementApplied]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.language.reconfigure(syntax(language)) }); }, [language]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.enabled.reconfigure(enabled(disabled)) }); }, [disabled]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.attributes.reconfigure(EditorView.contentAttributes.of(contentAttributes(label, hintId, disabled))) }); }, [label, hintId, disabled]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.phrases.reconfigure(EditorState.phrases.of(phrases[uiLanguage] || {})) }); }, [uiLanguage]);
  function toggleWrap() {
    view.current?.dispatch({ effects: config.current.wrap.reconfigure(wrap ? [] : EditorView.lineWrapping) });
    setWrap(!wrap);
  }
  return <div className="labs-editor-workbench">
    <div ref={host} className="labs-code-editor" dir="ltr" data-readonly={disabled ? 'true' : undefined} />
    <div className="labs-editor-status" dir={uiLanguage === 'ar' ? 'rtl' : 'ltr'}>
      <span className="labs-editor-position" dir="auto">{words.line} {position.line}, {words.column} {position.column} · {position.lines} {words.lines}</span>
      <div className="labs-editor-tools">
        <button type="button" onClick={() => view.current && openSearchPanel(view.current)} title={`${words.find} (Ctrl / ⌘ F)`}><Search size={14} /><span>{words.find}</span></button>
        <button type="button" onClick={toggleWrap} aria-pressed={wrap} title={words.wrap}><WrapText size={14} /><span>{words.wrap}</span></button>
      </div>
    </div>
    <span id={hintId} className="sr-only">{words.escape}</span>
  </div>;
});
