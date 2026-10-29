import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, LoaderCircle, RotateCw, Search } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context';
import { suggestOfficialModules } from '../lib/module-catalog.js';
import { Field } from './ui';

export default function OfficialModuleSelector({ facultyId, filiereId, semester, value, moduleId, onQuery, onSelect, disabled }) {
  const { tr, t } = useApp(), generatedId = useId(), listId = `official-modules-${generatedId}`;
  const root = useRef(null);
  const [request, setRequest] = useState({ key: '', state: 'loading', modules: [] });
  const [revision, setRevision] = useState(0), [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const key = JSON.stringify([facultyId, filiereId, semester]);
  useEffect(() => {
    const controller = new AbortController(); let current = true;
    setRequest({ key, state: 'loading', modules: [] });
    const params = new URLSearchParams({ faculty_id: facultyId || '', filiere_id: filiereId || '', semester: String(semester), official: '1' });
    api(`/modules?${params}`, { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.modules)) throw new Error('Invalid module catalogue');
      if (current) setRequest({ key, state: 'ready', modules: result.modules });
    }).catch(error => { if (current && error.name !== 'AbortError') setRequest({ key, state: 'error', modules: [] }); });
    setActive(-1); setOpen(false);
    return () => { current = false; controller.abort(); };
  }, [key, revision]);
  const current = request.key === key ? request : { state: 'loading', modules: [] };
  const selected = current.modules.find(item => String(item.id) === String(moduleId) && item.catalog_status === 'official');
  const options = suggestOfficialModules(current.modules, selected && value === selected.name ? '' : value).slice(0, 12);
  const show = open && !disabled && current.state === 'ready';
  const choose = item => { onSelect(item); setOpen(false); setActive(-1); };
  return <Field label={`${t('module')} *`} hint={tr('Recherchez puis confirmez une unité du programme officiel.', 'Search, then confirm a module from the official curriculum.', 'ابحث ثم أكّد وحدة من البرنامج الرسمي.')}>
    <div className="official-module-selector" ref={root} onBlur={event => { if (!root.current?.contains(event.relatedTarget)) setOpen(false); }}>
      <div className="official-module-search">
        <Search size={16} aria-hidden="true" />
        <input className="input" role="combobox" aria-label={`${t('module')} *`} value={value} disabled={disabled} required autoComplete="off"
          aria-autocomplete="list" aria-expanded={show} aria-controls={show ? listId : undefined}
          aria-activedescendant={show && active >= 0 && options[active] ? `${listId}-${active}` : undefined}
          onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
          onChange={event => { onQuery(event.target.value); setActive(-1); setOpen(true); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
            else if (['ArrowDown', 'ArrowUp'].includes(event.key) && options.length) { event.preventDefault(); setOpen(true); setActive(position => (position + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length); }
            else if (event.key === 'Enter' && show && options[active]) { event.preventDefault(); choose(options[active]); }
          }} />
        {selected && <Check size={17} className="official-module-confirmed" aria-hidden="true" />}
      </div>
      {current.state === 'loading' && <span className="official-module-state" role="status"><LoaderCircle size={14} />{tr('Chargement du catalogue…', 'Loading the catalogue…', 'جارٍ تحميل القائمة…')}</span>}
      {current.state === 'error' && <div className="official-module-state" role="alert">{tr('Catalogue indisponible.', 'Catalogue unavailable.', 'القائمة غير متاحة.')}<button type="button" className="library-module-retry" onClick={() => setRevision(value => value + 1)}><RotateCw size={14} />{tr('Réessayer', 'Retry', 'إعادة المحاولة')}</button></div>}
      {show && options.length > 0 && <div id={listId} className="official-module-options" role="listbox" aria-label={tr('Modules officiels', 'Official modules', 'الوحدات الرسمية')}>
        {options.map((item, index) => <button type="button" role="option" id={`${listId}-${index}`} key={item.id} aria-selected={String(item.id) === String(moduleId)}
          className={index === active ? 'is-active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>
          <span dir="auto">{item.name}</span>{String(item.id) === String(moduleId) && <Check size={15} />}
        </button>)}
      </div>}
      {current.state === 'ready' && !selected && <p className="official-module-state" role="status">{!current.modules.length
        ? tr('Aucun module officiel vérifié pour ce semestre. Un administrateur doit valider le programme.', 'No verified official modules for this semester. An administrator must validate the curriculum.', 'لا توجد وحدات رسمية موثقة لهذا الفصل. يجب أن يؤكد المسؤول البرنامج.')
        : show && !options.length ? tr('Aucun module correspondant. Vérifiez le nom ou signalez une unité manquante.', 'No matching module. Check the name or report a missing module.', 'لا توجد وحدة مطابقة. تحقق من الاسم أو أبلغ عن وحدة مفقودة.')
        : tr('Sélectionnez une suggestion pour confirmer le module.', 'Select a suggestion to confirm the module.', 'اختر اقتراحاً لتأكيد الوحدة.')} <a href="/app/feedback">{tr('Signaler un module manquant', 'Report a missing module', 'الإبلاغ عن وحدة مفقودة')}</a></p>}
    </div>
  </Field>;
}
