import React from 'react';
import { Check, ClipboardList, LockKeyhole, MessageCircle, ShieldCheck, UserCheck, X } from 'lucide-react';
import { Button, EmptyState } from './ui';
import { getFiliere } from '../data/studies';

export function AdminRegistrations({ requests, tr, busy, facultyName, shortDate, onReview }) {
  return <section className="admin-subsection" aria-labelledby="admin-admissions-title">
    <div className="admin-section-header"><div><h2 id="admin-admissions-title">{tr('Demandes d’inscription', 'Registration requests', 'طلبات التسجيل')}</h2><p>{tr('Vérifiez les informations avant d’accepter ou de refuser un étudiant.', 'Review the details before approving or declining a student.', 'راجع المعلومات قبل قبول الطالب أو رفضه.')}</p></div></div>
    <div className="card admin-report-list">
      {!requests.length ? <EmptyState icon={ClipboardList} title={tr('Aucune demande d’inscription', 'No registration requests', 'لا توجد طلبات تسجيل')} /> : requests.map(item => <article key={item.id} className="admin-report-row" data-registration-id={item.id}>
        <span className="admin-task-icon"><ClipboardList size={18} /></span>
        <div className="admin-report-copy"><div><h3 dir="auto">{item.name}</h3><span className={`admin-status ${item.account_status}`}>{item.account_status === 'pending' ? tr('En attente', 'Pending', 'في الانتظار') : tr('Refusée', 'Declined', 'مرفوض')}</span></div><p dir="auto">@{item.username} · {item.email}<br />{facultyName(item.faculty_id)} · {getFiliere(item.filiere_id)?.name || '—'} · S{item.current_semester}</p><span>{shortDate(item.registered_at)}</span></div>
        <div className="admin-admission-actions"><Button disabled={Boolean(busy)} variant="primary" icon={Check} onClick={() => onReview(item, 'approved')}>{busy === `admission-${item.id}` ? tr('Enregistrement…', 'Saving…', 'جارٍ الحفظ…') : tr('Accepter', 'Approve', 'قبول')}</Button>{item.account_status === 'pending' && <Button disabled={Boolean(busy)} variant="secondary" icon={X} onClick={() => onReview(item, 'rejected')}>{busy === `admission-${item.id}` ? tr('Enregistrement…', 'Saving…', 'جارٍ الحفظ…') : tr('Refuser', 'Decline', 'رفض')}</Button>}</div>
      </article>)}
    </div>
  </section>;
}

export function AdminChannels({ channels, tr, busy, facultyName, onEdit }) {
  return <section className="admin-subsection" aria-labelledby="admin-channels-title">
    <div className="admin-section-header"><div><h2 id="admin-channels-title">{tr('Réglages des discussions', 'Discussion settings', 'إعدادات المناقشات')}</h2><p>{tr('Nom, description et droits de publication par établissement.', 'Name, description and publication rights per faculty.', 'الاسم والوصف وحقوق النشر حسب الكلية.')}</p></div></div>
    <div className="admin-announcement-list">{channels.map(channel => <article className="card admin-announcement-card" key={`${channel.faculty_id}-${channel.id}`} data-channel-id={channel.id} data-faculty-id={channel.faculty_id}>
      <div className="admin-announcement-top"><span className="admin-announcement-scope">{facultyName(channel.faculty_id)}</span><span className="admin-status">{channel.read_only ? tr('Lecture seule', 'Read only', 'للقراءة فقط') : tr('Échanges ouverts', 'Open discussion', 'مناقشة مفتوحة')}</span></div>
      <h3 dir="auto"><MessageCircle size={16} /> {channel.name}</h3><p className="admin-announcement-excerpt" dir="auto">{channel.description || '—'}</p>
      <div className="admin-announcement-footer"><span>{channel.read_only ? tr('Publication réservée aux administrateurs et modérateurs.', 'Only administrators and moderators can publish.', 'النشر متاح للإدارة والمشرفين فقط.') : tr('Les étudiants peuvent publier.', 'Students can publish.', 'يمكن للطلبة النشر.')}</span><Button disabled={Boolean(busy)} variant="secondary" onClick={() => onEdit(channel)}>{tr('Configurer', 'Configure', 'إعداد')}</Button></div>
    </article>)}</div>
  </section>;
}

export function AdminChatBlocks({ accounts, blocks, userId, tr, busy, onToggle }) {
  const blocked = new Set(blocks.map(item => String(item.user_id)));
  const eligible = accounts.filter(item => item.account_status === 'approved' && item.facultyId && item.role !== 'global_admin' && String(item.id) !== String(userId));
  return <section className="admin-subsection" aria-labelledby="admin-chat-blocks-title">
    <div className="admin-section-header"><div><h2 id="admin-chat-blocks-title">{tr('Accès aux discussions', 'Discussion access', 'الوصول إلى المناقشات')}</h2><p>{tr('Bloquez ou rétablissez les discussions sans fermer le compte étudiant.', 'Block or restore discussions without closing the student account.', 'احظر المناقشات أو استعدها دون إغلاق حساب الطالب.')}</p></div></div>
    <div className="card admin-resource-list">{!eligible.length ? <EmptyState icon={ShieldCheck} title={tr('Aucun compte dans cette vue', 'No accounts in this view', 'لا توجد حسابات في هذا العرض')} /> : eligible.map(item => <article className="admin-resource-row" key={item.id} data-chat-user-id={item.id}>
      <span className="admin-document-icon">{blocked.has(item.id) ? <LockKeyhole size={18} /> : <UserCheck size={18} />}</span><div className="admin-resource-title"><strong dir="auto">{item.name}</strong><span>@{item.username}</span></div><span className="admin-status">{blocked.has(item.id) ? tr('Discussions bloquées', 'Discussions blocked', 'المناقشات محظورة') : tr('Accès autorisé', 'Access allowed', 'الوصول مسموح')}</span><Button disabled={Boolean(busy)} variant="secondary" onClick={() => onToggle(item, !blocked.has(item.id))}>{blocked.has(item.id) ? tr('Débloquer', 'Unblock', 'إلغاء الحظر') : tr('Bloquer', 'Block', 'حظر')}</Button>
    </article>)}</div>
  </section>;
}

