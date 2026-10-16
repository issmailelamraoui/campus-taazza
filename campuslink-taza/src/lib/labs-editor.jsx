import React, { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, ViewPlugin, Decoration, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxTree, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { tags } from '@lezer/highlight';
import { programmingQuotes } from './labs-keyboard.js';

const syntax = language => ({ javascript, json, python, c: cpp, cpp }[language] || javascript)();
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

// Grammar tags distinguish calls and properties. Add declaration context so a
// named function, an arrow function and a method keep the same visual identity.
const declarations = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(update) { if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = this.build(update.view); }
  build(view) {
    const marks = [];
    syntaxTree(view.state).iterate({ enter(cursor) {
      const node = cursor.node, parent = node.parent?.name;
      let type;
      if ((node.name === 'VariableDefinition' && parent === 'FunctionDeclaration') || (node.name === 'VariableName' && parent === 'FunctionDefinition') || (['Identifier', 'FieldIdentifier'].includes(node.name) && parent === 'FunctionDeclarator') || (node.name === 'PropertyDefinition' && parent === 'MethodDeclaration')) type = 'function';
      if ((node.name === 'VariableDefinition' && parent === 'ClassDeclaration') || (node.name === 'VariableName' && parent === 'ClassDefinition')) type = 'class';
      if (node.name === 'VariableDefinition' && parent === 'VariableDeclaration' && ['ArrowFunction', 'FunctionExpression'].includes(node.nextSibling?.nextSibling?.name)) type = 'function';
      if (type) marks.push(Decoration.mark({ class: `labs-semantic-${type}` }).range(node.from, node.to));
    } });
    return Decoration.set(marks, true);
  }
}, { decorations: plugin => plugin.decorations });

export function LabsEditor({ value, onChange, language, disabled, label, onRun }) {
  const host = useRef(null), view = useRef(null), callback = useRef(onChange), run = useRef(onRun);
  const configuration = useRef({ language: new Compartment(), enabled: new Compartment(), label: new Compartment() });
  callback.current = onChange; run.current = onRun;
  useEffect(() => {
    const config = configuration.current;
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions: [
      lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(), history(), bracketMatching(), indentOnInput(), EditorView.lineWrapping, declarations, programmingQuotes,
      keymap.of([{ key: 'Mod-Enter', run: () => { run.current?.(); return true; } }, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      config.language.of(syntax(language)), config.enabled.of(EditorState.readOnly.of(!!disabled)),
      config.label.of(EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', dir: 'ltr' })),
      syntaxHighlighting(colors), EditorState.tabSize.of(2), EditorView.updateListener.of(update => { if (update.docChanged) callback.current(update.state.doc.toString()); }),
    ] }) });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && value !== editor.state.doc.toString()) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: configuration.current.language.reconfigure(syntax(language)) }); }, [language]);
  useEffect(() => { view.current?.dispatch({ effects: configuration.current.enabled.reconfigure(EditorState.readOnly.of(!!disabled)) }); }, [disabled]);
  useEffect(() => { view.current?.dispatch({ effects: configuration.current.label.reconfigure(EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', dir: 'ltr' })) }); }, [label]);
  return <div ref={host} className="labs-code-editor" dir="ltr" data-readonly={disabled ? 'true' : undefined} />;
}
