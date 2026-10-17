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

export function isPossibleProgrammingQuote(event) {
  return !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey &&
    event.key === 'Process' && event.code === 'Quote' && event.shiftKey;
}

export function isTypedDiaeresis(event) {
  return event.cancelable && !event.isComposing && event.inputType === 'insertText' && event.data === '¨';
}

const quoteKeys = ViewPlugin.fromClass(class {
  composing = false;
  pendingQuote = null;
  resetTimer = null;
  selectionFrame = null;
  compositionEndedAt = -Infinity;
  modifiedKeyAt = -Infinity;
  inputAt = -Infinity;
  inputType = '';

  constructor(view) { this.window = view.contentDOM.ownerDocument.defaultView; }

  insert(view, event) {
    event.preventDefault();
    view.dispatch({ ...view.state.replaceSelection('"'), scrollIntoView: true, userEvent: 'input.type' });
    if (this.pendingQuote) this.pendingQuote.selection = view.state.selection;
    return true;
  }

  available(view) { return !view.state.readOnly && !view.compositionStarted && !this.composing; }
  pending() { return this.pendingQuote && Date.now() - this.pendingQuote.at < 1000 ? this.pendingQuote : null; }
  resetComposition(view) {
    if (this.resetTimer !== null) return;
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      if (!this.pending()?.composing || !view.hasFocus) { this.pendingQuote = null; return; }
      // preventDefault on keydown cannot cancel a native dead-key IME. End
      // only the composition owned by this quote, after its first text event.
      // A fresh input context also stops the next letter turning into ü/ä/ë.
      const selection = this.pendingQuote.selection;
      const context = view.contentDOM.editContext;
      if (context) {
        view.contentDOM.editContext = null;
        view.contentDOM.editContext = context;
      } else {
        view.contentDOM.blur();
        if (view.compositionStarted) view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
        view.focus();
      }
      this.composing = false;
      this.pendingQuote = null;
      view.dispatch({ selection: selection || view.state.selection, scrollIntoView: true });
      // Firefox delivers the final native selection change after blur.
      // Restore the quote's caret once it has settled, unless new input wins.
      const doc = view.state.doc;
      this.selectionFrame = this.window.requestAnimationFrame(() => {
        this.selectionFrame = null;
        if (view.hasFocus && view.state.doc === doc && selection) {
          view.dispatch({ selection });
          view.focus();
        }
      });
    }, 0);
  }
  cancelSelectionRestore() {
    if (this.selectionFrame !== null) this.window.cancelAnimationFrame(this.selectionFrame);
    this.selectionFrame = null;
  }
  destroy() {
    if (this.resetTimer !== null) clearTimeout(this.resetTimer);
    if (this.selectionFrame !== null) this.window.cancelAnimationFrame(this.selectionFrame);
  }
  typedInputAvailable(view) {
    const timestamp = Date.now();
    return this.available(view) && timestamp - this.compositionEndedAt > 100 && timestamp - this.modifiedKeyAt > 100;
  }
}, {
  eventHandlers: {
    keydown(event, view) {
      this.cancelSelectionRestore();
      this.modifiedKeyAt = event.ctrlKey || event.metaKey || event.altKey ? Date.now() : -Infinity;
      if (!this.available(view)) return false;
      this.pendingQuote = null;
      // Linux IMEs can report Process/229 instead of Dead. Wait for the
      // composition's actual diaeresis before treating that ambiguous key as ".
      if (isPossibleProgrammingQuote(event)) {
        this.pendingQuote = { at: Date.now(), inserted: false };
        return false;
      }
      if (!isProgrammingQuoteKey(event)) return false;
      this.pendingQuote = { at: Date.now(), inserted: true };
      return this.insert(view, event);
    },
    pointerdown(_event, view) { this.cancelSelectionRestore(); this.pendingQuote = null; return false; },
    beforeinput(event, view) {
      this.cancelSelectionRestore();
      this.inputAt = Date.now();
      this.inputType = event.inputType;
      if (event.inputType === 'insertCompositionText' && event.data === '¨' && this.pending()) {
        this.pendingQuote.composing = true;
        this.resetComposition(view);
      }
      // A spacing diaeresis can also arrive directly from a software keyboard.
      // Do not touch pasted/replacement text or a just-completed IME composition.
      return this.typedInputAvailable(view) && isTypedDiaeresis(event)
        ? this.insert(view, event) : false;
    },
    compositionstart() { this.composing = true; return false; },
    compositionupdate(event, view) {
      if (event.data === '¨' && this.pending()) {
        this.pendingQuote.composing = true;
        this.resetComposition(view);
      } else if (event.data) this.pendingQuote = null;
      return false;
    },
    compositionend() { this.composing = false; this.compositionEndedAt = Date.now(); return false; },
    blur() { this.composing = false; return false; },
  },
});

function replaceTypedQuote(view, transaction) {
  const changes = [];
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    changes.push({ from, to, insert: inserted.toString() === '¨' ? '"' : inserted });
  });
  view.dispatch({ changes, selection: transaction.newSelection, scrollIntoView: true, userEvent: 'input.type' });
}

export const programmingQuotes = Prec.highest([
  quoteKeys,
  // Chromium EditContext and some phone keyboards commit text without a
  // cancellable beforeinput event. Handle that same single typed character at
  // CodeMirror's input boundary. Paste and programmatic changes bypass it.
  EditorView.inputHandler.of((view, _from, _to, text, insert) => {
    const keys = view.plugin(quoteKeys);
    if (!keys || view.state.readOnly) return false;
    const pending = keys.pending();
    if (text !== '¨') {
      // A Process key can also begin a genuine IME, including Arabic.
      if (pending && (view.compositionStarted || keys.composing)) keys.pendingQuote = null;
      return false;
    }
    if (pending && (view.compositionStarted || keys.composing || pending.composing)) {
      pending.composing = true;
      keys.resetComposition(view);
      if (pending.inserted) return true;
      pending.inserted = true;
      replaceTypedQuote(view, insert());
      pending.selection = view.state.selection;
      return true;
    }
    if (!keys.typedInputAvailable(view)) return false;
    if (Date.now() - keys.inputAt < 100 && keys.inputType !== 'insertText') return false;
    const transaction = insert();
    if (!transaction.isUserEvent('input.type') || transaction.isUserEvent('input.type.compose')) return false;
    replaceTypedQuote(view, transaction);
    return true;
  }),
]);
