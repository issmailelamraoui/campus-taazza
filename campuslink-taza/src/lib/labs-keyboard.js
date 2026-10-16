import { Prec } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

// US International exposes Shift+Quote as a diaeresis dead key. In a code
// editor this key should insert a string delimiter before a composition starts.
// Other dead keys and AltGr combinations still belong to the keyboard layout.
export function isProgrammingQuoteKey(event) {
  return !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && (
    event.key === '¨' || (event.key === 'Dead' && event.code === 'Quote' && event.shiftKey)
  );
}

export function isTypedDiaeresis(event) {
  return event.cancelable && !event.isComposing && event.inputType === 'insertText' && event.data === '¨';
}

const quoteKeys = ViewPlugin.fromClass(class {
  composing = false;
  compositionEndedAt = -Infinity;
  modifiedKeyAt = -Infinity;
  inputAt = -Infinity;
  inputType = '';

  insert(view, event) {
    event.preventDefault();
    view.dispatch({ ...view.state.replaceSelection('"'), scrollIntoView: true, userEvent: 'input.type' });
    return true;
  }

  available(view) { return !view.state.readOnly && !view.composing && !this.composing; }
  typedInputAvailable(view) {
    const timestamp = Date.now();
    return this.available(view) && timestamp - this.compositionEndedAt > 100 && timestamp - this.modifiedKeyAt > 100;
  }
}, {
  eventHandlers: {
    keydown(event, view) {
      this.modifiedKeyAt = event.ctrlKey || event.metaKey || event.altKey ? Date.now() : -Infinity;
      return this.available(view) && isProgrammingQuoteKey(event) ? this.insert(view, event) : false;
    },
    beforeinput(event, view) {
      this.inputAt = Date.now();
      this.inputType = event.inputType;
      // A spacing diaeresis can also arrive directly from a software keyboard.
      // Do not touch pasted/replacement text or a just-completed IME composition.
      return this.typedInputAvailable(view) && isTypedDiaeresis(event)
        ? this.insert(view, event) : false;
    },
    compositionstart() { this.composing = true; return false; },
    compositionend() { this.composing = false; this.compositionEndedAt = Date.now(); return false; },
    blur() { this.composing = false; return false; },
  },
});

export const programmingQuotes = Prec.highest([
  quoteKeys,
  // Chromium EditContext and some phone keyboards commit text without a
  // cancellable beforeinput event. Handle that same single typed character at
  // CodeMirror's input boundary. Paste and programmatic changes bypass it.
  EditorView.inputHandler.of((view, _from, _to, text, insert) => {
    const keys = view.plugin(quoteKeys);
    if (text !== '¨' || !keys?.typedInputAvailable(view)) return false;
    if (Date.now() - keys.inputAt < 100 && keys.inputType !== 'insertText') return false;
    const transaction = insert();
    if (!transaction.isUserEvent('input.type') || transaction.isUserEvent('input.type.compose')) return false;
    const changes = [];
    transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      changes.push({ from, to, insert: inserted.toString() === '¨' ? '"' : inserted });
    });
    view.dispatch({ changes, selection: transaction.newSelection, scrollIntoView: true, userEvent: 'input.type' });
    return true;
  }),
]);
