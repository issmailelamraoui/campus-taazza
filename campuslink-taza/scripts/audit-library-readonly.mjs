// Explicitly read-only: no app initialization, migrations, seed, DDL, DML or R2 access.
// Usage: node scripts/audit-library-readonly.mjs --env .env.local --out /absolute/output/directory
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
  return pairs;
}, []));
if (!options.out) throw new Error('An explicit --out directory is required.');
if (options.env) loadEnvFile(resolve(options.env));
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const schemas = (options.schemas || 'campuslink,campuslink_prj').split(',');
if (schemas.some(s => !/^[a-z][a-z0-9_]{0,62}$/.test(s))) throw new Error('Invalid schema.');
const quoted = value => `"${value.replaceAll('"', '""')}"`;
const key = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
const scope = row => JSON.stringify([row.faculty_id, row.filiere_id, row.semester]);
const sameScope = (a, b) => scope(a) === scope(b);
const category = r => {
  const aliases = { cours:'courses', course:'courses', courses:'courses', td:'td', tp:'tp', tdtp:'tdtp', 'td / tp':'tdtp', 'td/tp':'tdtp', exercice:'exercises', exercices:'exercises', exercise:'exercises', exercises:'exercises', examen:'exams', examens:'exams', exam:'exams', exams:'exams', rattrapage:'rattrapage', correction:'corrections', corrections:'corrections', corrige:'corrections', corriges:'corrections', general:'general' };
  const type = key(r.resource_type), stored = key(r.category);
  return ['td','tp','correction','corrections'].includes(type) ? aliases[type] : aliases[stored] || stored || 'unclassified';
};
const countBy = (rows, getter) => rows.reduce((counts, row) => { const name = getter(row); counts[name] = (counts[name] || 0) + 1; return counts; }, {});
const sum = rows => rows.reduce((total, row) => total + Number(row.count || 0), 0);
const levenshtein = (a, b) => {
  let previous = Array.from({length:b.length+1}, (_, i) => i);
  for (let i=1;i<=a.length;i++) {const next=[i]; for(let j=1;j<=b.length;j++) next[j]=Math.min(next[j-1]+1,previous[j]+1,previous[j-1]+Number(a[i-1]!==b[j-1]));previous=next;}
  return previous[b.length];
};
const client = new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:15000,query_timeout:30000});
const report = {safety:{mode:'READ ONLY, REPEATABLE READ',database_writes:0,r2_operations:0,app_initialization:false,student_private_information_exported:false},schema_resolution:{configured_local_schema:process.env.CAMPUS_DB_SCHEMA||'campuslink (default)',serverless_entry:'api/backend.js explicitly supplies campuslink_prj for both reads and writes',query_adapter:'server/db.js qualifies application tables with db.schema; transaction search_path uses the same schema',verification_limit:'No write probe was executed; read/write routing is verified from source and existing reference integrity.'},schemas:[]};
try {
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='30s'");
  report.session=(await client.query("SELECT current_database() AS database,current_schema() AS connection_default_schema,current_setting('transaction_read_only') AS transaction_read_only,current_setting('transaction_isolation') AS isolation,now() AS snapshot_at")).rows[0];
  const columns=(await client.query('SELECT table_schema,table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=ANY($1) ORDER BY table_schema,table_name,ordinal_position',[schemas])).rows;
  const foreignKeys=(await client.query(`SELECT n.nspname AS schema,c.relname AS table_name,con.conname,nt.nspname AS target_schema,ct.relname AS target_table,
    ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.attnum ORDER BY k.ord) AS target_columns,
    pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class ct ON ct.oid=con.confrelid JOIN pg_namespace nt ON nt.oid=ct.relnamespace
    WHERE con.contype='f' AND (n.nspname=ANY($1) OR nt.nspname=ANY($1)) ORDER BY 1,2,3`,[schemas])).rows;
  for (const schema of schemas) {
    const table = name => `${quoted(schema)}.${quoted(name)}`;
    const has = (name, column) => columns.some(c=>c.table_schema===schema&&c.table_name===name&&(!column||c.column_name===column));
    if (!has('modules')) {report.schemas.push({schema,present:false});continue;}
    const read = async(name, names) => has(name) ? (await client.query(`SELECT ${names.filter(n=>has(name,n)).map(quoted).join(',')} FROM ${table(name)}`)).rows : [];
    const modules=await read('modules',['id','faculty_id','filiere_id','semester','name']);
    const resources=await read('resources',['id','faculty_id','filiere_id','semester','module_id','module','author_id','category','resource_type','removed','library_visible','relative_path','part_number','academic_year','academic_years','object_key','stored_name','sha256','message_id','version','size']);
    const folders=await read('resource_folders',['id','faculty_id','filiere_id','semester','module','category','resource_type','parent_id','title','created_by']);
    const folderItems=await read('folder_items',['folder_id','resource_id']);
    const shares=await read('message_module_shares',['message_id','resource_id','faculty_id','filiere_id','semester','module']);
    const messages=await read('messages',['id','faculty_id','filiere_id','semester','resource_id','reply_to','removed']);
    const attachments=await read('message_attachments',['message_id','resource_id']);
    const questions=await read('campus_questions',['id','faculty_id','filiere_id','resource_id','module','removed']);
    const notices=await read('notifications',['id','faculty_id','path','target_deleted','push_context']);
    const reports=await read('reports',['id','faculty_id','target_type','target_id','target_context']);
    const audit=await read('administrative_audit',['id','target_type','target_id','details']);
    const xp=await read('xp_events',['id','details']);
    const uploads=await read('upload_sessions',['id','faculty_id','fields','state']);
    const events=await read('realtime_events',['id','faculty_id','change']);
    const push=await read('push_outbox',['id','notification_id','payload']);
    const saved=await read('saved',['type','target_id']);
    const resourceRefs=foreignKeys.filter(f=>f.schema===schema&&f.target_schema===schema&&f.target_table==='resources');
    const dependencyCounts = new Map();
    for(const fk of resourceRefs) {
      const position=fk.target_columns.indexOf('id');if(position<0)continue;
      const name=fk.columns[position];
      const grouped=(await client.query(`SELECT ${quoted(name)} AS resource_id,count(*)::integer AS count FROM ${table(fk.table_name)} WHERE ${quoted(name)} IS NOT NULL GROUP BY ${quoted(name)}`)).rows;
      dependencyCounts.set(`${fk.table_name}.${name}`,grouped);
    }
    // Some composite/transitive references carry resource_id without a direct resources FK.
    for(const c of columns.filter(c=>c.table_schema===schema&&c.column_name==='resource_id'&&c.table_name!=='resources')) {
      const label=`${c.table_name}.resource_id`;if(dependencyCounts.has(label))continue;
      dependencyCounts.set(label,(await client.query(`SELECT resource_id,count(*)::integer AS count FROM ${table(c.table_name)} WHERE resource_id IS NOT NULL GROUP BY resource_id`)).rows);
    }
    const fingerprints=Object.fromEntries(['object_key','stored_name','sha256'].map(field=>[field,createHash('sha256').update(JSON.stringify(resources.map(r=>[r.id,r[field]]).sort((a,b)=>a[0]-b[0]))).digest('hex')]));
    const summaries=[];
    for (const module of modules.sort((a,b)=>a.id-b.id)) {
      const linked=resources.filter(r=>r.module_id===module.id);
      const legacy=resources.filter(r=>r.module_id==null&&sameScope(r,module)&&key(r.module)===key(module.name));
      const related=[...linked,...legacy], ids=related.map(r=>r.id), idSet=new Set(ids);
      const active=related.filter(r=>!r.removed), deleted=related.filter(r=>r.removed);
      const same=related.filter(r=>sameScope(r,module));
      const dependencies={};
      for (const [label,grouped] of dependencyCounts) dependencies[label]=sum(grouped.filter(r=>idSet.has(Number(r.resource_id))));
      let messageIds=new Set(messages.filter(m=>idSet.has(m.resource_id)||related.some(r=>r.message_id===m.id)).map(m=>m.id));
      for(const attachment of attachments)if(idSet.has(attachment.resource_id))messageIds.add(attachment.message_id);
      const matchingShares=shares.filter(s=>idSet.has(s.resource_id)||(sameScope(s,module)&&key(s.module)===key(module.name)));
      for(const share of matchingShares)messageIds.add(Number(share.message_id));
      let changed=true;while(changed){changed=false;for(const m of messages)if(messageIds.has(m.reply_to)&&!messageIds.has(m.id)){messageIds.add(m.id);changed=true;}}
      const matchContext=value=>{
        // Resumable uploads persist FormData as key/value pairs, not an object.
        const c=Array.isArray(value)&&value.every(entry=>Array.isArray(entry)&&entry.length===2)?Object.fromEntries(value):value;
        return !!c&&typeof c==='object'&&((idSet.has(Number(c.resource_id))||idSet.has(Number(c.main_resource_id))||idSet.has(Number(c.supplement_resource_id)))||(Number(c.module_id)===module.id&&(c.faculty_id==null||c.faculty_id===module.faculty_id))||((c.module||c.module_name)&&key(c.module||c.module_name)===key(module.name)&&(c.faculty_id==null||c.faculty_id===module.faculty_id)&&(c.filiere_id==null||c.filiere_id===module.filiere_id)));
      };
      const matchingNotices=notices.filter(n=>n.faculty_id===module.faculty_id&&(matchContext(n.push_context)||ids.some(id=>new RegExp(`(?:#resource-|/resources/|[?&](?:resource_id|document)=)${id}(?:$|[^0-9])`).test(n.path||''))||messageIds.size&&[...messageIds].some(id=>new RegExp(`(?:#message-|[?&]message=)${id}(?:$|[^0-9])`).test(n.path||''))));
      const noticeSet=new Set(matchingNotices.map(n=>n.id));
      const matchingReports=reports.filter(r=>(r.target_type==='resource'&&idSet.has(r.target_id))||matchContext(r.target_context));
      const directFolders=folders.filter(f=>sameScope(f,module)&&key(f.module)===key(module.name));
      const folderSet=new Set(directFolders.map(f=>f.id));
      for(const item of folderItems)if(idSet.has(item.resource_id))folderSet.add(item.folder_id);
      const realFolders=folders.filter(f=>folderSet.has(f.id));
      const paths=[...new Set(related.filter(r=>r.relative_path?.includes('/')).map(r=>r.relative_path.split('/').slice(0,-1).join('/')))].sort();
      const possibleTest=['aa','support','test','ws','ww','fav'].includes(key(module.name));
      const invalidScope=!module.faculty_id||!module.filiere_id||!Number.isInteger(module.semester)||module.semester<1||module.semester>6||linked.some(r=>!sameScope(r,module));
      summaries.push({...module,classification:possibleTest?'possible_test_requires_review':invalidScope?'ambiguous_preserve':active.length?'real_content_preserve':'ambiguous_empty_preserve',official_curriculum_verified:false,
        counts:{active_resources:active.length,active_library_resources:active.filter(r=>r.library_visible!==0).length,active_nonlibrary_resources:active.filter(r=>r.library_visible===0).length,soft_deleted_resources:deleted.length,contributors_all:new Set(related.map(r=>r.author_id)).size,contributors_active:new Set(active.map(r=>r.author_id)).size,canonical_linked_resources:linked.length,legacy_unlinked_name_matches:legacy.length,cross_scope_links:linked.filter(r=>!sameScope(r,module)).length},
        categories:Object.fromEntries([...new Set(related.map(category))].sort().map(c=>[c,{active:active.filter(r=>category(r)===c).length,active_library:active.filter(r=>category(r)===c&&r.library_visible!==0).length,soft_deleted:deleted.filter(r=>category(r)===c).length,contributors_active:new Set(active.filter(r=>category(r)===c).map(r=>r.author_id)).size}])),
        resource_ids:ids.sort((a,b)=>a-b),legacy_resource_ids:legacy.map(r=>r.id),folder_paths:paths,physical_folder_records:realFolders.map(({id,parent_id,title,category,resource_type})=>({id,parent_id,title,category,resource_type})),
        dependents:{foreign_key_record_counts:dependencies,saved_resource_count:saved.filter(s=>s.type==='resource'&&idSet.has(s.target_id)).length,saved_related_message_count:saved.filter(s=>s.type==='message'&&messageIds.has(s.target_id)).length,discussion_message_count:messageIds.size,module_share_count:matchingShares.length,campus_question_count:questions.filter(q=>idSet.has(q.resource_id)||(q.faculty_id===module.faculty_id&&q.filiere_id===module.filiere_id&&key(q.module)===key(module.name))).length,notification_count:matchingNotices.length,notification_paths:[...new Set(matchingNotices.map(n=>n.path))],push_outbox_count:push.filter(p=>noticeSet.has(p.notification_id)||matchContext(p.payload)).length,report_count:matchingReports.length,administrative_audit_count:audit.filter(a=>(a.target_type==='resource'&&idSet.has(Number(a.target_id)))||matchContext(a.details)).length,xp_event_count:xp.filter(x=>matchContext(x.details)).length,upload_session_count:uploads.filter(u=>u.faculty_id===module.faculty_id&&matchContext(u.fields)).length,realtime_event_count:events.filter(e=>e.faculty_id===module.faculty_id&&matchContext(e.change)).length},
        warnings:[...(!module.filiere_id?['Missing programme; do not reassign without validation.']:[]),...(linked.some(r=>!sameScope(r,module))?['Resource FK crosses faculty/programme/semester scope; preserve and investigate.']:[]),...(!active.length?['Zero active resources is not evidence that a module is safe to delete.']:[]),...(possibleTest?['Name resembles a historical test; content/owner confirmation is required.']:[])]});
    }
    const duplicateCandidates=[];
    for(let i=0;i<modules.length;i++)for(let j=i+1;j<modules.length;j++){
      const a=modules[i],b=modules[j];if(!sameScope(a,b))continue;
      const ak=key(a.name),bk=key(b.name);if(JSON.stringify(ak.match(/\d+/g)||[])!==JSON.stringify(bk.match(/\d+/g)||[]))continue;
      const distance=levenshtein(ak,bk),score=1-distance/Math.max(ak.length,bk.length,1);
      if(ak===bk||Math.min(ak.length,bk.length)>7&&score>=.78)duplicateCandidates.push({ids:[a.id,b.id],names:[a.name,b.name],faculty_id:a.faculty_id,filiere_id:a.filiere_id,semester:a.semester,normalization_equal:ak===bk,edit_distance:distance,similarity:Number(score.toFixed(3)),status:'candidate_only_requires_official_curriculum_and_admin_validation',resource_ids:[...new Set(summaries.filter(m=>[a.id,b.id].includes(m.id)).flatMap(m=>m.resource_ids))]});
    }
    const linkedIds=new Set(modules.map(m=>m.id));
    const orphaned=resources.filter(r=>r.module_id!=null&&!linkedIds.has(r.module_id));
    const unlinked=resources.filter(r=>r.module_id==null);
    const tableCounts=[];for(const name of [...new Set(columns.filter(c=>c.table_schema===schema).map(c=>c.table_name))])tableCounts.push({table:name,count:(await client.query(`SELECT count(*)::integer AS count FROM ${table(name)}`)).rows[0].count});
    const applicationModuleColumns=columns.filter(c=>c.table_schema===schema&&/module|path|context|details|fields|change/.test(c.column_name)).map(({table_name,column_name,data_type})=>({table:table_name,column:column_name,type:data_type}));
    report.schemas.push({schema,present:true,totals:{modules:modules.length,resources:resources.length,active_resources:resources.filter(r=>!r.removed).length,soft_deleted_resources:resources.filter(r=>r.removed).length,resource_folders:folders.length,module_fk_orphans:orphaned.length,resources_without_module_id:unlinked.length},table_counts:tableCounts,category_metadata_combinations:resources.reduce((list,r)=>{const match=list.find(x=>x.category===r.category&&x.resource_type===r.resource_type);if(match)match.count++;else list.push({category:r.category,resource_type:r.resource_type,effective_category:category(r),count:1});return list;},[]),preservation_fingerprints:fingerprints,module_fk_orphan_ids:orphaned.map(r=>r.id),unlinked_resources:unlinked.map(({id,faculty_id,filiere_id,semester,module,removed,category:storedCategory,resource_type})=>({id,faculty_id,filiere_id,semester,module,removed,category:storedCategory,resource_type})),modules:summaries,duplicate_candidates:duplicateCandidates,confirmed_duplicates:[],foreign_keys:foreignKeys.filter(f=>f.schema===schema||f.target_schema===schema),application_module_columns:applicationModuleColumns});
  }
  await client.query('ROLLBACK');
} catch(error) {
  try {await client.query('ROLLBACK');}catch{}
  console.error(JSON.stringify({error:error.code||error.name,message:String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[connection redacted]')}));process.exitCode=1;
} finally {await client.end();}
if(process.exitCode)process.exit();
const out=resolve(options.out);await mkdir(out,{recursive:true});
await writeFile(resolve(out,'neon-library-audit.json'),JSON.stringify(report,null,2));
const csvField=value=>`"${String(value??'').replaceAll('"','""')}"`;
const rows=[['schema','module_id','faculty','filiere','semester','module_name','classification','active','active_library','soft_deleted','contributors_active','category_counts','folder_paths','discussion_messages','notifications','resource_ids']];
for(const s of report.schemas)for(const m of s.modules||[])rows.push([s.schema,m.id,m.faculty_id,m.filiere_id,m.semester,m.name,m.classification,m.counts.active_resources,m.counts.active_library_resources,m.counts.soft_deleted_resources,m.counts.contributors_active,JSON.stringify(m.categories),m.folder_paths.join(' | '),m.dependents.discussion_message_count,m.dependents.notification_count,m.resource_ids.join(',')]);
await writeFile(resolve(out,'neon-library-modules.csv'),'\uFEFF'+rows.map(r=>r.map(csvField).join(',')).join('\r\n'));
console.log(JSON.stringify({snapshot_at:report.session.snapshot_at,read_only:report.session.transaction_read_only,out,schemas:report.schemas.map(s=>({schema:s.schema,totals:s.totals,classification:countBy(s.modules||[],m=>m.classification),duplicates:s.duplicate_candidates}))},null,2));
