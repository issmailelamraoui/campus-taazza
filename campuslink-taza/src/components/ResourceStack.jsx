import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useApp } from '../context';
import { DocumentCard } from './ui';
import './resource-stack.css';

const MOBILE_QUERY = '(max-width: 760px)';
// The scroll rail is a logical index, independent of the document's height.
const STEP = 160;
const PEEK = 8;
const LIFT_GAP = 12;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const StackDocument = React.memo(DocumentCard);

export function RecentResourceCards({ documents }) {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const change = () => setMobile(query.matches);
    if (query.addEventListener) query.addEventListener('change', change);
    else query.addListener(change);
    return () => {
      if (query.removeEventListener) query.removeEventListener('change', change);
      else query.removeListener(change);
    };
  }, []);
  return mobile ? <ResourceStack documents={documents} /> : <div className="document-grid">{documents.slice(0, 3).map(document => <DocumentCard key={document.id} document={document} />)}</div>;
}

function ResourceStack({ documents }) {
  const { t, tr, language } = useApp();
  const root = useRef(null), scroller = useRef(null), track = useRef(null), stage = useRef(null);
  const planes = useRef(new Map()), controller = useRef(null);
  const [position, setPosition] = useState(0);
  const [selected, setSelected] = useState(0);
  const [pinned, setPinned] = useState(null);
  const [announced, setAnnounced] = useState(0);
  const count = documents.length;
  const active = clamp(selected, 0, Math.max(0, count - 1));
  const base = clamp(position, 0, Math.max(0, count - 1));
  // Preload a previous document too: reversing a swipe never waits for React
  // to reconstruct the card that is entering the viewport.
  const start = Math.max(0, base - 1);
  const visible = documents.slice(start, base + 4).map((document, offset) => ({ document, index: start + offset }));
  if (pinned && !visible.some(item => item.document.id === pinned.document.id)) {
    visible.push({ document: pinned.document, index: documents.findIndex(item => item.id === pinned.document.id) });
  }

  useLayoutEffect(() => {
    const node = scroller.current;
    const heights = new Map(), controls = new WeakMap(), interactive = new WeakMap();
    const nativeInert = 'inert' in HTMLElement.prototype;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let items = documents;
    let frame = 0, settleTimer = 0;
    let gesture = null, pendingDistance = 0, motion = null;
    let progress = 0, previousActive = 0, previousBase = -1, viewportHeight = 0;
    let suppressClickUntil = 0, pointer = null, width = node.clientWidth;
    let live = true;
    const lastIndex = () => Math.max(0, items.length - 1);
    const cardHeight = index => heights.get(items[clamp(index, 0, lastIndex())]?.id) || 220;
    // Native scrollTop can round to whole CSS pixels. Keep our own precise
    // position while dragging/snapping so small finger movements never lose
    // distance, then use the rail again for native scrolling and page chaining.
    const readPosition = () => clamp(motion?.position ?? ((gesture?.owned || gesture?.interrupted) ? gesture.position : node.scrollTop / STEP), 0, lastIndex());

    function restoreControls(list) {
      list?.forEach(({ node: control, tabIndex }) => {
        if (tabIndex === null) control.removeAttribute('tabindex');
        else control.setAttribute('tabindex', tabIndex);
      });
    }
    function paint() {
      progress = readPosition();
      const base = Math.floor(progress + 0.00001), fraction = progress - base;
      const aligned = Math.abs(progress - Math.round(progress)) < 0.002;
      const active = aligned && !gesture && !motion ? Math.round(progress) : previousActive;
      const frontHeight = cardHeight(base), nextHeight = cardHeight(base + 1);
      const referenceHeight = frontHeight + (nextHeight - frontHeight) * fraction;
      const nextViewportHeight = referenceHeight + Math.min(3, lastIndex() - progress) * PEEK;
      // Each card keeps its natural size. The frame grows with the incoming
      // document, instead of clipping its metadata and popping open at release.
      if (Math.abs(nextViewportHeight - viewportHeight) > 0.1) {
        viewportHeight = nextViewportHeight;
        node.style.height = `${viewportHeight}px`;
        stage.current.style.height = `${viewportHeight}px`;
      }
      const trackHeight = `${viewportHeight + lastIndex() * STEP}px`;
      if (track.current.style.height !== trackHeight) track.current.style.height = trackHeight;
      planes.current.forEach((plane, id) => {
        const index = Number(plane.dataset.stackIndex), depth = index - progress;
        const height = heights.get(id) || frontHeight;
        const leaving = depth < 0;
        const y = leaving ? depth * (height + LIFT_GAP) : referenceHeight - height + depth * PEEK;
        const scale = leaving ? 1 : Math.max(0.9, 1 - depth * 0.018);
        const transform = `translate3d(0, ${y.toFixed(3)}px, 0) scale(${scale.toFixed(5)})`;
        if (plane.style.transform !== transform) plane.style.transform = transform;
        const opacity = index < 0 || depth <= -1 || depth > 3.001 ? '0' : '1';
        if (plane.style.opacity !== opacity) plane.style.opacity = opacity;
        const zIndex = String(items.length - index + 1);
        if (plane.style.zIndex !== zIndex) plane.style.zIndex = zIndex;
        const isActive = index === active && index >= 0;
        if (interactive.get(plane) !== isActive) {
          interactive.set(plane, isActive);
          plane.classList.toggle('is-active', isActive);
          plane.inert = !isActive;
          plane.setAttribute('aria-hidden', String(!isActive));
          if (!nativeInert) {
            let list = controls.get(plane);
            if (!list) {
              list = [...plane.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].map(control => ({ node: control, tabIndex: control.getAttribute('tabindex') }));
              controls.set(plane, list);
            }
            if (isActive) restoreControls(list);
            else list.forEach(({ node: control }) => control.setAttribute('tabindex', '-1'));
          }
        }
      });
      root.current.dataset.activeIndex = active;
      if (base !== previousBase) { previousBase = base; setPosition(base); }
      if (active !== previousActive) { previousActive = active; setSelected(active); }
    }
    function measure() {
      // Batch a bounded set of reads. No size measurements run per frame.
      planes.current.forEach((plane, id) => {
        const height = plane.firstElementChild?.offsetHeight;
        if (height) heights.set(id, height);
      });
      paint();
    }
    function movePhysical(distance) {
      let next = gesture?.position ?? readPosition();
      let remaining = Math.abs(distance);
      const direction = Math.sign(distance);
      while (remaining > 0.01 && (direction > 0 ? next < lastIndex() : next > 0)) {
        const segment = direction > 0 ? Math.floor(next + 0.00001) : Math.ceil(next - 0.00001) - 1;
        const boundary = direction > 0 ? segment + 1 : segment;
        const units = cardHeight(segment) + LIFT_GAP;
        const available = Math.abs(boundary - next) * units;
        if (remaining < available) { next += direction * remaining / units; break; }
        remaining -= available; next = boundary;
      }
      progress = clamp(next, 0, lastIndex());
      if (gesture) gesture.position = progress;
      node.scrollTop = progress * STEP;
    }
    function flushTouch() {
      if (pendingDistance) { movePhysical(pendingDistance); pendingDistance = 0; }
    }
    function requestFrame() { if (!frame && live) frame = requestAnimationFrame(tick); }
    function tick(now) {
      frame = 0; flushTouch();
      if (motion) {
        const elapsed = clamp((now - motion.started) / motion.duration, 0, 1);
        const squared = elapsed * elapsed, cubed = squared * elapsed;
        const next = (2 * cubed - 3 * squared + 1) * motion.from + (cubed - 2 * squared + elapsed) * motion.slope + (-2 * cubed + 3 * squared) * motion.to;
        motion.position = next;
        node.scrollTop = next * STEP;
        if (elapsed === 1) { setAnnounced(motion.to); motion = null; }
      }
      paint();
      if (motion) requestFrame();
    }
    function cancelMotion() { motion = null; clearTimeout(settleTimer); }
    function navigate(index, { velocity = 0, immediate = false, from: initialPosition } = {}) {
      flushTouch();
      const target = clamp(index, 0, lastIndex()), from = initialPosition ?? readPosition(), delta = target - from;
      cancelMotion();
      if (immediate || reducedMotion.matches || Math.abs(delta) > 3 || Math.abs(delta) < 0.002) {
        node.scrollTop = target * STEP; paint(); setAnnounced(target); return;
      }
      const duration = clamp(150 + Math.abs(delta) * 85, 150, 300);
      const initial = velocity ? velocity / (cardHeight(Math.floor(from)) + LIFT_GAP) * duration : delta * 1.8;
      // Carry release velocity into one monotone snap, without overshoot or a
      // competing browser smooth-scroll animation.
      const slope = Math.sign(initial) === Math.sign(delta) ? Math.sign(delta) * Math.min(Math.abs(initial), Math.abs(delta) * 3) : 0;
      motion = { from, position: from, to: target, started: performance.now(), duration, slope };
      requestFrame();
    }
    function settle() { if (!gesture && !motion) navigate(Math.round(readPosition())); }
    function onScroll() {
      requestFrame();
      if (!gesture && !motion) { clearTimeout(settleTimer); settleTimer = setTimeout(settle, 110); }
    }
    function onTouchStart(event) {
      if (event.touches.length !== 1) return;
      const interrupted = Boolean(motion);
      const position = readPosition();
      cancelMotion();
      const touch = event.touches[0];
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, started: position, position, distance: 0, velocity: 0, lastTime: performance.now(), owned: false, page: false, interrupted };
      const plane = event.target.closest('.resource-stack-card');
      const document = plane && items[Number(plane.dataset.stackIndex)];
      setPinned(document ? { document } : null);
    }
    function onTouchMove(event) {
      if (!gesture || gesture.page) return;
      const touch = [...event.touches].find(item => item.identifier === gesture.id);
      if (!touch || event.touches.length !== 1) { gesture.page = true; return; }
      const dx = touch.clientX - gesture.x, dy = gesture.y - touch.clientY;
      if (!gesture.owned) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return;
        const current = readPosition();
        if (Math.abs(dx) > Math.abs(dy) || items.length < 2 || (dy < 0 && current <= 0.001) || (dy > 0 && current >= lastIndex() - 0.001)) {
          gesture.page = true; return;
        }
        gesture.position = current;
        gesture.owned = true; root.current.classList.add('is-dragging');
      }
      if (event.cancelable) event.preventDefault();
      const now = performance.now(), distance = gesture.lastY - touch.clientY;
      const elapsed = Math.max(8, now - gesture.lastTime);
      gesture.velocity = gesture.velocity * 0.55 + distance / elapsed * 0.45;
      gesture.distance += distance; gesture.lastY = touch.clientY; gesture.lastTime = now;
      pendingDistance += distance; requestFrame();
    }
    function onTouchEnd(event) {
      if (event.touches.length || !gesture) return;
      const ended = gesture; flushTouch();
      const current = readPosition();
      gesture = null; setPinned(null);
      root.current.classList.remove('is-dragging');
      if (!ended.owned) {
        if (ended.interrupted) suppressClickUntil = performance.now() + 180;
        if (Math.abs(current - Math.round(current)) > 0.001) navigate(Math.round(current), { from: current });
        else paint();
        return;
      }
      suppressClickUntil = performance.now() + 180;
      const velocity = performance.now() - ended.lastTime > 100 ? 0 : ended.velocity;
      const projected = current + clamp(velocity * 150 / (cardHeight(Math.floor(current)) + LIFT_GAP), -1.25, 1.25);
      let target = Math.round(projected);
      const direction = Math.sign(current - ended.started);
      const reversing = Math.abs(velocity) > 0.1 && Math.sign(velocity) !== direction;
      if (!reversing && Math.abs(ended.distance) >= Math.min(45, cardHeight(Math.floor(ended.started)) * 0.18)) {
        target = direction > 0 ? Math.max(target, Math.floor(ended.started) + 1) : direction < 0 ? Math.min(target, Math.ceil(ended.started) - 1) : target;
      }
      navigate(target, { velocity, from: current });
    }
    function onTouchCancel() {
      flushTouch();
      const current = readPosition();
      pendingDistance = 0; gesture = null; setPinned(null);
      root.current.classList.remove('is-dragging');
      suppressClickUntil = performance.now() + 180; navigate(Math.round(current), { from: current });
    }
    function onPointerDown(event) { pointer = { y: event.clientY, moved: false }; }
    function onPointerMove(event) { if (pointer && Math.abs(event.clientY - pointer.y) > 8) pointer.moved = true; }
    function onPointerEnd() { if (pointer?.moved) suppressClickUntil = performance.now() + 180; pointer = null; }
    function onClick(event) {
      if (gesture?.owned || performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
    }
    function step(direction) { navigate((motion?.to ?? Math.round(readPosition())) + direction); }
    function onKeyDown(event) {
      if (event.target !== node) return;
      const directions = { ArrowDown: 1, PageDown: 1, ArrowUp: -1, PageUp: -1 };
      if (directions[event.key]) { event.preventDefault(); step(directions[event.key]); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); navigate(event.key === 'Home' ? 0 : lastIndex()); }
    }
    function resize() {
      if (node.clientWidth === width) return;
      width = node.clientWidth; heights.clear(); cancelMotion();
      if (gesture) onTouchCancel(); measure(); navigate(Math.round(progress), { immediate: true });
    }
    function update(next) {
      const base = Math.floor(progress), anchor = items[base]?.id;
      const selectedId = items[previousActive]?.id;
      const targetId = motion && items[motion.to]?.id;
      const index = next.findIndex(item => item.id === anchor);
      const fraction = progress - base;
      const changed = next.length !== items.length || next.some((item, i) => item.id !== items[i]?.id);
      items = next;
      if (changed) {
        clearTimeout(settleTimer);
        const nextProgress = index >= 0 ? Math.min(index + fraction, lastIndex()) : Math.min(base, lastIndex());
        const shift = nextProgress - progress;
        const selectedIndex = next.findIndex(item => item.id === selectedId);
        previousActive = selectedIndex >= 0 ? selectedIndex : clamp(previousActive, 0, lastIndex());
        setSelected(previousActive);
        if (gesture) { gesture.started += shift; gesture.position += shift; }
        if (motion) {
          const target = next.findIndex(item => item.id === targetId);
          if (index >= 0 && target >= 0) {
            const from = motion.from + shift;
            if (Math.abs((target - from) - (motion.to - motion.from)) < 0.001) { motion.from = from; motion.position = nextProgress; motion.to = target; }
            else motion = { from: nextProgress, position: nextProgress, to: target, started: performance.now(), duration: 180, slope: (target - nextProgress) * 1.8 };
          }
          else cancelMotion();
        }
        // Expand the rail before restoring an anchor that moved past its old
        // endpoint, otherwise the browser silently clamps away the last file.
        track.current.style.height = `${viewportHeight + lastIndex() * STEP}px`;
        node.scrollTop = nextProgress * STEP;
        const ids = new Set(items.map(item => item.id));
        for (const id of heights.keys()) if (!ids.has(id)) heights.delete(id);
        if (!gesture && !motion) {
          setAnnounced(Math.round(nextProgress));
          if (Math.abs(nextProgress - Math.round(nextProgress)) > 0.001) settleTimer = setTimeout(settle, 110);
        }
      }
      measure();
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(node);
    window.addEventListener('resize', resize, { passive: true });
    const events = [
      ['scroll', onScroll], ['scrollend', settle], ['wheel', cancelMotion], ['touchstart', onTouchStart],
      ['touchend', onTouchEnd], ['touchcancel', onTouchCancel], ['pointerdown', onPointerDown],
      ['pointermove', onPointerMove], ['pointerup', onPointerEnd], ['pointercancel', onPointerEnd],
    ];
    events.forEach(([name, handler]) => node.addEventListener(name, handler, { passive: true }));
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('click', onClick, true); node.addEventListener('keydown', onKeyDown);
    controller.current = { update, measure, step };
    measure();
    document.fonts?.addEventListener?.('loadingdone', measure);
    document.fonts?.ready.then(() => { if (live) measure(); });
    return () => {
      live = false; cancelMotion(); cancelAnimationFrame(frame); observer?.disconnect();
      window.removeEventListener('resize', resize);
      document.fonts?.removeEventListener?.('loadingdone', measure);
      if (!nativeInert) planes.current.forEach(plane => restoreControls(controls.get(plane)));
      events.forEach(([name, handler]) => node.removeEventListener(name, handler));
      node.removeEventListener('touchmove', onTouchMove); node.removeEventListener('click', onClick, true); node.removeEventListener('keydown', onKeyDown);
      controller.current = null;
    };
  }, []);

  useLayoutEffect(() => { controller.current?.update(documents); }, [documents, language]);
  useLayoutEffect(() => { controller.current?.measure(); }, [base, active, pinned]);

  return <div ref={root} className="resource-stack" data-count={count} data-active-index={active} data-scroll-step={STEP}>
    <div ref={scroller} className="resource-stack-scroll" tabIndex={0} role="region"
      aria-label={t('recentResources')} aria-description={tr('Glissez vers le haut ou le bas, ou utilisez les flèches pour parcourir les documents.', 'Swipe up or down, or use the arrow keys to browse documents.', 'اسحب للأعلى أو للأسفل أو استخدم الأسهم لتصفح الوثائق.')}>
      <div ref={track} className="resource-stack-track">
        <div ref={stage} className="resource-stack-stage">
          {visible.map(({ document, index }) => <div key={document.id}
            ref={node => { if (node) planes.current.set(document.id, node); else planes.current.delete(document.id); }}
            className={`resource-stack-card${index === active ? ' is-active' : ''}`} data-stack-index={index} data-resource-id={document.id}
            aria-hidden={index !== active} inert={index !== active}>
            <StackDocument document={document} />
          </div>)}
        </div>
      </div>
    </div>
    <div className="resource-stack-controls">
      <span className="resource-stack-position" aria-hidden="true"><b>{active + 1}</b> / {count}</span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{tr('Document', 'Document', 'الوثيقة')} {clamp(announced, 0, count - 1) + 1} {tr('sur', 'of', 'من')} {count}</span>
      <span className="resource-stack-hint">{count > 1 ? tr('Glissez pour parcourir', 'Swipe to browse', 'اسحب للتصفح') : tr('Votre dernier document', 'Your latest document', 'أحدث وثيقة')}</span>
      <div className="resource-stack-arrows">
        <button type="button" className="icon-btn" disabled={active === 0} aria-label={tr('Document précédent', 'Previous document', 'الوثيقة السابقة')} onClick={() => controller.current?.step(-1)}><ChevronUp size={16} /></button>
        <button type="button" className="icon-btn" disabled={active === count - 1} aria-label={tr('Document suivant', 'Next document', 'الوثيقة التالية')} onClick={() => controller.current?.step(1)}><ChevronDown size={16} /></button>
      </div>
    </div>
  </div>;
}
