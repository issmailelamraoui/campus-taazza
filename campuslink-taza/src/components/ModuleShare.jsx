import React, { useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, FolderOpen, Hash, LockKeyhole, MessageCircle } from 'lucide-react';
import { useApp } from '../context';
import { Modal } from './ui';
import { COMMUNITY_YEAR_CHANNELS } from '../lib/community';
import './module-share.css';

export function moduleReference(resource) {
  return resource ? { resourceId: String(resource.id), facultyId: resource.facultyId, filiereId: resource.filiereId,
    semester: Number(resource.semester), module: resource.module || '', accessible: true } : null;
}

export function SharedModuleReference({ reference, draft = false }) {
  const { tr, selection } = useApp();
  const accessible = reference.accessible !== false && reference.facultyId === selection?.facultyId && reference.filiereId === selection?.filiereId;
  const content = <>
    <span className="community-module-symbol"><FolderOpen size={21} aria-hidden="true" /></span>
    <span className="community-module-copy"><small>{tr('Module partagé', 'Shared module', 'وحدة مشتركة')}</small>
      <strong dir="auto">{reference.module || tr('Sans module', 'Unclassified', 'بدون وحدة')}</strong>
      <span>S{reference.semester}{!draft && !accessible && ` · ${tr('Indisponible dans votre bibliothèque', 'Unavailable in your library', 'غير متاحة في مكتبتك')}`}</span>
    </span>
    {!draft && (accessible ? <ArrowUpRight size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />)}
  </>;
  if (draft || !accessible) return <div className={`community-shared-module${accessible ? '' : ' is-unavailable'}`}>{content}</div>;
  return <Link className="community-shared-module" to={`/app/library?${new URLSearchParams({ semester: String(reference.semester), module: reference.module || '' })}`}>{content}</Link>;
}

export function ModuleShareDialog({ resource, onClose }) {
  const { tr, user, channels = [], selection } = useApp();
  const navigate = useNavigate();
  const blocked = Boolean(user?.chatBlocked || user?.chat_blocked);
  const canModerate = user?.role === 'global_admin' || user?.administrative_capabilities?.some(scope =>
    scope.facultyId === selection?.facultyId && (!scope.filiereId || scope.filiereId === selection?.filiereId) && scope.capabilities?.includes('content.moderate'));
  const choices = [
    { id: 'general', label: tr('Chat général', 'General chat', 'الدردشة العامة'), icon: MessageCircle },
    { id: 'important', label: tr('Discussions importantes', 'Important discussions', 'مناقشات مهمة'), icon: MessageCircle },
    ...(selection?.filiereId ? COMMUNITY_YEAR_CHANNELS.map(item => ({ ...item, icon: Hash })) : []),
  ];
  return <Modal title={tr('Partager le module', 'Share module', 'مشاركة الوحدة')} onClose={onClose}>
    <div className="module-share-dialog">
      <SharedModuleReference reference={moduleReference(resource)} draft />
      <p className="muted">{tr('Choisissez une discussion, puis ajoutez votre message avant l’envoi.', 'Choose a chat, then add your message before sending.', 'اختر دردشة، ثم أضف رسالتك قبل الإرسال.')}</p>
      {blocked && <p role="status" className="community-attachment-error">{tr('Votre accès aux discussions est suspendu.', 'Your chat access is suspended.', 'وصولك إلى المناقشات معلّق.')}</p>}
      <div className="module-share-destinations" aria-label={tr('Choisir une discussion', 'Choose a chat', 'اختيار دردشة')}>
        {choices.map(({ id, label, icon: Icon }) => {
          const config = channels.find(item => item.id === (id.startsWith('year-') ? 'filiere' : id));
          const readOnly = Boolean(config?.read_only && !canModerate);
          return <button type="button" key={id} disabled={blocked || readOnly} onClick={() => {
            onClose();
            navigate(`/app/community?${new URLSearchParams({ channel: id, share_module: String(resource.id) })}`);
          }}><Icon size={19} aria-hidden="true" /><span>{label}{readOnly && <small>{tr('Lecture seule', 'Read only', 'للقراءة فقط')}</small>}</span>{readOnly ? <LockKeyhole size={15} aria-hidden="true" /> : <ArrowUpRight size={15} aria-hidden="true" />}</button>;
        })}
      </div>
    </div>
  </Modal>;
}

// Moving a finger cancels the hold, so browsing a long module list stays natural.
export function useModuleLongPress(onShare) {
  const hold = useRef({ timer: null, point: null, consumed: false });
  const cancel = () => { clearTimeout(hold.current.timer); hold.current.timer = null; };
  useEffect(() => () => cancel(), []);
  return {
    onPointerDown(event) {
      cancel();
      hold.current.consumed = false;
      if (!['touch', 'pen'].includes(event.pointerType)) return;
      hold.current.point = { x: event.clientX, y: event.clientY };
      hold.current.timer = setTimeout(() => { hold.current.consumed = true; onShare(); }, 550);
    },
    onPointerMove(event) {
      const point = hold.current.point;
      if (point && Math.hypot(event.clientX - point.x, event.clientY - point.y) > 12) cancel();
    },
    onPointerUp: cancel, onPointerCancel: cancel, onPointerLeave: cancel,
    onClickCapture(event) { if (hold.current.consumed) { event.preventDefault(); event.stopPropagation(); hold.current.consumed = false; } },
    onContextMenu(event) { event.preventDefault(); cancel(); onShare(); },
  };
}
