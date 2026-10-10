import React, { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import './controls.css';

const plainText = children => React.Children.toArray(children).map(child => React.isValidElement(child) ? plainText(child.props.children) : String(child ?? '')).join('');
const searchText = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase();
function optionItems(children) {
  return React.Children.toArray(children).flatMap(child => {
    if (!React.isValidElement(child)) return [];
    if (child.type === 'option') return [{ value: String(child.props.value ?? plainText(child.props.children)), label: child.props.children, text: plainText(child.props.children), disabled: !!child.props.disabled }];
    return optionItems(child.props.children);
  });
}

function usePopup(controlRef, menuRef, open, setOpen, contentKey) {
  const [position, setPosition] = useState({ left: 8, top: 8, width: 200 });
  const place = () => {
    if (!open || !controlRef.current || !menuRef.current) return;
    const anchor = controlRef.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
    const dialog = controlRef.current.closest('[role="dialog"]');
    const header = dialog?.querySelector('.modal-header')?.getBoundingClientRect();
    const footer = dialog?.querySelector('.modal-footer')?.getBoundingClientRect();
    const bottomNav = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
    const topEdge = Math.max(top, header?.height ? header.bottom : top);
    const bottomEdge = Math.min(top + height, footer?.height ? footer.top : top + height, bottomNav?.height ? bottomNav.top : top + height);
    const popupWidth = Math.min(Math.max(anchor.width, 190), width - 16);
    const below = bottomEdge - anchor.bottom - 8, above = anchor.top - topEdge - 8;
    const naturalHeight = menuRef.current.scrollHeight + 2;
    const upwards = below < Math.min(naturalHeight, 200) && above > below;
    const popupHeight = Math.min(naturalHeight, 320, Math.max(1, upwards ? above : below));
    const rtl = document.documentElement.dir === 'rtl';
    setPosition({
      left: Math.max(left + 8, Math.min(rtl ? anchor.right - popupWidth : anchor.left, left + width - popupWidth - 8)),
      top: Math.max(topEdge + 8, Math.min(upwards ? anchor.top - popupHeight - 6 : anchor.bottom + 6, bottomEdge - popupHeight - 8)),
      width: popupWidth, maxHeight: popupHeight,
    });
  };
  useLayoutEffect(place, [open, contentKey, position.width]);
  useEffect(() => {
    if (!open) return;
    const outside = event => {
      if (!controlRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    // Focusing a field near the end of a modal can scroll it after the popup
    // opens. Follow its anchor instead of hiding its freshly opened choices.
    const scroll = event => {
      if (menuRef.current?.contains(event.target)) return;
      const anchor = controlRef.current?.getBoundingClientRect();
      if (!anchor || anchor.bottom < 0 || anchor.top > window.innerHeight) setOpen(false);
      else place();
    };
    const dismiss = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    window.visualViewport?.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      window.visualViewport?.removeEventListener('resize', dismiss);
    };
  }, [open]);
  return position;
}

function Popup({ id, items, selected, active, onActive, onSelect, menuRef, position, label }) {
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const option = menu?.querySelector(`[data-index="${active}"]`);
    if (!option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
  }, [active, position.maxHeight, position.width, items.length]);
  return createPortal(<div ref={menuRef} id={id} role="listbox" aria-label={label} className="custom-select-popup" style={position} dir={document.documentElement.dir || 'ltr'}
    onPointerDown={event => event.preventDefault()}>
    {items.map((item, index) => <div key={`${item.value}-${index}`} id={`${id}-option-${index}`} role="option" aria-selected={item.value === selected} aria-disabled={item.disabled || undefined}
      className={`custom-select-option ${index === active ? 'is-active' : ''} ${item.value === selected ? 'is-selected' : ''}`}
      data-value={item.value} data-index={index}
      onPointerMove={() => { if (!item.disabled) onActive(index); }} onClick={() => { if (!item.disabled) onSelect(item); }}>
      <span dir="auto">{item.label}</span>{item.value === selected && <Check size={15} aria-hidden="true" />}
    </div>)}
  </div>, document.body);
}

export const Select = forwardRef(function Select({ children, value, defaultValue = '', onChange, className = '', name, id, disabled, required, placeholder = '', ...props }, forwardedRef) {
  const generatedId = useId();
  const controlId = id || `select-${generatedId}`;
  const listId = `${controlId}-listbox`;
  const controlRef = useRef(null), menuRef = useRef(null), typing = useRef({ text: '', time: 0 });
  useImperativeHandle(forwardedRef, () => controlRef.current);
  const [localValue, setLocalValue] = useState(defaultValue), [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const current = String(value ?? localValue), items = optionItems(children);
  const selectedIndex = items.findIndex(item => item.value === current);
  const selected = items[selectedIndex];
  const position = usePopup(controlRef, menuRef, open, setOpen, items.map(item => item.value).join('\u0000'));
  const enabled = items.map((item, index) => !item.disabled ? index : -1).filter(index => index >= 0);
  const show = () => { if (!disabled && enabled.length) { setActive(enabled.includes(selectedIndex) ? selectedIndex : enabled[0]); setOpen(true); } };
  const choose = item => {
    setLocalValue(item.value); setOpen(false);
    const target = { value: item.value, name, id: controlId };
    onChange?.({ target, currentTarget: target, type: 'change' });
    controlRef.current?.focus({ preventScroll: true });
  };
  const keyboard = event => {
    if (disabled) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) { show(); if (event.key === 'Home') setActive(enabled[0]); if (event.key === 'End') setActive(enabled.at(-1)); return; }
      const index = enabled.indexOf(active);
      setActive(event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && items[active]) choose(items[active]); else show();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const query = searchText((now - typing.current.time < 700 ? typing.current.text : '') + event.key);
      typing.current = { text: query, time: now };
      const match = items.findIndex(item => !item.disabled && searchText(item.text).startsWith(query));
      if (match >= 0) { setActive(match); setOpen(true); }
    }
  };
  return <>
    <button {...props} ref={controlRef} id={controlId} type="button" className={`custom-select ${className} ${open ? 'is-open' : ''}`} role="combobox"
      disabled={disabled} aria-required={required || undefined} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && active >= 0 ? `${listId}-option-${active}` : undefined}
      onClick={() => open ? setOpen(false) : show()} onKeyDownCapture={keyboard}>
      <span className="custom-select-value" dir="auto">{selected?.label || placeholder}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {name && <input type="hidden" name={name} value={current} disabled={disabled} />}
    {open && <Popup {...{items, active, menuRef, position}} id={listId} selected={current} onActive={setActive} onSelect={choose} label={props['aria-label'] || plainText(selected?.label) || undefined} />}
  </>;
});
Select.isFieldControl = true;

export const Autocomplete = forwardRef(function Autocomplete({ options = [], value = '', onChange, className = '', id, showOnEmpty = false, ...props }, forwardedRef) {
  const generatedId = useId();
  const controlId = id || `autocomplete-${generatedId}`, listId = `${controlId}-listbox`;
  const controlRef = useRef(null), menuRef = useRef(null);
  useImperativeHandle(forwardedRef, () => controlRef.current);
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const query = searchText(value);
  const items = options.filter(option => searchText(option).includes(query)).map(option => ({ value: String(option), label: String(option), text: String(option) }));
  const visible = open && items.length > 0 && (showOnEmpty || query.length > 0);
  const position = usePopup(controlRef, menuRef, visible, setOpen, items.map(item => item.value).join('\u0000'));
  const choose = item => {
    setOpen(false); setActive(-1);
    const target = { value: item.value, id: controlId, name: props.name };
    onChange?.({ target, currentTarget: target, type: 'change' });
    controlRef.current?.focus({ preventScroll: true });
  };
  const keyboard = event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1); }
    else if (event.key === 'Tab') setOpen(false);
    else if (['ArrowDown', 'ArrowUp'].includes(event.key) && items.length) {
      event.preventDefault(); setOpen(true);
      setActive(visible && active >= 0 ? (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length : event.key === 'ArrowDown' ? 0 : items.length - 1);
    } else if (event.key === 'Enter' && visible && active >= 0 && items[active]) { event.preventDefault(); choose(items[active]); }
  };
  return <>
    <input {...props} ref={controlRef} id={controlId} type="text" className={`custom-autocomplete ${className}`} value={value} autoComplete="off"
      role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={visible} aria-controls={visible ? listId : undefined}
      aria-activedescendant={visible && active >= 0 && items[active] ? `${listId}-option-${active}` : undefined}
      onFocus={event => { setOpen(true); props.onFocus?.(event); }} onClick={event => { setOpen(true); props.onClick?.(event); }}
      onChange={event => { setActive(-1); setOpen(true); onChange?.(event); }} onKeyDownCapture={keyboard} />
    {visible && <Popup {...{items, active, menuRef, position}} id={listId} selected={String(value)} onActive={setActive} onSelect={choose} label={props['aria-label'] || undefined} />}
  </>;
});
Autocomplete.isFieldControl = true;
