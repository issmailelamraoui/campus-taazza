import assert from 'node:assert/strict';
import test from 'node:test';
import { isProgrammingQuoteKey, isTypedDiaeresis } from '../src/lib/labs-keyboard.js';

test('programming quotation keys cover the International dead quote and spacing diaeresis', () => {
  assert.equal(isProgrammingQuoteKey({ key: 'Dead', code: 'Quote', shiftKey: true }), true);
  assert.equal(isProgrammingQuoteKey({ key: '¨', code: 'BracketLeft', shiftKey: true }), true);
  for (const event of [
    { key: 'Dead', code: 'Quote', shiftKey: false },
    { key: 'Dead', code: 'BracketLeft', shiftKey: true },
    { key: '"', code: 'Digit3' },
    { key: '¨', isComposing: true },
    { key: '¨', ctrlKey: true },
    { key: '¨', altKey: true },
    { key: '¨', metaKey: true },
    { key: 'Backspace' },
  ]) assert.equal(isProgrammingQuoteKey(event), false, JSON.stringify(event));
});

test('only directly typed cancellable diaeresis input is normalized', () => {
  const typed = { data: '¨', inputType: 'insertText', cancelable: true, isComposing: false };
  assert.equal(isTypedDiaeresis(typed), true);
  for (const change of [
    { inputType: 'insertFromPaste' },
    { inputType: 'insertFromDrop' },
    { inputType: 'insertCompositionText' },
    { inputType: 'insertReplacementText' },
    { isComposing: true },
    { cancelable: false },
    { data: 'a¨b' },
    { data: 'ü' },
    { data: '"' },
  ]) assert.equal(isTypedDiaeresis({ ...typed, ...change }), false, JSON.stringify(change));
});
