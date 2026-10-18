import React from 'react';
import { Select } from './Select';
import { useApp } from '../context';
import { normalizePart, partLabel } from '../lib/resources';

export const PART_CHOICES = ['complete', ...Array.from({ length: 20 }, (_, index) => String(index + 1))];

export default function PartSelect({ value = '', placeholder, ...props }) {
  const { tr, language } = useApp();
  const current = normalizePart(value);
  return <Select {...props} value={current} placeholder={placeholder || tr('Choisir une partie', 'Choose a part', 'اختر جزءاً')}>
    {current && !PART_CHOICES.includes(current) && <option value={current} disabled>{partLabel(current, language)} · {tr('valeur existante', 'existing value', 'قيمة موجودة')}</option>}
    {PART_CHOICES.map(part => <option value={part} key={part}>{part === 'complete' ? partLabel(part, language) : part}</option>)}
  </Select>;
}
PartSelect.isFieldControl = true;
