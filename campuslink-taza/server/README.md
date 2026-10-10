# CampusLink API

The imported Express 5 backend uses asynchronous PostgreSQL, Neon Auth and a private Cloudflare R2 bucket. Run commands from this project root with Node 22.13+.

```sh
npm run db:migrate
npm run db:seed
npm run dev
```

`npm run build` then `npm start` serves the SPA/API on port 3001. `npm run dev` uses the existing frontend on port 5180 and proxies `/api` to that backend. No local authentication or disk-upload fallback runs in production.

This project owns PostgreSQL schema `campuslink_prj`; the original application's `campuslink` schema remains unchanged. Its metadata, identity links, private object references, and all 22 original tables are copied by the guarded, transactional utility below. The original unknown applied `008_resource_folder_collections.sql` entry and its `resource_folders` / `folder_items` tables are preserved in that copy. Source migrations 001–008 remain byte-for-byte unchanged; migration 009 extends only this project's schema for the current interface.

```sh
node server/clone-metadata.js --source-schema campuslink --target-schema campuslink_prj
```

Cloning requires a distinct, absent or empty target schema and refuses to overwrite existing data. It verifies row counts, recreates foreign keys, and gives identity/serial columns independent sequences before committing. Running it again after a successful migration is intentionally rejected. Do not reset the target or rerun reference/demo seeding to update application content.

## Server configuration

[.env.example](../.env.example) lists names without credentials. [env.js](env.js) loads the existing ignored `.env.local`.

- `DATABASE_URL`: Neon PostgreSQL connection.
- `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`: managed authentication service.
- `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_REGION`: private R2 client only. Bucket must be `uploads`.
- `PORT`: API port, default 3001.
- `APP_ORIGIN`: public origin trusted by the authentication provider and allowed for browser mutations, configured here as `http://localhost:5180`. Configure the deployed HTTPS origin separately. Express still checks the browser's actual origin; cookies follow the browser's HTTP/HTTPS connection.
- `COOKIE_SECURE=true`: secure cookies behind deployed HTTPS.
- `CAMPUS_DATA_DIR`: source directory for the explicit legacy importer only.
- `CAMPUS_DB_SCHEMA=campuslink_prj`: this application's dedicated metadata schema.
- `CAMPUS_DB_MIGRATE=true`: apply additive target migrations at startup. Set false for a deliberately read-only migration check.
- `CAMPUS_DB_SEED=false`: imported reference/catalog data already exists. Explicit `db:seed` remains available for a separately initialized schema.
- `CAMPUS_STORAGE_PREFIX=campuslink-prj/`: all new upload, replacement and avatar keys belong to this project. Existing source object keys remain readable. Automatic cleanup/deletion skips keys outside this prefix so target operations cannot delete source assets.

Neon-generated Object Storage `AWS_*` variables are ignored. Credentials never enter React or browser URLs. Provider/DB/storage errors are sanitized.

## Authentication

Neon Auth owns credentials and sessions. The backend proxies login, remote session validation, JWKS verification, logout and password changes. A host-only HttpOnly SameSite=Lax cookie carries only the opaque provider session; production HTTPS uses Secure.

The linked PostgreSQL profile owns existing permissions. Provider role claims cannot grant application roles. Session authorization cutoffs persist across restarts and prevent old sessions from continuing after suspension, role or faculty changes, even if provider admin revocation is unavailable.

Existing accounts with no real email remain unlinked. Use `npm run auth:link -- --username EXISTING_USERNAME --email REAL_EMAIL --confirm-role EXISTING_ROLE [--create]`, with private password entry. Administrator-created accounts remain approved. Public `POST /api/register` creates only a pending student with name, username, email, password, faculty, Filière and current semester. The faculty catalog is available through `GET /api/registration-options`. Pending/rejected sessions can inspect their status and log out, but cannot access protected endpoints.

The global administrator reviews `GET /api/admin/registrations` through `PATCH /api/admin/users/:id/admission` with `status: approved` or `rejected`. Admission cannot be bypassed through profile or ordinary user edits. `DELETE /api/admin/users/:id` accepts only student targets, atomically revokes/unlinks the profile, closes live sessions and anonymizes attribution while preserving shared academic files and foreign-key references. The application retains an anonymous tombstone; this operation does not claim deletion of an existing Neon provider identity. Registration notifications and authorized live updates reach global administrators across faculties, including when notifications are muted.

## Resources and access

Uploads require Filière, semester, module, type, title, part and file; faculty comes only from the account. Professor/author is optional. Parts are positive decimal strings of arbitrary precision or `complete`, preserving the current interface's Complet/Part-Chapitre behavior. The server validates the faculty/Filière mapping, semester1–6, nonempty module, supported content type, file signature and 20 MB limit. SHA-256 identifies duplicate library resources. Library slots (faculty, program, semester, module, category, part) are checked inside serialized transactions.

`POST /api/uploads` retains the original default behavior (library resource and one chat message). The current interface sends `library_visible=true,publish_message=false` for library-only uploads, or `library_visible=false,publish_message=false` to stage chat attachments. It then posts one `POST /api/messages` with `attachment_ids:[id,...]`, preserving one bubble for several classified files. These files remain outside bootstrap library/search/history listings. Unpublished staged files are readable only by their uploader or an authorized administrator; published chat-only files follow the parent message's faculty/program permissions. Safe message DTOs include an ordered `attachments` array, with the legacy first `resource_id` preserved.

`POST /api/uploads` accepts optional `relative_path` metadata for folder selections. The client submits one document per request, at most two concurrently. Paths preserve the root and nested folders, must be relative and match the supplied filename, and cannot contain traversal or control characters. Migration 007 gives previous resources an empty path. Paths appear in safe resource DTOs, library cards and previews; R2 keys remain private server-generated UUIDs. Omitting this field retains ordinary upload behavior.

Private R2 holds all new upload/replacement/avatar bytes. PostgreSQL holds metadata, UUID object keys, module references and version history. Existing local resource files are transferred only by the explicit importer, preserving their original names as metadata.

Protected `/api/files/:id` previews/downloads enforce the current faculty resource permission before R2 retrieval. Source-chat access remains separately restricted to the account's major. The server supports safe byte ranges and private cache headers; no permanent public object URL or storage key appears in DTOs. New avatars stream through protected `/api/avatars/:id`.

Uploads/replacements run metadata changes in transactions and delete attempted objects on failure. Withdrawals remove attachment references and deny further file access, while preserving existing moderation behavior and history. Cleanup errors log generic operation information, never credentials.

## Existing features

Faculty selection remains confirmed and permanent for students. Major setup never repeats faculty selection. Three private study-year chats (S1/S2, S3/S4, S5/S6) coexist with faculty-wide general chat. Permissions apply to reads, replies, reactions, pins, announcements, search, saves, reports and live SSE. Academic resource semesters remain S1–S6.

`POST /api/messages` accepts an optional UUID `client_id`. An identical retry by the same author returns the existing message (200); a new send returns 201. Changed payloads and removed/inaccessible prior messages return 409. Creation and important notifications commit together, preventing duplicates after an interrupted response. Pin responses include the canonical announcement so immediate client updates can reconcile its ID. SSE authorization and notification inserts are batched while retaining their existing scope and preferences.

The current interface also persists profile `name` / `bio`, accepts avatars up to 2 MB, stores an independent `mentions` preference, and records preview reading history through scoped `POST /api/history`. Ordinary general messages still send no broadcast notifications; an authorized reply can notify only its original author when their mentions preference is enabled. Pin requests can explicitly set `pinned:true/false` and a title for idempotent promotion.

Administrative capabilities from the source remain available: review admissions; provision accounts; assign roles/faculties; suspend/reactivate sessions; delete student profiles; block/unblock chat access; rename discussions or make them read-only; review/resolve reports; answer/close contact requests; publish announcements and calendar events in one/all faculties; edit resource classification/status; replace files with version history; withdraw files; remove messages and pin them into announcements. Global, faculty-administrator and moderator permissions are checked on the server. `GET /api/admin` now includes announcements/events for those authorized roles, and scoped announcement edit/delete plus report notes preserve existing interface actions.

Scoped administration, contacts, calendar, notifications and profile preferences keep their current behavior. Contact forms persist review requests; they do not send email or perform automatic password resets.

Reports and contact requests insert administrative notifications transactionally with the request. Global administrators receive them across faculties; faculty administrators receive their own faculty's requests, and moderators receive only their own faculty's reports. Anonymous contacts reach global administrators. Notices use the recipient's faculty so cross-faculty global requests remain visible in bootstrap. Administrative notification preferences are respected. Authorized SSE updates refresh the inbox even when notifications are muted; connected clients display only new unread administrative arrivals, with links to the appropriate tab.

See the [project README](../README.md) for setup and the [migration API regressions](../tests/backend-migration.test.mjs), [provider-auth regressions](../tests/backend-auth.test.mjs), and [frontend integration checks](../tests/integration.browser.mjs) for validation. API tests use unique disposable PostgreSQL schemas with injected identity/storage, and never reset or seed either application's real metadata.
