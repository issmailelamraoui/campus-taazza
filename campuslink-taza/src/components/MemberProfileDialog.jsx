import React from 'react';
import {useApp} from '../context';
import {Modal,Avatar,Badge} from './ui';
import MemberAchievements from './MemberAchievements';

export default function MemberProfileDialog({person,onClose}){
 const {tr}=useApp();
 return <Modal title={tr('Profil étudiant','Student profile','ملف الطالب')} onClose={onClose}><div className="profile-intro"><Avatar name={person.name} src={person.avatar} size="lg"/><div><h2 dir="auto">{person.name}</h2>{person.username&&<p>@{person.username}</p>}<Badge>{tr('Étudiant','Student','طالب')}</Badge></div></div><MemberAchievements userId={person.id}/></Modal>;
}
