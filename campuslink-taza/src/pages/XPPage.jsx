import React,{useEffect,useState} from 'react';
import {api} from '../api';
import {formatDate} from '../i18n';
import {useApp} from '../context';
import {PageHeader,Button,Badge,EmptyState} from '../components/ui';
import './campus.css';
export default function XPPage(){
 const {tr,language,user,updateProfile,notify,lowData}=useApp();
 const [snapshot,setSnapshot]=useState(null),[failure,setFailure]=useState(null),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
 const scopeKey=JSON.stringify([user.id,user.facultyId||user.faculty_id,user.filiereId||user.filiere_id]);
 const data=snapshot?.scopeKey===scopeKey?snapshot.value:null;
 const error=failure?.scopeKey===scopeKey?failure.message:'';
 useEffect(()=>{
  let pending;
  const changed=event=>{
   if(event?.detail?.userId&&String(event.detail.userId)!==String(user.id))return;
   if(document.visibilityState==='hidden'||navigator.onLine===false)return;
   clearTimeout(pending);pending=setTimeout(()=>setRevision(value=>value+1),150);
  };
  const events=['campus-xp-updated','focus','online','pageshow'];
  events.forEach(name=>window.addEventListener(name,changed));
  document.addEventListener('visibilitychange',changed);
  const timer=setInterval(changed,lowData?90000:30000);
  return()=>{clearTimeout(pending);clearInterval(timer);events.forEach(name=>window.removeEventListener(name,changed));document.removeEventListener('visibilitychange',changed);};
 },[user.id,lowData]);
 useEffect(()=>{
  const controller=new AbortController();let live=true;
  api('/xp',{signal:controller.signal}).then(value=>{if(live){setSnapshot({scopeKey,value});setFailure(null);}}).catch(error=>{if(live&&error.name!=='AbortError')setFailure({scopeKey,message:error.message});});
  return()=>{live=false;controller.abort();};
 },[scopeKey,user.validated_xp,user.preferences?.ranking,revision]);
 const labels={reading:tr('Étude','Study','الدراسة'),help:tr('Entraide','Help','المساعدة'),contribution:tr('Contribution','Contribution','المساهمة'),practice:tr('Pratique','Practice','الممارسة')};
 const level=data?.level,span=level?Math.max(1,level.next_threshold-level.threshold):1;
 const progress=level?Math.max(0,Math.min(span,level.xp-level.threshold)):0;
 const remaining=level?Math.max(0,level.next_threshold-level.xp):0;
 return <div className="xp-page">
  <PageHeader title={tr('Campus XP','Campus XP','نقاط الفضاء الجامعي')} description={tr('Vos activités et vos fichiers partagés font progresser votre niveau. Consultez les points, les badges et leur historique.','Your activities and shared files build your level. See your points, badges and history.','تساهم أنشطتك وملفاتك المشتركة في تقدم مستواك. تابع النقاط والشارات وسجلها.')} actions={<Button onClick={()=>setRevision(value=>value+1)}>{tr('Actualiser','Refresh','تحديث')}</Button>}/>
  {error&&<p className="notice" role="alert">{error}</p>}
  {!data&&!error&&<p className="campus-loading" role="status">{tr('Chargement…','Loading…','جارٍ التحميل…')}</p>}
  {data&&<>
   <div className="xp-breakdown"><div className="xp-total" data-testid="xp-total"><strong aria-live="polite">{data.xp}</strong>XP</div>{Object.entries(labels).map(([key,label])=><div key={key}><strong>{data.breakdown[key]||0}</strong>{label}</div>)}</div>
   {level&&<section className="xp-level" data-total-xp={level.xp} aria-label={tr('Mon niveau','My level','مستواي')}>
    <div className="xp-level-heading"><strong>{tr('Niveau','Level','المستوى')} {level.number}</strong><span>{level.xp} / {level.next_threshold} XP</span></div>
    <progress aria-label={tr('Progression vers le prochain niveau','Progress to next level','التقدم نحو المستوى التالي')} aria-valuetext={`${progress} / ${span} XP`} value={progress} max={span}/>
    <p>{tr(`Encore ${remaining} XP pour le niveau ${level.number+1}.`,`${remaining} XP to reach level ${level.number+1}.`,`باقي ${remaining} نقطة للوصول إلى المستوى ${level.number+1}.`)}</p>
   </section>}
   {data.upload_policy&&<section className="card xp-file-policy">
    <h2>{tr('Vos fichiers font la différence','Your files make a difference','ملفاتك تصنع الفرق')}</h2>
    <p>{tr(`Chaque nouveau fichier admissible partagé dans la bibliothèque rapporte ${data.upload_policy.points_per_file} XP, jusqu’à ${data.upload_policy.daily_cap} XP par jour.`,`Each eligible new file shared in the library earns ${data.upload_policy.points_per_file} XP, up to ${data.upload_policy.daily_cap} XP per day.`,`كل ملف جديد مؤهل تشاركه في المكتبة يمنحك ${data.upload_policy.points_per_file} نقاط، حتى ${data.upload_policy.daily_cap} نقطة يومياً.`)}</p>
    <p>{tr('Un simple signalement ne retire aucun point. Les points du fichier et la progression du badge sont retirés après confirmation par l’administration ou retrait du fichier. Les doublons ne rapportent pas de points supplémentaires.','A report alone removes no points. File points and badge progress are removed after administrative confirmation or file removal. Duplicate files earn no extra points.','التبليغ وحده لا يسحب أي نقطة. تُسحب نقاط الملف وتقدّم الشارة بعد تأكيد الإدارة أو سحب الملف. لا تمنح الملفات المكررة نقاطاً إضافية.')}</p>
    {data.file_contributions&&<div className="xp-file-contributions"><span>{tr('Fichiers récompensés','Rewarded files','ملفات مُكافأة')} <strong>{data.file_contributions.files}</strong></span><span>{tr('Points restants aujourd’hui','Points available today','النقاط المتبقية اليوم')} <strong>{data.file_contributions.today_remaining} / {data.upload_policy.daily_cap}</strong></span></div>}
   </section>}
   <p className="muted">{tr('Le niveau décrit l’activité reconnue ; il ne mesure pas la maîtrise académique.','Levels describe recognized activity; they do not measure academic mastery.','يعبر المستوى عن النشاط المعترف به، ولا يقيس التمكن الدراسي.')}</p>
   <AchievementCards achievements={data.achievements||[]}/>
   <Button disabled={busy} onClick={async()=>{setBusy(true);try{await updateProfile({preferences:{ranking:user.preferences?.ranking===false}});}catch(error){notify(error.message,'error');}finally{setBusy(false);}}}>{user.preferences?.ranking===false?tr('Afficher mon profil au classement','Show my profile in ranking','إظهار ملفي في الترتيب'):tr('Masquer mon profil du classement','Hide my profile from ranking','إخفاء ملفي من الترتيب')}</Button>
   <h2 style={{marginTop:24}}>{tr('Classement de ma faculté','Faculty ranking','ترتيب كليتي')}</h2>
   <p className="muted">{tr('Étude, entraide et contribution : 100 %. La pratique compte dans la limite de 25 % de ces activités. Les ex æquo partagent le même rang.','Study, help, and contributions count fully. Practice counts up to 25% of those activities. Tied scores share a rank.','الدراسة والمساعدة والمساهمة تحسب بالكامل. تحتسب الممارسة حتى 25% من هذه الأنشطة. تتشارك الدرجات المتساوية الرتبة.')}</p>
   <div className="campus-thread">{data.ranking.map((item,index)=><article key={item.id}><strong>{item.rank??index+1}. {item.name}</strong><p>{item.ranking_score} {tr('points de classement','ranking points','نقاط ترتيب')} · {item.xp} XP</p></article>)}{!data.ranking.length&&<EmptyState title={tr('Le classement attend ses premières contributions','The ranking is ready for its first contributions','الترتيب جاهز للمساهمات الأولى')}/>}</div>
   <h2>{tr('Historique personnel','Personal ledger','السجل الشخصي')}</h2>
   <div className="campus-thread xp-events">{data.events.map(event=><article key={event.id} className={`xp-event${event.status==='revoked'?' is-revoked':''}`} data-xp-status={event.status}><Badge>{labels[event.category]}</Badge><p><strong>{event.status==='valid'?'+':'−'}{event.points} XP</strong> · {event.status==='valid'?tr('Validée','Validated','معتمدة'):tr('Révoquée · points retirés du total','Revoked · points removed from total','ملغاة · سُحبت النقاط من المجموع')}</p><time dateTime={event.created_at}>{formatDate(event.created_at,language,{day:'numeric',month:'short',year:'numeric',timeZone:'Africa/Casablanca'})}</time></article>)}{!data.events.length&&<EmptyState title={tr('Aucune activité enregistrée pour le moment','No recorded activity yet','لا توجد أنشطة مسجلة بعد')}/>}</div>
  </>}
 </div>;
}

function AchievementCards({achievements}){
 const {tr}=useApp();
 const names={library_contributor:tr('Contributeur de la bibliothèque','Library Contributor','مساهم المكتبة'),first_steps:tr('Premiers pas','First Steps','الخطوات الأولى'),book_explorer:tr('Explorateur de livres','Book Explorer','مستكشف الكتب'),knowledge_collector:tr('Collectionneur de connaissances','Knowledge Collector','جامع المعارف'),helping_hand:tr('Coup de main','Helping Hand','يد المساعدة'),campus_mentor:tr('Mentor du campus','Campus Mentor','مرشد الفضاء الجامعي'),community_hero:tr('Héros de la communauté','Community Hero','بطل المجتمع'),syntax_master:tr('Maître de la syntaxe','Syntax Master','متقن بناء الشفرة'),note_keeper:tr('Gardien des notes','Note Keeper','حافظ الملاحظات')};
 const requirements={
 library_contributor:tr('Fichiers distincts récompensés et disponibles dans la bibliothèque : 5 pour le bronze, 20 pour l’argent, 50 pour l’or. Une confirmation de signalement ou un retrait peut réduire la progression.','Distinct rewarded files available in the library: 5 for bronze, 20 for silver, 50 for gold. A confirmed report or removal may reduce progress.','ملفات مختلفة مُكافأة ومتاحة في المكتبة: 5 للبرونز و20 للفضة و50 للذهب. قد يتراجع التقدم بعد تأكيد بلاغ أو سحب ملف.'),
 first_steps:tr('Un premier événement XP validé par le serveur.','One first server-validated XP event.','أول نشاط XP معتمد من الخادم.'),
 book_explorer:tr('Pages PDF distinctes et vérifiées, avec une minute de lecture éligible. Les paliers demandent plusieurs documents. Ce suivi ne prouve pas la compréhension.','Distinct verified PDF pages with one minute of eligible reading. Higher tiers require multiple documents. This activity does not prove comprehension.','صفحات PDF مختلفة ومتحقق منها مع دقيقة قراءة مؤهلة. تتطلب المستويات الأعلى عدة مستندات. لا يثبت هذا النشاط الفهم.'),
 helping_hand:tr('Sessions CloseRoom utiles et validées : au moins deux minutes et quatre messages entre les deux participants, avec une évaluation positive.','Validated useful CloseRoom sessions: at least two minutes and four messages between both participants, with a positive rating.','جلسات CloseRoom مفيدة ومعتمدة: دقيقتان وأربع رسائل على الأقل بين المشاركين مع تقييم إيجابي.'),
 campus_mentor:tr('Cinq aides utiles validées pour au moins trois personnes sur trois jours différents. Ce badge ne donne aucun droit administratif.','Five validated useful sessions for at least three people across three different days. This badge grants no administrative rights.','خمس جلسات مساعدة مفيدة ومعتمدة لثلاثة أشخاص على الأقل خلال ثلاثة أيام مختلفة. لا تمنح الشارة صلاحيات إدارية.'),
 community_hero:tr('Réponses Forum acceptées et XP validé grâce à des retours indépendants. Publier, accepter ou voter seul ne suffit pas.','Accepted Forum answers with validated XP and independent feedback. Posting, acceptance or a single vote is insufficient.','إجابات Forum مقبولة بنقاط معتمدة وتقييمات مستقلة. النشر أو القبول أو تصويت واحد غير كافٍ.'),
 note_keeper:tr('Notes distinctes inchangées depuis 24 heures : au moins 120 caractères, 16 mots et 10 mots différents. Les titres seuls, les doublons et les seuls changements de nombres ne comptent pas. Aucun XP ne récompense le remplissage.','Distinct notes unchanged for 24 hours: at least 120 characters, 16 words and 10 different words. Titles alone, duplicates and number-only changes do not count. Filling notes earns no XP.','ملاحظات مختلفة لم تتغير منذ 24 ساعة: 120 حرفاً و16 كلمة و10 كلمات مختلفة على الأقل. لا تحتسب العناوين وحدها أو النسخ المتكررة أو تغيير الأرقام فقط. لا يمنح ملء الملاحظات نقاط XP.'),
 knowledge_collector:tr('Notes, extraits et références substantiels inchangés depuis 24 heures, liés à des sources existantes. Collections distinctes conservées sans modification 24 heures contenant au moins trois documents. Aucun XP pour remplir une collection.','Substantive notes, excerpts and references unchanged for 24 hours and linked to existing sources. Distinct collections retained unchanged for 24 hours contain at least three documents. Filling collections earns no XP.','ملاحظات ومقتطفات ومراجع ذات محتوى لم تتغير منذ 24 ساعة ومرتبطة بمصادر موجودة. مجموعات مختلفة لم تتغير منذ 24 ساعة وتحتوي ثلاثة مستندات على الأقل. لا يمنح ملء المجموعات نقاط XP.'),
 syntax_master:tr('Programmes JavaScript distincts avec récompense Labs validée, empreinte persistée, syntaxe finale correcte, deux révisions et 90 secondes. La syntaxe ne garantit pas la justesse logique.','Distinct JavaScript programs with validated Labs rewards, saved fingerprints, final valid syntax, two revisions and 90 seconds. Syntax does not guarantee logical correctness.','برامج JavaScript مختلفة بمكافآت Labs معتمدة وبصمات محفوظة وصياغة نهائية سليمة ومراجعتين و90 ثانية. لا تضمن سلامة الصياغة صحة المنطق.')
 };
 const progressNames={files:tr('Fichiers partagés','Shared files','ملفات مشتركة'),collections:tr('Collections distinctes','Distinct collections','مجموعات مختلفة'),events:tr('Événements validés','Validated events','أنشطة معتمدة'),pages:tr('Pages distinctes','Distinct pages','صفحات مختلفة'),documents:tr('Documents distincts','Distinct documents','مستندات مختلفة'),rooms:tr('Aides utiles validées','Validated useful sessions','جلسات مساعدة معتمدة'),requesters:tr('Personnes aidées','People helped','أشخاص تمت مساعدتهم'),days:tr('Jours distincts','Distinct days','أيام مختلفة'),answers:tr('Réponses reconnues','Recognized answers','إجابات معتمدة'),notes:tr('Notes personnelles','Personal notes','ملاحظات شخصية'),sources:tr('Sources distinctes','Distinct sources','مصادر مختلفة'),items:tr('Éléments personnels','Personal items','عناصر شخصية'),programs:tr('Programmes distincts','Distinct programs','برامج مختلفة'),references:tr('Références personnelles','Personal references','مراجع شخصية')};
 const tierLabel=tier=>({bronze:tr('Bronze','Bronze','برونزي'),silver:tr('Argent','Silver','فضي'),gold:tr('Or','Gold','ذهبي')})[tier]||tr('À obtenir','Not earned yet','لم يُكتسب بعد');
 return <><h2>{tr('Réussites et badges','Achievements and badges','الإنجازات والشارات')}</h2><p className="muted">{tr('Les badges décrivent une activité reconnue et ne donnent aucun droit administratif.','Badges describe recognized activity and grant no administrative rights.','تعبر الشارات عن نشاط معترف به ولا تمنح صلاحيات إدارية.')}</p><div className="xp-achievements">{achievements.map(a=><article className={`card xp-achievement ${a.earned?'earned':''}`} key={a.id} data-achievement={a.id}><div><h3>{names[a.id]||a.title}</h3><Badge>{tierLabel(a.tier)}</Badge></div><p>{requirements[a.id]||a.requirements}</p><dl>{Object.entries(a.targets).map(([key,target])=><div key={key}><dt>{progressNames[key]||key}</dt><dd>{a.progress[key]||0} / {target}</dd></div>)}</dl><details><summary>{tr('Tous les paliers','All tiers','جميع المستويات')}</summary>{a.tiers.map(tier=><p key={tier.tier}>{tierLabel(tier.tier)} · {Object.entries(tier.targets).map(([key,target])=>`${target} ${progressNames[key]||key}`).join(' · ')}</p>)}</details></article>)}</div></>;
}
