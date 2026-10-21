import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { AlertCircle, ArrowRight, Check, ShieldCheck, X } from 'lucide-react';
import { useApp } from '../context';

function useDismissTimer(id, duration, onDismiss) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const visibility = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  useEffect(() => {
    if (hovered || focused || hidden || duration === null) return;
    const timer = window.setTimeout(() => dismissRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [id, duration, hovered, focused, hidden]);
  return {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onFocusCapture: () => setFocused(true),
    onBlurCapture: event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); },
  };
}

function Toast({ toast, onDismiss, t, tr }) {
  const error = toast.type === 'error';
  const duration = error ? null : Math.min(20000, Math.max(8000, String(toast.message).length * 45));
  const interaction = useDismissTimer(toast.id, duration, onDismiss);
  return <div className="toast" data-type={error ? 'error' : 'success'} {...interaction}>
    <span className="toast-icon" aria-hidden="true">{error ? <AlertCircle size={21} /> : <Check size={21} />}</span>
    <div className="toast-copy" role={error ? 'alert' : 'status'} aria-atomic="true">
      <strong>{error ? tr('Une erreur est survenue', 'Something went wrong', 'حدث خطأ') : tr('Notification', 'Notification', 'إشعار')}</strong>
      <p dir="auto" tabIndex={String(toast.message).length > 180 ? 0 : undefined}>{toast.message}</p>
    </div>
    <button type="button" className="icon-btn" aria-label={t('close')} onClick={onDismiss}><X size={18} /></button>
  </div>;
}

function AdminNotificationPopup({ notification, tr, onOpen, onDismiss }) {
  const interaction = useDismissTimer(notification.id, 12000, () => onDismiss(notification.id));
  return <article className="admin-notification-popup" data-notification-id={notification.id} {...interaction}>
    <span className="admin-notification-popup-icon" aria-hidden="true"><ShieldCheck size={21} /></span>
    <div className="admin-notification-popup-copy">
      <div role="status" aria-atomic="true"><strong dir="auto">{notification.title}</strong><p dir="auto" tabIndex={notification.description?.length > 180 ? 0 : undefined}>{notification.description}</p></div>
      <button type="button" className="admin-notification-popup-open" onClick={() => onOpen(notification)}>
        {tr('Consulter', 'View details', 'عرض التفاصيل')}<ArrowRight size={16} aria-hidden="true" />
      </button>
    </div>
    <button type="button" className="icon-btn admin-notification-popup-close" onClick={() => onDismiss(notification.id)} aria-label={tr('Fermer cette notification', 'Dismiss this notification', 'إغلاق هذا الإشعار')}><X size={18} /></button>
  </article>;
}

export default function NotificationCenter() {
  const { toast, setToast, t, tr, isAdmin, adminNotificationPopups = [], dismissAdminNotificationPopup, openNotification } = useApp();
  const location = useLocation();
  const overlayRef = useRef(null);
  const notices = isAdmin && (location.pathname === '/app' || location.pathname.startsWith('/app/'))
    ? adminNotificationPopups.filter(item => item.popupEligible && item.type === 'administration').slice(0, 3) : [];
  const visible = Boolean(toast || notices.length);
  useLayoutEffect(() => {
    if (!visible) return;
    const viewport = window.visualViewport;
    let frame;
    function update() {
      if (viewport && Math.abs(viewport.scale - 1) > .01) return;
      const overlay = overlayRef.current;
      if (!overlay) return;
      overlay.style.setProperty('--notification-viewport-height', `${viewport?.height || window.innerHeight}px`);
      overlay.style.setProperty('--notification-viewport-top', `${viewport?.offsetTop || 0}px`);
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    update();
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [visible]);
  if (!visible) return null;
  return createPortal(<div className="notification-overlay" ref={overlayRef}>
    {toast && <Toast key={toast.id} toast={toast} t={t} tr={tr} onDismiss={() => setToast(null)} />}
    {notices.length > 0 && <section className="admin-notification-popups" aria-label={tr('Nouvelles notifications administratives', 'New administration notifications', 'إشعارات إدارية جديدة')}>
      {notices.map(notification => <AdminNotificationPopup key={notification.id} notification={notification} tr={tr} onOpen={openNotification} onDismiss={dismissAdminNotificationPopup} />)}
    </section>}
  </div>, document.body);
}
