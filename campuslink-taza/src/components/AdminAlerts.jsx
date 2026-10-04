import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Flag, Mail, X } from 'lucide-react';
import { useApp } from '../context.jsx';
import { api } from '../api.js';
import { readNotifications } from '../optimistic.js';
import { isAdminInboxNotification } from '../admin-notifications.js';
import './admin-alerts.css';

function AdminAlert({ notification, dismiss }) {
  const { t, optimisticAction, toast } = useApp();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismiss(notification.id), 12000);
    return () => clearTimeout(timer);
  }, [notification.id, dismiss, paused]);
  const tab = new URL(notification.path, location.origin).searchParams.get('tab');
  const Icon = tab === 'registrations' ? ClipboardList : tab === 'contacts' ? Mail : Flag;
  const reasonKeys = { incorrect: 'incorrectResource', duplicate: 'duplicateFile', classification: 'wrongClassification', broken: 'brokenFile' };
  const body = t(tab === 'reports' ? reasonKeys[notification.body] || notification.body : notification.body, notification.body);
  const open = () => {
    dismiss(notification.id);
    optimisticAction({ key: `notification-${notification.id}`, apply: data => readNotifications(data, [notification.id]), request: () => api('/notifications/read', { method: 'POST', body: { ids: [notification.id] } }) }).catch(error => toast(error.message, 'error'));
  };
  return <article className={`admin-incoming-alert inbox-${tab || 'reports'}`} data-notification-id={notification.id}
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
    <span className="admin-incoming-icon"><Icon size={22} aria-hidden="true" /></span>
    <div className="admin-incoming-copy"><span>{t('newAdminRequest', 'Nouveau message pour vous')}</span><strong>{t(notification.title, notification.title)}</strong><p dir="auto">{body}</p><Link to={notification.path} onClick={open}>{t('viewAdminRequest', 'Voir la demande')}</Link></div>
    <button type="button" className="admin-incoming-close" onClick={() => dismiss(notification.id)} aria-label={t('dismissNotification', 'Fermer la notification')}><X size={18} /></button>
  </article>;
}

export default function AdminAlerts() {
  const { user, adminAlerts, dismissAdminAlert, t } = useApp();
  const owner = user ? `${user.id}:${user.faculty_id}:${user.role}` : '';
  const visible = adminAlerts.filter(item => item._inboxOwner === owner && isAdminInboxNotification(user, item));
  return <aside className="admin-incoming-alerts" aria-label={t('adminIncomingAlerts', 'Nouvelles demandes administratives')} aria-live="polite" aria-relevant="additions">
    {visible.map(notification => <AdminAlert key={notification.id} notification={notification} dismiss={dismissAdminAlert} />)}
  </aside>;
}
