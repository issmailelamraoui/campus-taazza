import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
let manifestPromise;
const googleOAuthMigration = '036_google_oauth_sessions.sql';
const googleOAuthTables = ['auth_session_cutover', 'auth_legacy_subjects', 'google_auth_links', 'auth_session_admissions', 'google_oauth_attempts'];

// This is the schema consumed by the API, rather than optional tables preserved
// from an older import. Check actual objects as well as the migration ledger:
// a copied or manually edited ledger alone does not make a database usable.
const requiredSchema = {
  auth_session_cutover:'singleton created_at', auth_legacy_subjects:'auth_user_id user_id',
  google_auth_links:'user_id auth_user_id google_sub email hosted_domain linked_at',
  auth_session_admissions:'session_id auth_user_id session_created_at expires_at method google_sub provider_email hosted_domain user_id',
  google_oauth_attempts:'token_hash intent expires_at expected_auth_user_id expected_user_id expected_session_id expected_session_version expected_auth_revoked_at',
  contact_reactions:'reply_id actor_key reaction',
  realtime_events:'id origin faculty_id filiere_id user_ids change created_at',
  chat_presence:'id user_id faculty_id filiere_id channel semester expires_at',
  upload_sessions: 'id user_id faculty_id target_path fields filename mime size object_prefix parts state response_status response_body cleanup_pending created_at expires_at',
  schema_migrations: 'name sha256 applied_at',
  faculties: 'id', filieres: 'id faculty_id', semesters: 'id',
  users: 'id auth_user_id session_version account_status registered_at reviewed_at reviewed_by bio current_academic_year password_change_required password_reset_operation_id password_reset_expires_at',
  password_reset_operations: 'operation_id actor_id target_user_id auth_user_id status request_salt request_hash expires_at',
  modules: 'id faculty_id filiere_id semester name',
  messages: 'id client_id',
  resources: 'id object_key sha256 version relative_path part_number teacher_name library_visible academic_year academic_years',
  resource_versions: 'id resource_id version object_key sha256',
  reactions: 'message_id user_id reaction',
  announcements: 'id title filiere_id kind public_author_label',
  notifications: 'id target_deleted registration_user_id', events: 'id', channels: 'id faculty_id',
  saved: 'user_id type target_id', history: 'user_id resource_id opened_at',
  reports: 'id note target_context', contacts: 'id assigned_to accepted_at closed_at recovery_hash client_id category updated_at filiere_id',
  legacy_imports: 'source_sha256', chat_bans: 'user_id',
  message_attachments: 'message_id resource_id position',
  message_module_shares: 'message_id resource_id faculty_id filiere_id semester module',
  platform_owner: 'singleton user_id', scoped_appointments: 'id capabilities revoked_at',
  administrative_audit: 'id actor_id action details', xp_events: 'id user_id event_key status category points',
  notification_visits: 'token notification_id user_id viewed_at departed_at expires_at',
  discussion_reads: 'user_id faculty_id channel filiere_id semester last_read_id updated_at',
  contact_replies: 'id contact_id author_id', contact_attachments: 'id contact_id object_key',
  reading_positions: 'user_id resource_id document_version page revision',
  reading_position_conflicts: 'user_id resource_id document_version device_id',
  knowledge_items: 'id user_id resource_id document_version anchor revision',
  study_tools: 'id user_id review_due_at review_interval_days review_ease review_repetitions review_lapses review_last_at',
  flashcard_reviews: 'user_id card_id operation_id',
  document_text_indexes: 'resource_id document_version status source_sha256',
  document_text_pages: 'resource_id document_version page text search_vector',
  reading_activity_sessions: 'user_id resource_id document_version page',
  campus_questions: 'id source_version source_anchor source_excerpt',
  campus_answers: 'id question_id', campus_comments: 'id answer_id', campus_votes: 'answer_id user_id',
  close_requests: 'id source_version source_anchor expires_at close_reason',
  close_rooms: 'id requester_id helper_id board_revision requester_consent helper_consent recording',
  close_messages: 'id source_version', close_board: 'id room_id revision operation',
  campus_blocks: 'blocker_id blocked_id', study_matches: 'id user_id',
  study_match_requests: 'id requester_id recipient_id', revision_groups: 'id owner_id',
  revision_members: 'group_id user_id', revision_messages: 'id source_page source_version',
  market_listings: 'id seller_id', market_requests: 'id listing_id author_id',
  market_request_replies: 'id request_id author_id', campus_reports: 'id reporter_id target_type target_id',
  labs_sessions: 'id user_id language', labs_syntax_errors: 'session_id fingerprint',
  labs_rewarded_programs: 'user_id fingerprint',
  document_relations: 'id exercise_resource_id course_resource_id status',
  document_repairs: 'id resource_id status revision', document_repair_events: 'id proposal_id action',
  resource_supplements: 'main_resource_id supplement_resource_id linked_by',
  forum_attachments: 'id question_id author_id client_id status cleanup_pending file_deleted_at',
};

async function migrationManifest() {
  manifestPromise ??= (async () => {
    const names = (await readdir(migrationsDirectory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    return Promise.all(names.map(async name => ({
      name,
      sha256: createHash('sha256').update(await readFile(new URL(name, migrationsDirectory))).digest('hex'),
    })));
  })();
  // A temporary filesystem failure must not permanently poison later checks.
  try { return await manifestPromise; }
  catch (error) { manifestPromise = undefined; throw error; }
}

export async function inspectSchemaReadiness(db, { allowUnmigratedGoogleOAuth = false } = {}) {
  const manifest = await migrationManifest();
  const catalog = await db.query(`SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`, [db.schema]);
  const tables = new Map();
  for (const { table_name: table, column_name: column } of catalog.rows) {
    if (!tables.has(table)) tables.set(table, new Set());
    tables.get(table).add(column);
  }
  const missingTables = [], missingColumns = [];
  for (const [table, columns] of Object.entries(requiredSchema)) {
    if (!tables.has(table)) { missingTables.push(table); continue; }
    for (const column of columns.split(' ')) if (!tables.get(table).has(column)) missingColumns.push(`${table}.${column}`);
  }
  const ledgerExists = tables.get('schema_migrations')?.has('name') && tables.get('schema_migrations')?.has('sha256');
  const applied = ledgerExists ? await db.prepare('SELECT name,sha256 FROM schema_migrations').all() : [];
  const checksums = new Map(applied.map(row => [row.name, row.sha256]));
  const pendingMigrations = manifest.filter(row => !checksums.has(row.name)).map(row => row.name);
  const changedMigrations = manifest.filter(row => checksums.has(row.name) && checksums.get(row.name) !== row.sha256).map(row => row.name);
  // A rollout with Google explicitly disabled can still serve the previous
  // password-only application schema. Never treat a partially applied or
  // damaged OAuth schema as the pre-feature schema, or ignore other upgrades.
  const deferGoogleOAuth = allowUnmigratedGoogleOAuth && pendingMigrations.includes(googleOAuthMigration)
    && googleOAuthTables.every(table => !tables.has(table));
  const deferredMigrations = deferGoogleOAuth ? [googleOAuthMigration] : [];
  const ready = !pendingMigrations.some(name => !deferredMigrations.includes(name)) && !changedMigrations.length
    && !missingTables.some(table => !(deferGoogleOAuth && googleOAuthTables.includes(table))) && !missingColumns.length;
  return { ready, pendingMigrations, changedMigrations, missingTables, missingColumns, deferredMigrations };
}

function schemaError(report) {
  const pendingMigrations = report.pendingMigrations.filter(name => !report.deferredMigrations.includes(name));
  const code = report.changedMigrations.length ? 'MIGRATION_CHECKSUM_MISMATCH'
    : pendingMigrations.length ? 'SCHEMA_MIGRATIONS_PENDING' : 'DATABASE_SCHEMA_INCOMPLETE';
  return Object.assign(new Error('The application database schema is not ready.'), { status: 503, code, readiness: report });
}

export async function assertSchemaReady(db, options) {
  const report = await inspectSchemaReadiness(db, options);
  if (!report.ready) throw schemaError(report);
  return report;
}

// Only trusted startup logs receive object names. Never include database URLs,
// driver messages, imported migration names, query text or underlying causes.
export function schemaReadinessDiagnostic(error) {
  if (error?.code === 'DATABASE_UNAVAILABLE') return 'CampusLink API startup failed: the PostgreSQL connection is temporarily unavailable after startup retries. Check database availability and network access, then restart npm run dev. No migrations or seed were run.';
  if (error?.code === 'AUTH_CONFIGURATION') return 'CampusLink API startup failed: Neon Auth configuration is incomplete. Check NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL in the server environment.';
  if (!error?.readiness) return 'CampusLink API startup failed. Check server configuration and database availability.';
  const { changedMigrations, missingTables, missingColumns, deferredMigrations = [] } = error.readiness;
  const pendingMigrations = error.readiness.pendingMigrations.filter(name => !deferredMigrations.includes(name));
  if (changedMigrations.length) return `CampusLink API startup failed: applied migration checksums differ (${changedMigrations.join(', ')}). Restore the matching migration files before applying new migrations.`;
  if (pendingMigrations.length) return `CampusLink API startup failed: ${pendingMigrations.length} pending migrations (${pendingMigrations.join(', ')}). Run npm run db:migrate with the intended database configuration, then restart npm run dev.`;
  const requiredMissingTables = deferredMigrations.includes(googleOAuthMigration) ? missingTables.filter(table => !googleOAuthTables.includes(table)) : missingTables;
  return `CampusLink API startup failed: database schema is incomplete (${[...requiredMissingTables, ...missingColumns].join(', ')}). Check the selected schema and restore missing objects before restarting.`;
}

export function createSchemaReadinessCheck(db, { cacheMillis = 5000, clock = Date.now, allowUnmigratedGoogleOAuth = false } = {}) {
  let successfulAt = -Infinity, pending;
  return async function checkReadiness() {
    if (clock() - successfulAt < cacheMillis) return { ok: true };
    if (pending) return pending;
    pending = (async () => {
      try {
        await assertSchemaReady(db, { allowUnmigratedGoogleOAuth });
        successfulAt = clock();
        return { ok: true };
      } catch (error) {
        return { ok: false, code: error?.readiness ? 'SCHEMA_NOT_READY' : 'DATABASE_UNAVAILABLE' };
      }
    })();
    try { return await pending; }
    finally { pending = undefined; }
  };
}
