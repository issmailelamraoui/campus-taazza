import React from 'react';
import { Check, ClipboardList, Users, X } from 'lucide-react';
import { getFiliere } from '../../shared/studies.js';

export default function RegistrationRequests({requests,t,busy,facultyName,dateLabel,onReview}) {
  return <div className="admin-tab-content">
    <div className="admin-content-header"><h2>{t('registrationRequests',"Demandes d’inscription")}</h2><p className="muted">{t('reviewRegistrationHint','Examinez les informations avant d’accepter ou de refuser.')}</p></div>
    {!requests.length ? <div className="admin-empty"><span><Users size={27}/></span><h3>{t('noRegistrationRequests','Aucune demande d’inscription')}</h3><p>{t('registrationRequestsEmpty','Les nouvelles inscriptions apparaîtront ici.')}</p></div> : <div className="admin-report-list">
      {requests.map(student=><article key={student.id} className="admin-report-card" data-registration-id={student.id}>
        <div className="admin-report-top"><span className={`admin-badge ${student.account_status==='pending'?'open':''}`}><ClipboardList size={13}/>{t(student.account_status==='pending'?'registrationAwaiting':'registrationRefused',student.account_status==='pending'?'En attente de validation':'Refusée')}</span><time>{dateLabel(student.registered_at)}</time></div>
        <h3 dir="auto">{student.name}</h3><p dir="auto">@{student.username} · {student.email}</p>
        <p dir="auto">{facultyName(student.faculty_id)} · {getFiliere(student.filiere_id)?.name} · S{student.current_semester}</p>
        {student.account_status==='pending'&&<div className="admin-report-actions">
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={()=>onReview(student,'approved')}><Check size={16}/>{t('approveRegistration','Accepter')}</button>
          <button type="button" className="admin-text-button danger" disabled={Boolean(busy)} onClick={()=>onReview(student,'rejected')}><X size={16}/>{t('rejectRegistration','Refuser')}</button>
        </div>}
      </article>)}
    </div>}
  </div>;
}
