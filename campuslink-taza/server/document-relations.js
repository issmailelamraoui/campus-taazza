import { normalizeDocumentText, verifiedIndexedPageCount } from './document-search.js';

const failure = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const integer = value => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw failure(400, 'Référence de page ou de document invalide.'); return number; };
const reasonText = value => { if (typeof value !== 'string' || value.trim().length < 8 || value.length > 2000) throw failure(400, 'Expliquez la relation en 8 à 2 000 caractères.'); return value.trim(); };
export const DOCUMENT_RELATION_POLICY = Object.freeze({ exercisePages: 50, coursePages: 200, pageCharacters: 12000, pageTokens: 1000, queryTerms: 32, suggestions: 12, mappings: 100, proposalsPerDay: 30, minimumSharedTerms: 3, minimumRareTerms: 2 });
const stopWords = new Set(normalizeDocumentText(`
  avec alors ainsi apres avant aussi autre autres aucun cette celui celles ceux comme comment dans depuis donc deux doivent elle elles entre etre faire fait fois leur leurs mais meme moins notre nous pour quand quelle quelles quels sans sera sont sous tout toute toutes tous tres une votre vous
  about after again also because been before being between both chapter chapters could does each from have into more most other over same should some such than that their them then there these they this those through under using very what when where which while will with would your
  cours course courses chapitre chapitres document documents demonstration pedagogique campuslink taza exercice exercices exercise exercises question questions reponse answer answers partie parties part parts fonction function fonctions functions valeur values value exemple example exemples examples calcul calculate equation equations probleme problem result resultat solution solutions donnees data methode method introduction conclusion support texte text verifiez enseignant consignes illustre plateforme
  هذا هذه ذلك تلك الذي التي الذين على إلى الى عن في من مع بين بعد قبل عند حتى كما لكن لأن لان كان كانت يكون تكون ليست ليس نحن انت أن ان اذا إذا كل نفس حول شرح تمرين تمارين السؤال اسئلة سؤال الجواب اجابة إجابة مثال امثلة أمثلة فصل فصول جزء اجزاء أجزاء درس دروس دالة الدالة قيمة القيم البيانات معادلة معادلات حل الحل طريقة
`).split(/\s+/u).filter(Boolean));
const normalizedModule = value => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
const kindOf = resource => ['td', 'tp', 'correction', 'corrections'].includes(resource.resource_type) ? resource.resource_type : resource.category;
const isCourse = resource => ['courses', 'cours'].includes(kindOf(resource));
const isExercise = resource => ['td', 'exercises', 'exercise'].includes(kindOf(resource));
function assertEducational(resource, exercise = true) {
  if (resource.mime !== 'application/pdf' || resource.library_visible === 0 || !resource.filiere_id || !normalizedModule(resource.module) || !(exercise ? isExercise(resource) : isCourse(resource))) throw failure(400, exercise ? 'Choisissez un PDF de TD ou d’exercices partagé dans la bibliothèque.' : 'Choisissez un PDF de cours partagé dans la bibliothèque.');
}
function sameStudyScope(a, b) { return a.faculty_id === b.faculty_id && a.filiere_id === b.filiere_id && a.semester === b.semester && normalizedModule(a.module) === normalizedModule(b.module); }
function currentMapping(row, exercise, course) { return row.exercise_version === exercise.version && row.exercise_sha256 === exercise.sha256 && row.course_version === course.version && row.course_sha256 === course.sha256 && sameStudyScope(exercise, course); }
const source = (resource, page) => ({ resourceId: resource.id, version: resource.version, page, title: resource.title, filename: resource.filename, part: resource.part_number || null, academicYear: resource.academic_year || null, href: `/app/library?${new URLSearchParams({ document: String(resource.id), page: String(page), version: String(resource.version) })}#resource-${resource.id}` });
function mappingDTO(row, exercise, course) { return { id: row.id, status: row.status, revision: row.revision, reason: row.reason, proposerId: row.proposer_id, reviewerId: row.reviewed_by || null, reviewedAt: row.reviewed_at || null, createdAt: row.created_at, exercise: source(exercise, row.exercise_page), course: source(course, row.course_page) }; }

export function lexicalPage(text) {
  const original = String(text || ''), normalized = normalizeDocumentText(original.slice(0, DOCUMENT_RELATION_POLICY.pageCharacters));
  const raw = (normalized.match(/[\p{L}\p{N}]+/gu) || []).slice(0, DOCUMENT_RELATION_POLICY.pageTokens), counts = new Map();
  for (const word of raw) if (word.length >= 4 && /\p{L}/u.test(word) && !stopWords.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
  const phrases = new Set();
  for (let i = 0; i + 2 < raw.length; i++) if (raw.slice(i, i + 3).every(word => counts.has(word))) phrases.add(raw.slice(i, i + 3).join(' '));
  return { counts, phrases, limited: original.length > DOCUMENT_RELATION_POLICY.pageCharacters || (normalized.match(/[\p{L}\p{N}]+/gu) || []).length > DOCUMENT_RELATION_POLICY.pageTokens };
}
// Local-corpus inverse document frequency is an ordering signal, never a
// correctness probability. Three meaningful terms and two locally rare terms
// are mandatory; numbering, titles and generic "fonction" cannot satisfy it.
export function relatedPageEvidence(exercise, course, corpusFrequency, corpusSize) {
  const shared = [...exercise.counts.keys()].filter(word => course.counts.has(word));
  const rareLimit = Math.max(2, Math.ceil(corpusSize / 2));
  const rare = shared.filter(word => (corpusFrequency.get(word) || 1) <= rareLimit);
  if (shared.length < DOCUMENT_RELATION_POLICY.minimumSharedTerms || rare.length < DOCUMENT_RELATION_POLICY.minimumRareTerms) return null;
  const weighted = shared.map(term => ({ term, weight: 1 + Math.log(1 + corpusSize / (corpusFrequency.get(term) || 1)), rare: rare.includes(term) })).sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
  const phrases = [...exercise.phrases].filter(phrase => course.phrases.has(phrase)).slice(0, 3);
  const score = weighted.reduce((total, item) => total + item.weight * Math.min(2, 1 + Math.log(Math.min(exercise.counts.get(item.term), course.counts.get(item.term)))), 0) + phrases.length * 2;
  return { lexicalScore: Math.round(score * 1000) / 1000, terms: weighted.slice(0, 8).map(({ term, rare: isRare }) => ({ term, locallyRare: isRare })), phrases, sharedTerms: shared.length, limited: exercise.limited || course.limited };
}

export function installDocumentRelationsRoutes(app, { db, requireFaculty, assertResource, canVerify }) {
  async function pair(req, exerciseId, courseId) {
    const exercise = await assertResource(exerciseId, req), course = await assertResource(courseId, req); assertEducational(exercise); assertEducational(course, false);
    if (exercise.id === course.id || !sameStudyScope(exercise, course)) throw failure(403, 'Les deux documents doivent appartenir au même module, semestre et filière.');
    return { exercise, course };
  }
  async function assertPages(exercise, exercisePage, course, coursePage) {
    const exerciseCount = await verifiedIndexedPageCount(db, exercise), courseCount = await verifiedIndexedPageCount(db, course);
    if (!exerciseCount || !courseCount) throw failure(409, 'Indexez explicitement les deux PDF pour vérifier leurs pages.', 'DOCUMENT_INDEX_REQUIRED');
    if (exercisePage > exerciseCount || coursePage > courseCount) throw failure(400, 'Cette page n’existe pas dans le PDF vérifié.');
  }
  async function permittedMappings(req, exercise, snapshots) {
    const rows = await db.prepare('SELECT * FROM document_relations WHERE exercise_resource_id=? AND exercise_version=? AND exercise_sha256=? ORDER BY created_at DESC,id DESC LIMIT ?').all(exercise.id, exercise.version, exercise.sha256, DOCUMENT_RELATION_POLICY.mappings), mappings = [];
    for (const row of rows) {
      try { const course = await assertResource(row.course_resource_id, req); if (isCourse(course) && course.library_visible !== 0 && currentMapping(row, exercise, course)) { snapshots.set(course.id, course); mappings.push(mappingDTO(row, exercise, course)); } }
      catch (error) { if (![403, 404].includes(error.status)) throw error; }
    }
    return mappings;
  }
  app.get('/api/document-relations/:id', requireFaculty, async (req, res) => {
    const exercise = await assertResource(integer(req.params.id), req); assertEducational(exercise);
    const selectedPage = req.query.exercise_page === undefined ? null : integer(req.query.exercise_page), pageCount = await verifiedIndexedPageCount(db, exercise);
    if (selectedPage && pageCount && selectedPage > pageCount) throw failure(400, 'Cette page n’existe pas dans le PDF vérifié.');
    const snapshots = new Map(), mappings = await permittedMappings(req, exercise, snapshots), suggestions = [];
    async function respond(state, message, limited = false) {
      const fresh = await assertResource(exercise.id, req);
      if (fresh.version !== exercise.version || fresh.sha256 !== exercise.sha256 || !sameStudyScope(exercise, fresh) || !isExercise(fresh) || fresh.mime !== 'application/pdf' || fresh.library_visible === 0) throw failure(409, 'Le document a changé. Rouvrez sa version actuelle.');
      const validCourses = new Set();
      for (const [courseId, snapshot] of snapshots) {
        try { const course = await assertResource(courseId, req); if (course.version === snapshot.version && course.sha256 === snapshot.sha256 && sameStudyScope(fresh, course) && isCourse(course) && course.mime === 'application/pdf' && course.library_visible !== 0) validCourses.add(courseId); }
        catch (error) { if (![403, 404].includes(error.status)) throw error; }
      }
      for (let i = mappings.length - 1; i >= 0; i--) if (!validCourses.has(mappings[i].course.resourceId)) mappings.splice(i, 1);
      for (let i = suggestions.length - 1; i >= 0; i--) if (!validCourses.has(suggestions[i].course.resourceId)) suggestions.splice(i, 1);
      if (state === 'suggestions' && !suggestions.length) state = 'unknown';
      const mayVerify = await canVerify(req, fresh);
      return res.set('Cache-Control', 'private, no-store').json({ resourceId: exercise.id, version: exercise.version, state, suggestions, mappings, limited, policy: DOCUMENT_RELATION_POLICY, message, automaticVerification: false, canVerify: mayVerify === true });
    }
    if (!pageCount) return respond('not_indexed', 'Indexez explicitement ce PDF et les cours disponibles. Les propositions manuelles restent possibles après vérification des pages.');
    const targetRows = await db.prepare(`SELECT page,text FROM document_text_pages WHERE resource_id=? AND document_version=? ${selectedPage ? 'AND page=?' : ''} ORDER BY page LIMIT ?`).all(exercise.id, exercise.version, ...(selectedPage ? [selectedPage] : []), DOCUMENT_RELATION_POLICY.exercisePages);
    if (!targetRows.length) return respond('unknown', 'Aucun texte extractible sur les pages choisies. Utilisez une proposition manuelle; aucun OCR n’est effectué.');
    const targets = targetRows.map(row => ({ ...row, lexical: lexicalPage(row.text) })), aggregate = new Map();
    for (const page of targets) for (const [term, count] of page.lexical.counts) aggregate.set(term, (aggregate.get(term) || 0) + count);
    const queryTerms = [...aggregate].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, DOCUMENT_RELATION_POLICY.queryTerms).map(([term]) => term);
    if (queryTerms.length < 3) return respond('unknown', 'Pas assez de termes significatifs communs pour proposer une relation.');
    const rows = await db.prepare(`SELECT p.resource_id,p.document_version,p.page,p.text,i.source_sha256 FROM document_text_pages p
      JOIN document_text_indexes i ON i.resource_id=p.resource_id AND i.document_version=p.document_version JOIN resources r ON r.id=p.resource_id
      WHERE r.removed=0 AND r.library_visible=1 AND r.mime='application/pdf' AND r.faculty_id=? AND r.filiere_id=? AND r.semester=?
        AND lower(normalize(regexp_replace(trim(r.module),'\\s+',' ','g'),NFKC))=? AND r.category IN ('courses','cours')
        AND r.resource_type NOT IN ('td','tp','correction','corrections') AND r.version=p.document_version AND r.sha256=i.source_sha256
        AND p.search_vector @@ to_tsquery('simple',?) ORDER BY r.academic_year DESC NULLS LAST,r.id DESC,p.page LIMIT ?`)
      .all(exercise.faculty_id, exercise.filiere_id, exercise.semester, normalizedModule(exercise.module), queryTerms.join(' | '), DOCUMENT_RELATION_POLICY.coursePages);
    const courseResources = new Map(), coursePages = [];
    for (const row of rows) {
      if (!courseResources.has(row.resource_id)) {
        try { courseResources.set(row.resource_id, await assertResource(row.resource_id, req)); }
        catch (error) { if (![403, 404].includes(error.status)) throw error; courseResources.set(row.resource_id, null); }
      }
      const course = courseResources.get(row.resource_id);
      if (!course || !isCourse(course) || !sameStudyScope(exercise, course) || course.version !== row.document_version || course.sha256 !== row.source_sha256 || course.library_visible === 0) continue;
      snapshots.set(course.id, course);
      coursePages.push({ ...row, resource: course, lexical: lexicalPage(row.text) });
    }
    const frequency = new Map(); for (const page of coursePages) for (const word of page.lexical.counts.keys()) frequency.set(word, (frequency.get(word) || 0) + 1);
    for (const target of targets) for (const course of coursePages) {
      const evidence = relatedPageEvidence(target.lexical, course.lexical, frequency, coursePages.length);
      if (evidence) suggestions.push({ status: 'suggested', exercise: source(exercise, target.page), course: source(course.resource, course.page), evidence, explanation: 'Rapprochement lexical à vérifier. Ce score ne prouve pas que ce cours résout cet exercice.' });
    }
    suggestions.sort((a, b) => b.evidence.lexicalScore - a.evidence.lexicalScore || a.exercise.page - b.exercise.page || a.course.resourceId - b.course.resourceId || a.course.page - b.course.page); suggestions.splice(DOCUMENT_RELATION_POLICY.suggestions);
    return respond(suggestions.length ? 'suggestions' : 'unknown', 'Suggestions de pages fondées sur du texte réellement indexé. Aucun découpage automatique des exercices ni correspondance entre numéros de parties.', rows.length >= DOCUMENT_RELATION_POLICY.coursePages || !selectedPage && pageCount > targets.length || targets.some(page => page.lexical.limited) || coursePages.some(page => page.lexical.limited));
  });
  app.post('/api/document-relations/:id', requireFaculty, async (req, res) => {
    const exerciseId = integer(req.params.id), courseId = integer(req.body.course_resource_id), exercisePage = integer(req.body.exercise_page), coursePage = integer(req.body.course_page), reason = reasonText(req.body.reason);
    await pair(req, exerciseId, courseId);
    const result = await db.transaction(async () => {
      await db.prepare('SELECT id FROM resources WHERE id=ANY(?) ORDER BY id FOR SHARE').all([exerciseId, courseId]);
      const { exercise, course } = await pair(req, exerciseId, courseId); await assertPages(exercise, exercisePage, course, coursePage);
      if (req.body.exercise_version !== undefined && integer(req.body.exercise_version) !== exercise.version || req.body.course_version !== undefined && integer(req.body.course_version) !== course.version) throw failure(409, 'Une version du document a changé. Rouvrez les versions actuelles avant de proposer un lien.');
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`document-relation-proposal:${req.user.id}`);
      const duplicate = await db.prepare('SELECT * FROM document_relations WHERE exercise_resource_id=? AND exercise_version=? AND exercise_page=? AND course_resource_id=? AND course_version=? AND course_page=?').get(exerciseId, exercise.version, exercisePage, courseId, course.version, coursePage);
      if (duplicate) return { mapping: mappingDTO(duplicate, exercise, course), reused: true };
      const today = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
      const count = await db.prepare('SELECT COUNT(*)::integer AS count FROM document_relations WHERE proposer_id=? AND created_at>=?').get(req.user.id, today);
      if (count.count >= DOCUMENT_RELATION_POLICY.proposalsPerDay) throw failure(429, 'La limite quotidienne de propositions a été atteinte.');
      const at = new Date().toISOString();
      const row = await db.prepare(`INSERT INTO document_relations(exercise_resource_id,exercise_version,exercise_sha256,exercise_page,course_resource_id,course_version,course_sha256,course_page,reason,proposer_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING *`).get(exerciseId, exercise.version, exercise.sha256, exercisePage, courseId, course.version, course.sha256, coursePage, reason, req.user.id, at, at);
      if (!row) throw failure(409, 'Cette relation vient d’être proposée. Rechargez la liste.');
      return { mapping: mappingDTO(row, exercise, course), reused: false };
    });
    res.set('Cache-Control', 'private, no-store').status(result.reused ? 200 : 201).json(result);
  });
  app.patch('/api/document-relations/:id/:mappingId', requireFaculty, async (req, res) => {
    const exerciseId = integer(req.params.id), mappingId = integer(req.params.mappingId), revision = integer(req.body.revision);
    if (req.body.status !== undefined && !['verified', 'rejected'].includes(req.body.status)) throw failure(400, 'État de vérification invalide.');
    if (req.body.status === undefined && req.body.reason === undefined) throw failure(400, 'Aucune modification fournie.');
    const suppliedReason = req.body.reason === undefined ? null : reasonText(req.body.reason);
    const result = await db.transaction(async () => {
      const row = await db.prepare('SELECT * FROM document_relations WHERE id=? AND exercise_resource_id=? FOR UPDATE').get(mappingId, exerciseId); if (!row) throw failure(404, 'Relation introuvable.');
      await db.prepare('SELECT id FROM resources WHERE id=ANY(?) ORDER BY id FOR SHARE').all([exerciseId, row.course_resource_id]);
      const { exercise, course } = await pair(req, exerciseId, row.course_resource_id);
      if (!currentMapping(row, exercise, course)) throw failure(409, 'Une version du document a changé. Proposez une relation pour les versions actuelles.');
      await assertPages(exercise, row.exercise_page, course, row.course_page);
      const manager = await canVerify(req, exercise);
      if (req.body.status !== undefined && !manager || req.body.status === undefined && !manager && (row.proposer_id !== req.user.id || row.status !== 'proposed')) throw failure(403, 'La vérification est réservée aux responsables autorisés du module.');
      if (row.revision !== revision) throw failure(409, 'Cette proposition a été modifiée dans une autre session.');
      const at = new Date().toISOString(), status = req.body.status || row.status, reason = suppliedReason || row.reason;
      const updated = await db.prepare('UPDATE document_relations SET status=?,reason=?,reviewed_by=?,reviewed_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? RETURNING *').get(status, reason, req.body.status ? req.user.id : row.reviewed_by, req.body.status ? at : row.reviewed_at, at, mappingId, revision);
      if (!updated) throw failure(409, 'Cette proposition a été modifiée dans une autre session.');
      if (req.body.status) await db.prepare('INSERT INTO administrative_audit(actor_id,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?)').run(req.user.id, 'document_relation.' + status, 'document_relation', String(mappingId), JSON.stringify({ exercise_resource_id: exerciseId, exercise_version: exercise.version, exercise_page: row.exercise_page, course_resource_id: course.id, course_version: course.version, course_page: row.course_page }), at);
      return { mapping: mappingDTO(updated, exercise, course) };
    });
    res.set('Cache-Control', 'private, no-store').json(result);
  });
}
