# CampusLink API

The Express 5 backend uses asynchronous PostgreSQL, Neon Auth and a private Cloudflare R2 bucket. Run commands from the project root with Node 22.13+.

```sh
npm run db:migrate
npm run db:seed
npm run dev
```

`npm run build` then `npm start` serves the production SPA/API on port 3001. Startup also applies migrations and exact reference seeding. No local authentication or disk-upload fallback runs in production.

## Server configuration

[.env.example](../.env.example) lists names without credentials. [env.js](env.js) loads the existing ignored `.env.local`.

- `DATABASE_URL`: Neon PostgreSQL connection.
- `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`: managed authentication service.
- `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_REGION`: private R2 client only. Bucket must be `uploads`.
- `PORT`: API port, default 3001.
- `APP_ORIGIN`: public origin trusted by the authentication provider and allowed for browser mutations. The auth proxy defaults to `http://localhost:5173` for local development, including when the frontend is opened through a LAN IP. Configure the deployed HTTPS origin separately. Express still checks the browser's actual origin; cookies follow the browser's HTTP/HTTPS connection.
- `COOKIE_SECURE=true`: secure cookies behind deployed HTTPS.
- `CAMPUS_DATA_DIR`: source directory for the explicit legacy importer only.

Neon-generated Object Storage `AWS_*` variables are ignored. Credentials never enter React or browser URLs. Provider/DB/storage errors are sanitized.

## Authentication

Neon Auth owns credentials and sessions. The backend proxies login, remote session validation, JWKS verification, logout and password changes. A host-only HttpOnly SameSite=Lax cookie carries only the opaque provider session; production HTTPS uses Secure.

The linked PostgreSQL profile owns existing permissions. Provider role claims cannot grant application roles. Session authorization cutoffs persist across restarts and prevent old sessions from continuing after suspension, role or faculty changes, even if provider admin revocation is unavailable.

Existing accounts with no real email remain unlinked. Use `npm run auth:link -- --username EXISTING_USERNAME --email REAL_EMAIL --confirm-role EXISTING_ROLE [--create]`, with private password entry. Administrator-created accounts remain approved. Public `POST /api/register` creates only a pending student with name, username, email, password, faculty, Filière and current semester. The faculty catalog is available through `GET /api/registration-options`. Pending/rejected sessions can inspect their status and log out, but cannot access protected endpoints.

The global administrator reviews `GET /api/admin/registrations` through `PATCH /api/admin/users/:id/admission` with `status: approved` or `rejected`. Admission cannot be bypassed through profile or ordinary user edits. `DELETE /api/admin/users/:id` accepts only student targets, atomically revokes/unlinks the profile, closes live sessions and anonymizes attribution while preserving shared academic files and foreign-key references. The application retains an anonymous tombstone; this operation does not claim deletion of an existing Neon provider identity. Registration notifications and authorized live updates reach global administrators across faculties, including when notifications are muted.

## Resources and access

Uploads require Filière, semester, module, type, title and file; faculty comes only from the account. The server validates the faculty/Filière mapping, semester1–6, nonempty module, supported content type, file signature and 20 MB limit. SHA-256 identifies duplicate faculty resources.

Private R2 holds all new upload/replacement/avatar bytes. PostgreSQL holds metadata, UUID object keys, module references and version history. Existing local resource files are transferred only by the explicit importer, preserving their original names as metadata.

Protected `/api/files/:id` previews/downloads enforce the current faculty resource permission before R2 retrieval. Source-chat access remains separately restricted to the account's major. The server supports safe byte ranges and private cache headers; no permanent public object URL or storage key appears in DTOs. New avatars stream through protected `/api/avatars/:id`.

Uploads/replacements run metadata changes in transactions and delete attempted objects on failure. Withdrawals remove attachment references and deny further file access, while preserving existing moderation behavior and history. Cleanup errors log generic operation information, never credentials.

## Existing features

Faculty selection remains confirmed and permanent for students. Major setup never repeats faculty selection. Three private study-year chats (S1/S2, S3/S4, S5/S6) coexist with faculty-wide general chat. Permissions apply to reads, replies, reactions, pins, announcements, search, saves, reports and live SSE. Academic resource semesters remain S1–S6.

`POST /api/messages` accepts an optional UUID `client_id`. An identical retry by the same author returns the existing message (200); a new send returns 201. Changed payloads and removed/inaccessible prior messages return 409. Creation and important notifications commit together, preventing duplicates after an interrupted response. Pin responses include the canonical announcement so immediate client updates can reconcile its ID. SSE authorization and notification inserts are batched while retaining their existing scope and preferences.

Scoped administration, contacts, calendar, notifications and profile preferences keep their current behavior. Contact forms persist review requests; they do not send email or perform automatic password resets.

Reports and contact requests insert administrative notifications transactionally with the request. Global administrators receive them across faculties; faculty administrators receive their own faculty's requests, and moderators receive only their own faculty's reports. Anonymous contacts reach global administrators. Notices use the recipient's faculty so cross-faculty global requests remain visible in bootstrap. Administrative notification preferences are respected. Authorized SSE updates refresh the inbox even when notifications are muted; connected clients display only new unread administrative arrivals, with links to the appropriate tab.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for routes/schema and [tests/README.md](../tests/README.md) for regression and live checks.
