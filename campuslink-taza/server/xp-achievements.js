// Achievements are projections of validated events. Revoking an event removes
// its progress on the next request; no second badge store can drift from XP.
const numeric=value=>Number(value)||0;
const stage=(tier,targets)=>({tier,targets});
function achievement(id,title,requirements,progress,tiers){
  const met=tiers.filter(t=>Object.entries(t.targets).every(([key,target])=>progress[key]>=target));
  const earned=met.at(-1)||null;
  return {id,title,requirements,progress,tiers,earned:!!earned,tier:earned?.tier||null,targets:(tiers[met.length]||earned||tiers[0]).targets};
}
export function xpLevel(xp){
  xp=Math.max(0,Math.floor(numeric(xp)));
  const number=Math.floor(Math.sqrt(xp/100))+1;
  return {number,xp,threshold:(number-1)**2*100,next_threshold:number**2*100};
}
const HELP_METRICS_SQL=`SELECT e.user_id,COUNT(*) AS rooms,COUNT(DISTINCT r.requester_id) AS requesters,
    COUNT(DISTINCT to_char(e.created_at::timestamptz AT TIME ZONE 'Africa/Casablanca','YYYY-MM-DD')) AS days
  FROM xp_events e JOIN close_rooms r ON e.event_key='closeroom:'||r.id::text||':help'
  JOIN LATERAL (SELECT COUNT(*) AS messages,COUNT(DISTINCT m.author_id) AS authors FROM close_messages m
    WHERE m.room_id=r.id AND m.author_id IN(r.requester_id,r.helper_id)) stats ON TRUE
  WHERE e.user_id=ANY(?) AND e.status='valid' AND e.category='help' AND r.helper_id=e.user_id
    AND e.actor_id=r.requester_id AND e.details->>'room_id'=r.id::text
    AND r.help_rating IN('helpful','very_helpful') AND e.details->>'rating'=r.help_rating
    AND e.points=CASE r.help_rating WHEN 'very_helpful' THEN 15 ELSE 10 END
    AND r.closed_at IS NOT NULL AND r.closed_at::timestamptz-r.created_at::timestamptz>=INTERVAL '2 minutes'
    AND stats.messages>=4 AND stats.authors=2 GROUP BY e.user_id`;
const mentorEligible=row=>numeric(row?.rooms)>=5&&numeric(row?.requesters)>=3&&numeric(row?.days)>=3;
export async function publicMentorBadgesForUsers(db,userIds){
  const ids=[...new Set(userIds.filter(Number.isSafeInteger))];
  if(!ids.length)return new Map();
  const [rows,files]=await Promise.all([
    db.prepare(HELP_METRICS_SQL).all(ids),
    db.prepare(`SELECT user_id,COUNT(*)::integer AS files FROM xp_events
      WHERE user_id=ANY(?) AND category='contribution' AND status='valid'
        AND details->>'evidence'='published_library_file' GROUP BY user_id HAVING COUNT(*)>=5`).all(ids),
  ]);
  const result=new Map(rows.filter(mentorEligible).map(row=>[row.user_id,[{id:'campus_mentor',title:'Campus Mentor',tier:'bronze'}]]));
  for(const row of files)result.set(row.user_id,[...(result.get(row.user_id)||[]),{id:'library_contributor',title:'Library Contributor',tier:row.files>=50?'gold':row.files>=20?'silver':'bronze'}]);
  return result;
}
export async function validatedAchievements(db,userId){
  const retainedBefore=new Date(Date.now()-86400000).toISOString();
  const [ledger,reading,helpRows,contribution,knowledge,collections,syntax,files]=await Promise.all([
    db.prepare("SELECT COUNT(*) AS events,COALESCE(SUM(points),0) AS points FROM xp_events WHERE user_id=? AND status='valid'").get(userId),
    db.prepare(`SELECT COUNT(*) AS pages,COUNT(DISTINCT i.resource_id) AS documents
      FROM xp_events e JOIN document_text_indexes i
        ON e.details->>'resource_id'=i.resource_id::text AND e.details->>'document_version'=i.document_version::text
      WHERE e.user_id=? AND e.status='valid' AND e.category='reading' AND e.points=1
        AND e.details->>'evidence'='bounded_visible_reading_opportunity' AND e.details->>'qualified_seconds'='60'
        AND CASE WHEN e.details->>'page' ~ '^[1-9][0-9]{0,2}$' THEN (e.details->>'page')::integer END BETWEEN 1 AND i.page_count
        AND e.event_key='reading:'||i.resource_id::text||':v'||i.document_version::text||':p'||(e.details->>'page')`).get(userId),
    db.prepare(HELP_METRICS_SQL).all([userId]),
    db.prepare(`SELECT COUNT(*) AS answers,COUNT(DISTINCT q.author_id) AS requesters
      FROM xp_events e JOIN campus_questions q ON e.event_key='forum:question:'||q.id::text||':accepted'
      JOIN campus_answers a ON a.question_id=q.id AND e.details->>'answer_id'=a.id::text
      WHERE e.user_id=? AND e.status='valid' AND e.category='contribution' AND e.points=5
        AND e.details->>'evidence'='accepted_answer_and_independent_feedback'
        AND e.details->>'question_id'=q.id::text AND e.details->>'requester_id'=q.author_id::text
        AND a.author_id=e.user_id AND q.author_id<>e.user_id`).get(userId),
    db.prepare(`WITH normalized AS (
        SELECT k.*,trim(regexp_replace(regexp_replace(lower(normalize(CASE WHEN kind='note' THEN content ELSE concat_ws(' ',content,selected_text) END,NFKC)),
          '[^[:alnum:][:space:]]+',' ','g'),'[[:space:]]+',' ','g')) AS text_key
        FROM knowledge_items k WHERE user_id=? AND kind IN('note','excerpt','reference') AND created_at<=? AND updated_at<=?
      ), substantive AS (
        SELECT n.* FROM normalized n JOIN LATERAL (
          SELECT COUNT(*) AS words,COUNT(DISTINCT token) AS vocabulary FROM regexp_split_to_table(n.text_key,' ') token WHERE token ~ '[[:alpha:]]'
        ) tokens ON TRUE WHERE char_length(n.text_key)>=120 AND tokens.words>=16 AND tokens.vocabulary>=10
      ), deduplicated AS (
        SELECT DISTINCT ON(md5(regexp_replace(text_key,'[[:digit:]]+','#','g'))) * FROM substantive
          ORDER BY md5(regexp_replace(text_key,'[[:digit:]]+','#','g')),(kind='note') DESC,created_at,id
      ) SELECT COUNT(*) FILTER(WHERE d.kind='note') AS notes,
        COUNT(DISTINCT to_char(d.created_at::timestamptz AT TIME ZONE 'Africa/Casablanca','YYYY-MM-DD')) FILTER(WHERE d.kind='note') AS days,
        COUNT(*) FILTER(WHERE r.id IS NOT NULL) AS items,COUNT(DISTINCT r.id) AS sources
      FROM deduplicated d LEFT JOIN resources r ON r.id=d.resource_id`).get(userId,retainedBefore,retainedBefore),
    db.prepare(`WITH source_sets AS (
      SELECT t.id,array_agg(DISTINCT r.id ORDER BY r.id) AS sources FROM study_tools t
      JOIN LATERAL (
        SELECT item->>'type' AS type,item->>'id' AS id FROM jsonb_array_elements(COALESCE(t.data::jsonb->'items','[]'::jsonb)) item
        UNION SELECT 'resource',jsonb_array_elements_text(COALESCE(t.data::jsonb->'resourceIds','[]'::jsonb))
        UNION SELECT 'knowledge',jsonb_array_elements_text(COALESCE(t.data::jsonb->'knowledgeIds','[]'::jsonb))
      ) reference ON TRUE
      LEFT JOIN knowledge_items k ON reference.type='knowledge' AND reference.id=k.id AND k.user_id=t.user_id
      JOIN resources r ON r.id::text=CASE WHEN reference.type='resource' THEN reference.id ELSE k.resource_id::text END
      WHERE t.user_id=? AND t.kind='collection' AND t.created_at<=? AND t.updated_at<=? GROUP BY t.id HAVING COUNT(DISTINCT r.id)>=3
      ) SELECT COUNT(DISTINCT sources::text) AS collections FROM source_sets`).get(userId,retainedBefore,retainedBefore),
    db.prepare(`SELECT COUNT(DISTINCT p.fingerprint) AS programs,
        COUNT(DISTINCT to_char(e.created_at::timestamptz AT TIME ZONE 'Africa/Casablanca','YYYY-MM-DD')) AS days
      FROM xp_events e JOIN labs_sessions s ON e.event_key='labs:'||s.id::text AND s.user_id=e.user_id
      JOIN labs_rewarded_programs p ON p.user_id=s.user_id AND p.session_id=s.id AND p.fingerprint=s.successful_fingerprint
      WHERE e.user_id=? AND e.status='valid' AND e.category='practice' AND e.points=s.rewarded_points
        AND e.details->>'language'='javascript' AND e.details->>'validation'='syntax_only' AND e.details->>'source'='voluntary_practice'
        AND s.voluntary_xp=TRUE AND s.language='javascript' AND s.completed_at IS NOT NULL AND s.revisions>=2
        AND s.completed_at::timestamptz-s.created_at::timestamptz>=INTERVAL '90 seconds'
        AND s.last_result->>'status'='valid_syntax' AND s.last_result->>'eligiblePractice'='true'
        AND s.last_result->>'fingerprint'=s.successful_fingerprint`).get(userId),
    db.prepare(`SELECT COUNT(*)::integer AS files FROM xp_events WHERE user_id=?
      AND category='contribution' AND status='valid' AND details->>'evidence'='published_library_file'`).get(userId),
  ]);
  const help=helpRows[0]||{};
  const valid={events:numeric(ledger.events)},pages={pages:numeric(reading.pages),documents:numeric(reading.documents)},helped={rooms:numeric(help.rooms),requesters:numeric(help.requesters),days:numeric(help.days)},contributed={answers:numeric(contribution.answers),requesters:numeric(contribution.requesters)};
  const kept={notes:numeric(knowledge.notes),days:numeric(knowledge.days)},collected={items:numeric(knowledge.items),sources:numeric(knowledge.sources),collections:numeric(collections.collections)},practiced={programs:numeric(syntax.programs),days:numeric(syntax.days)};
  return {level:xpLevel(ledger.points),achievements:[
    achievement('first_steps','First Steps','Recevoir un premier événement XP validé par le serveur.',valid,[stage('bronze',{events:1})]),
    achievement('book_explorer','Book Explorer','Pages PDF distinctes avec une minute de lecture éligible : bronze 10 pages ; argent 50 pages sur 3 documents ; or 100 pages sur 5 documents. Ce suivi ne prouve pas la compréhension.',pages,[stage('bronze',{pages:10,documents:1}),stage('silver',{pages:50,documents:3}),stage('gold',{pages:100,documents:5})]),
    achievement('helping_hand','Helping Hand','Aides CloseRoom validées et évaluées positivement : bronze 1 session ; argent 5 ; or 15. Chaque session dure au moins 2 minutes et comporte un échange entre les deux participants.',helped,[stage('bronze',{rooms:1}),stage('silver',{rooms:5}),stage('gold',{rooms:15})]),
    achievement('campus_mentor','Campus Mentor','5 aides CloseRoom validées, pour au moins 3 personnes différentes et sur au moins 3 jours. Ce badge ne donne aucun droit administratif.',helped,[stage('bronze',{rooms:5,requesters:3,days:3})]),
    achievement('community_hero','Community Hero','Contributions Forum acceptées avec retours indépendants et XP validé : bronze 1 réponse ; argent 5 réponses pour 3 personnes ; or 15 réponses pour 5 personnes. Publier ou voter seul ne suffit pas.',contributed,[stage('bronze',{answers:1,requesters:1}),stage('silver',{answers:5,requesters:3}),stage('gold',{answers:15,requesters:5})]),
    achievement('library_contributor','Library Contributor','Fichiers distincts publiés dans votre filière et crédités par le serveur : bronze 5 fichiers ; argent 20 ; or 50. Un signalement confirmé par l’administration retire le crédit du fichier. Cette contribution ne prouve pas la qualité du contenu et le badge n’ajoute aucun XP.',{files:numeric(files.files)},[stage('bronze',{files:5}),stage('silver',{files:20}),stage('gold',{files:50})]),
    achievement('note_keeper','Note Keeper','Notes distinctes conservées sans modification depuis au moins 24 heures, avec au moins 120 caractères, 16 mots et 10 mots différents : bronze 3 notes sur 2 jours ; argent 10 sur 3 jours ; or 25 sur 5 jours. Le titre seul, les doublons, les répétitions et les seuls changements de nombres ne comptent pas ; cette structure ne prouve pas la justesse du contenu et ne donne pas d’XP.',kept,[stage('bronze',{notes:3,days:2}),stage('silver',{notes:10,days:3}),stage('gold',{notes:25,days:5})]),
    achievement('knowledge_collector','Knowledge Collector','Notes, extraits ou références substantiels et distincts, et collections, conservés sans modification depuis au moins 24 heures. Les éléments doivent être liés à des sources existantes et les collections avoir des ensembles de sources distincts contenant au moins 3 documents : bronze 5 éléments, 3 sources et 1 collection ; argent 15, 5 et 3 ; or 30, 10 et 5. Aucun XP n’est attribué pour remplir une collection.',collected,[stage('bronze',{items:5,sources:3,collections:1}),stage('silver',{items:15,sources:5,collections:3}),stage('gold',{items:30,sources:10,collections:5})]),
    achievement('syntax_master','Syntax Master','Programmes JavaScript distincts de Labs avec récompense validée, empreinte persistée, syntaxe finale correcte, au moins 2 révisions et 90 secondes : bronze 3 programmes sur 3 jours ; argent 10 sur 5 jours ; or 20 sur 10 jours. Cela valide la syntaxe, sans exécution ni garantie de justesse logique.',practiced,[stage('bronze',{programs:3,days:3}),stage('silver',{programs:10,days:5}),stage('gold',{programs:20,days:10})]),
  ]};
}
