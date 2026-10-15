import { parse } from 'acorn';
import { createHash, randomUUID } from 'node:crypto';
import { ADDITIONAL_LABS_LANGUAGES, validateAdditionalLabSource } from './labs-language-validator.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (status, message) => Object.assign(new Error(message), { status });
export const LABS_LANGUAGES = ['javascript', 'json', ...ADDITIONAL_LABS_LANGUAGES];
export const LABS_POLICY = { initialPotential: 10, syntaxPenalty: 2, dailyCap: 10, minimumSeconds: 90, minimumRevisions: 2, maximumSourceBytes: 16000, minimumCheckSeconds: 2 };

function canonical(node) {
  if (Array.isArray(node)) return node.map(canonical);
  if (!node || typeof node !== 'object') return node;
  const result = {};
  for (const key of Object.keys(node).sort()) {
    if (['start', 'end', 'loc', 'raw'].includes(key)) continue;
    if (key === 'name' && node.type === 'Identifier') result[key] = '_';
    else if (key === 'value' && node.type === 'Literal') result[key] = typeof node.value;
    else result[key] = canonical(node[key]);
  }
  return result;
}
function nodesOf(tree) {
  let nodes = 0, useful = 0;
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type) {
      nodes++;
      if (['IfStatement', 'ForStatement', 'ForOfStatement', 'WhileStatement', 'CallExpression', 'BinaryExpression', 'ReturnStatement', 'ConditionalExpression'].includes(node.type)) useful++;
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') pending.push(...(Array.isArray(value) ? value : [value]));
  }
  return { nodes, useful };
}
export function validateLabSource(language, source) {
  if (!LABS_LANGUAGES.includes(language)) throw failure(503, 'Ce langage nécessite un service de validation isolé qui n’est pas configuré.');
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source, 'utf8') > LABS_POLICY.maximumSourceBytes || source.includes('\0')) throw failure(400, 'Code invalide ou trop long (16 Ko maximum).');
  if (ADDITIONAL_LABS_LANGUAGES.includes(language)) return validateAdditionalLabSource(language, source);
  try {
    if (language === 'json') { JSON.parse(source); return { status: 'valid_syntax', diagnostics: [], eligiblePractice: false, fingerprint: hash(source.trim()) }; }
    const ast = parse(source, { ecmaVersion: 2025, sourceType: 'module', locations: true });
    const shape = nodesOf(ast);
    return { status: 'valid_syntax', diagnostics: [], eligiblePractice: shape.nodes >= 20 && shape.useful >= 3, fingerprint: hash(JSON.stringify(canonical(ast))) };
  } catch (error) {
    // Resource/parser infrastructure failures never reduce practice potential.
    if (!(error instanceof SyntaxError)) return { status: 'validation_unavailable', diagnostics: [{ message: 'Le service de validation est temporairement indisponible.' }], eligiblePractice: false };
    const diagnostic = { message: error.message.slice(0, 300), line: error.loc?.line || null, column: error.loc ? error.loc.column + 1 : null };
    if (language === 'json') {
      const position = Number(/position (\d+)/.exec(error.message)?.[1]);
      if (Number.isFinite(position)) { const preceding = source.slice(0, position).split('\n'); diagnostic.line = preceding.length; diagnostic.column = preceding.at(-1).length + 1; }
    }
    return { status: 'syntax_error', diagnostics: [diagnostic], eligiblePractice: false, errorFingerprint: hash(`${diagnostic.message.replace(/\(\d+:\d+\)/g, '')}:${diagnostic.line}`) };
  }
}
export function practiceEligibility(session, timestamp = Date.now()) {
  const elapsed = (timestamp - new Date(session.created_at).getTime()) / 1000;
  if (!session.voluntary_xp || session.language !== 'javascript') return 'practice_not_enabled';
  if (!session.potential) return 'potential_exhausted';
  if (!session.last_result?.eligiblePractice || session.last_result?.status !== 'valid_syntax') return 'valid_substantial_program_required';
  if (session.revisions < LABS_POLICY.minimumRevisions || elapsed < LABS_POLICY.minimumSeconds) return 'more_practice_required';
  return null;
}
const dto = row => ({ id: row.id, language: row.language, voluntaryXp: row.voluntary_xp, potential: row.potential, source: row.source,
  result: row.last_result, revisions: row.revisions, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at, rewardedPoints: row.rewarded_points });
export function installLabsRoutes(app, { db, requireFaculty, broadcast = async () => {} }) {
  const now = () => new Date().toISOString();
  async function owned(req, lock = false) {
    if (typeof req.params.id !== 'string' || !/^[a-f0-9-]{36}$/.test(req.params.id)) throw failure(400, 'Session invalide.');
    const row = await db.prepare(`SELECT * FROM labs_sessions WHERE id=? AND user_id=?${lock ? ' FOR UPDATE' : ''}`).get(req.params.id, req.user.id);
    if (!row) throw failure(404, 'Session introuvable.'); return row;
  }
  app.get('/api/labs', requireFaculty, async (req, res) => {
    const sessions = await db.prepare('SELECT * FROM labs_sessions WHERE user_id=? ORDER BY updated_at DESC LIMIT 20').all(req.user.id);
    res.json({ languages: LABS_LANGUAGES, executionAvailable: false, policy: LABS_POLICY, sessions: sessions.map(dto) });
  });
  app.get('/api/labs/:id', requireFaculty, async (req, res) => res.json({ session: dto(await owned(req)) }));
  app.post('/api/labs', requireFaculty, async (req, res) => {
    if (!LABS_LANGUAGES.includes(req.body.language) || typeof req.body.voluntaryXp !== 'boolean') throw failure(400, 'Choisissez un langage et la participation volontaire aux XP.');
    const row = await db.transaction(async () => {
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`labs:${req.user.id}`);
      const recent = await db.prepare('SELECT COUNT(*)::integer AS count FROM labs_sessions WHERE user_id=? AND created_at>?').get(req.user.id, new Date(Date.now() - 86400000).toISOString());
      if (recent.count >= 20) throw failure(429, 'Limite quotidienne de sessions atteinte.');
      const voluntary = req.body.voluntaryXp && req.body.language === 'javascript';
      return db.prepare('INSERT INTO labs_sessions(id,user_id,language,voluntary_xp,potential,created_at,updated_at) VALUES(?,?,?,?,?,?,?) RETURNING *').get(randomUUID(), req.user.id, req.body.language, voluntary, voluntary ? LABS_POLICY.initialPotential : 0, now(), now());
    }); res.status(201).json({ session: dto(row) });
  });
  app.post('/api/labs/:id/check', requireFaculty, async (req, res) => {
    const current = await owned(req);
    // Reject closed/rate-limited sessions before allocating a parser worker;
    // the locked checks below still prevent simultaneous requests racing.
    if (current.completed_at) throw failure(409, 'Cette session est terminée.');
    if (current.last_checked_at && Date.now() - new Date(current.last_checked_at).getTime() < LABS_POLICY.minimumCheckSeconds * 1000) throw failure(429, 'Attendez deux secondes entre les vérifications.');
    const result = await validateLabSource(current.language, req.body.source);
    const row = await db.transaction(async () => {
      const session = await owned(req, true);
      if (session.completed_at) throw failure(409, 'Cette session est terminée.');
      if (session.last_checked_at && Date.now() - new Date(session.last_checked_at).getTime() < LABS_POLICY.minimumCheckSeconds * 1000) throw failure(429, 'Attendez deux secondes entre les vérifications.');
      let potential = session.potential;
      if (session.voluntary_xp && result.status === 'syntax_error') {
        const inserted = await db.prepare('INSERT INTO labs_syntax_errors(session_id,fingerprint,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(session.id, result.errorFingerprint, now());
        if (inserted.changes) potential = Math.max(0, potential - LABS_POLICY.syntaxPenalty);
      }
      const fingerprint = result.fingerprint || hash(req.body.source.replace(/\s+/g, ' ').trim());
      const revisions = session.revisions + Number(session.last_source_hash !== fingerprint);
      return db.prepare('UPDATE labs_sessions SET potential=?,source=?,last_result=?,last_source_hash=?,successful_fingerprint=?,revisions=?,updated_at=?,last_checked_at=? WHERE id=? RETURNING *').get(potential, req.body.source, JSON.stringify(result), fingerprint, result.status === 'valid_syntax' ? result.fingerprint : null, revisions, now(), now(), session.id);
    }); res.json({ session: dto(row) });
  });
  app.post('/api/labs/:id/complete', requireFaculty, async (req, res) => {
    const outcome = await db.transaction(async () => {
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${req.user.faculty_id}:${req.user.filiere_id}`);
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`xp-practice:${req.user.id}`);
      const session = await owned(req, true);
      if (session.completed_at) return { session: dto(session), reason: 'already_completed' };
      let reason = practiceEligibility(session), points = 0;
      if (!reason) {
        const duplicate = await db.prepare('SELECT 1 FROM labs_rewarded_programs WHERE user_id=? AND fingerprint=?').get(req.user.id, session.successful_fingerprint);
        const daily = await db.prepare("SELECT COALESCE(SUM(points),0)::integer AS points FROM xp_events WHERE user_id=? AND category='practice' AND status='valid' AND created_at>=?").get(req.user.id, new Date().toISOString().slice(0, 10));
        if (duplicate) reason = 'similar_program_already_rewarded';
        else if (daily.points >= LABS_POLICY.dailyCap) reason = 'daily_cap_reached';
        else {
          points = Math.min(session.potential, LABS_POLICY.dailyCap - daily.points);
          await db.prepare('INSERT INTO labs_rewarded_programs(user_id,fingerprint,session_id,created_at) VALUES(?,?,?,?)').run(req.user.id, session.successful_fingerprint, session.id, now());
          await db.prepare("INSERT INTO xp_events(user_id,category,event_key,points,details,created_at) VALUES(?,'practice',?,?,?,?) ON CONFLICT(user_id,event_key) DO NOTHING").run(req.user.id, `labs:${session.id}`, points, JSON.stringify({ language: session.language, validation: 'syntax_only', source: 'voluntary_practice' }), now());
        }
      }
      const row = await db.prepare('UPDATE labs_sessions SET completed_at=?,rewarded_points=?,updated_at=? WHERE id=? RETURNING *').get(now(), points, now(), session.id);
      return { session: dto(row), reason: reason || 'qualified_practice' };
    }); await broadcast(req.user.faculty_id, req.user.filiere_id); res.json(outcome);
  });
}
