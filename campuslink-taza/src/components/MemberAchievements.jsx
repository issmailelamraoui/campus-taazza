import React,{useEffect,useState} from 'react';
import {Award} from 'lucide-react';
import {api} from '../api';
import {useApp} from '../context';
import {Badge} from './ui';

export default function MemberAchievements({userId}){
 const {tr}=useApp();const [badges,setBadges]=useState([]),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{const changed=()=>setRevision(value=>value+1);window.addEventListener('campus-xp-updated',changed);return()=>window.removeEventListener('campus-xp-updated',changed);},[]);
 useEffect(()=>{const controller=new AbortController();let live=true;setBadges([]);setError('');if(userId)api(`/members/${encodeURIComponent(userId)}/achievements`,{signal:controller.signal}).then(data=>{if(live)setBadges(data.achievements||[]);}).catch(error=>{if(live)setError(error.message);});return()=>{live=false;controller.abort();};},[userId,revision]);
 const names={first_steps:tr('Premiers pas','First Steps','الخطوات الأولى'),book_explorer:tr('Explorateur de livres','Book Explorer','مستكشف الكتب'),knowledge_collector:tr('Collectionneur de connaissances','Knowledge Collector','جامع المعارف'),helping_hand:tr('Coup de main','Helping Hand','يد المساعدة'),campus_mentor:'Campus Mentor',community_hero:tr('Héros de la communauté','Community Hero','بطل المجتمع'),syntax_master:tr('Maître de la syntaxe','Syntax Master','متقن بناء الشفرة'),note_keeper:tr('Gardien des notes','Note Keeper','حافظ الملاحظات')};
 const tiers={bronze:tr('Bronze','Bronze','برونزي'),silver:tr('Argent','Silver','فضي'),gold:tr('Or','Gold','ذهبي')};
 if(error)return <p className="muted" role="status">{tr('Badges temporairement indisponibles.','Badges are temporarily unavailable.','الشارات غير متاحة مؤقتاً.')} <button type="button" className="text-link" onClick={()=>setRevision(value=>value+1)}>{tr('Réessayer','Retry','إعادة المحاولة')}</button></p>;
 if(!badges.length)return null;
 return <section aria-label={tr('Badges obtenus','Earned badges','الشارات المكتسبة')} style={{margin:'0 0 20px'}}><h3 style={{fontSize:13,display:'flex',alignItems:'center',gap:7}}><Award size={16}/>{tr('Badges obtenus','Earned badges','الشارات المكتسبة')}</h3><div style={{display:'flex',flexWrap:'wrap',gap:8}}>{badges.map(badge=><Badge key={badge.id}>{names[badge.id]||badge.title} · {tiers[badge.tier]||badge.tier}</Badge>)}</div></section>;
}
