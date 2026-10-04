# CampusLink Taza persistence migration — 2026-10-03

## 1. Architecture detected

The existing project uses React 19, React Router, Vite, Express 5 and direct prepared SQL, with no ORM. Previously, Node SQLite held accounts/content/local sessions and `data/files` held documents. React calls same-origin `/api`; localStorage only keeps interface preferences.

The architecture is preserved, with asynchronous `pg` queries, Neon Auth provider sessions and private R2 objects. Existing themes, responsive navigation, three languages and RTL remain in place.

## 2. Files changed

- Backend: `server/app.js`, `db.js`, `index.js`, `seed.js`.
- Added services/commands: `server/env.js`, `auth.js`, `storage.js`, `migrate.js`, `import-local.js`, `link-auth.js`, `check-storage.js`, and `server/migrations/001_application_schema.sql`.
- Interface: `shared/studies.js`, `src/pages/CommunityPages.jsx`, `AdminPage.jsx`, `src/components/Modals.jsx`, `src/i18n.js`.
- Validation: API/study/browser suites, async browser runner, `tests/helpers.mjs`, `auth.test.js`, `migration.test.js`, `infrastructure.mjs`.
- Setup/docs: `package.json`, lockfile, `.env.example`, `README.md`, `ARCHITECTURE.md`, `server/README.md`, `tests/README.md` and this report.

Existing workspace appearance edits were preserved. `.env.local` was not modified or exposed.

## 3. Packages

Added `pg`, `@aws-sdk/client-s3` and `jose`. No existing framework or ORM was replaced. Neon Auth uses its REST API; the SDK evaluated during implementation and its unused dependencies were removed.

## 4. Database schema

The isolated `campuslink` schema contains 19 tables: faculties, filieres, semesters, users, modules, messages, resources, resource_versions, reactions, announcements, notifications, events, channels, saved, history, reports, contacts, schema_migrations and legacy_imports.

Existing IDs/field names remain compatible. Users store provider subject/email plus their trusted existing role, faculty, major and semester. Resources store owner, classification, module reference, original filename, MIME/size/hash and private object key. The provider-owned `neon_auth` schema remains separate. There is no active local session table or password verifier.

## 5. Migrations and seeds

Versioned SQL migration `001_application_schema.sql` is transactional and checksum tracked. Reference seeding keeps exactly the existing four faculties, 17 Filières and six semesters. CLI commands are `npm run db:migrate`, `npm run db:seed`, and `npm run db:import-local`; startup also applies migrations/reference seeds. The existing demo seed remains optional via `--demo`.

The importer reads SQLite and files without modifying them, verifies file integrity, preserves identifiers/relationships and stores an idempotent source marker. Legacy unclassified records retain their original classification without guessed assignments.

## 6. Neon PostgreSQL result

Real connection, migrations, expected tables, temporary write/read/rollback, nested transactions, close/reopen and idempotent reference seeding passed.

Production data imported: 12 profiles, 35 messages, 17 resources, 10 reactions, four announcements, 13 notifications, eight events, 20 channels, one saved item, five history records and three reports. Seventeen original files were transferred to R2. Existing SQLite and local files remain recoverable originals.

## 7. Neon Auth result

Real provider registration, login, remote session/JWKS validation, logout and restart checks passed. The backend proxies provider cookies as host-only HttpOnly SameSite=Lax cookies and authorizes only from trusted PostgreSQL profiles. Username login resolves its linked provider email. Password changes use the provider; persisted revocation cutoffs block old app access even when provider admin revocation is unavailable.

New admin-provisioned accounts require actual email. The existing administrator is now linked to its proven Neon identity through the operator CLI. Real username and email login, session persistence, private administration access, frontend login and chat reload passed; the Issmail profile, global administrator role and Sciences de Données selection were preserved. Other imported profiles still require explicit activation. No invented emails or automatic privileged identity mappings were created.

## 8. Cloudflare R2 result

Only the five `R2_*` variables configure the S3-compatible client and private `uploads` bucket. Neon Object Storage `AWS_*` variables are ignored. A real tiny-object PUT, HEAD, authenticated GET and DELETE test passed, with absence confirmed afterward. A separate real application upload/download and unauthorized-access test passed. Temporary objects were removed.

## 9. Upload/retrieval strategy

Faculty comes from the authenticated account. Required classification stays Filière → semester → module → type → title → file. Modules load from persisted scoped rows. The server validates fields, supported signatures/extensions and the 20 MB limit before PUT.

Safe UUID keys identify R2 objects; original names remain metadata. PostgreSQL transactions link resource/message/version records. Failed or ambiguous PUT/DB operations attempt deletion of the generated object, with sanitized cleanup diagnostics.

Protected `/api/files/:id` streams permitted previews/downloads with private caching, safe headers and byte-range support. Storage keys/credentials and permanent public URLs never reach the browser. New uploaded avatars also use R2. General document corrections preserve semester/module classification.

Faculty-wide general chat remains available. Private major chats use three study-year groups: S1/S2, S3/S4 and S5/S6, enforcing major and group scope across reads/actions/pins/search/live updates. Academic resource semesters remain independent. The compact phone selector remains inside the chat header.

## 10. Validation results

- `npm test`: **38/38 passed**, including real provider auth, isolated real PostgreSQL metadata, rollback/compensation, imports, permissions, versions, SSE and restart persistence.
- `npm run test:r2`: real bounded upload/stat/read/delete passed.
- `npm run test:infrastructure`: real Neon Auth + PostgreSQL + R2 registration, academic profile/module/resource persistence, protected file retrieval, semester chats, cross-major/anonymous/foreign-faculty rejection and app/DB restart passed in the original infrastructure validation. All temporary accounts, objects and schema were cleaned. The current paired-group change has separate focused regression coverage.
- Production migration command succeeded and verified idempotently after import.
- Frontend build passed. All six browser suites passed across the full validation and targeted reruns: Filière, community, study, administration, theme and responsive. Updated administration tests verified general-document semester/module preservation; final theme tests verified auth/storage errors in FR/AR/EN. Browser metadata used disposable real Neon schemas with injected provider/storage fixtures, followed by cleanup.
- All 17 production resource objects were retrieved from R2 and their bytes matched the original SHA-256 values stored in PostgreSQL.
- Secret scan passed for `dist`, including source maps. No configured database/auth/storage values were present.
- `git diff --check` passed.

## 11. Remaining issues

Other imported account activation requires actual email-to-profile linking. The existing administrator activation is complete. The provider currently disables self-deletion; cleanup for newly created, unlinked test/failed-provisioning identities is strictly guarded to their exact owned subject/email/recent creation time. Existing provider users are not arbitrarily deleted.

Build output includes nonblocking dependency directive/source-map and bundle-size warnings. No application redesign or unnecessary framework was introduced to address those unrelated warnings.

## 12. Manual action

The existing administrator requires no further activation action. For a fresh imported administrator, run from the project directory with its actual email:

```sh
npm run auth:link -- --username admin --email REAL_EMAIL --confirm-role global_admin --create
```

The command prompts privately for the new provider password. Omit `--create` for an existing Neon identity and enter its password. Repeat for other imported profiles using their real email and existing stored role. Newly provisioned accounts in the admin UI already receive linked identities.

Frontend runs at http://localhost:5173 and API at http://localhost:3001. HTTPS deployment additionally needs the actual allowed origin and Secure cookie configuration described in the README.

## 13. Study-year chats and immediate actions

Migrations 004 and 005 were applied to the application schema in a transaction with before/after checks: all 37 message IDs and 17 resources were preserved, as were replies, pins, announcements, reactions, modules, account identities and academic semester selections. Only even-semester Filière chat scopes were folded into their study-year group. The local API was restarted and both port 3001 and the frontend API proxy on port 5173 returned healthy responses.

The existing chat design, background and colors were retained at the user's request. UI mutations now appear immediately and reconcile with the server; failures roll back their own change. Failed sends remain retryable with their original author-scoped UUID. Background refreshes are coalesced, and message creation/important notifications commit atomically.

Focused validation passed: 12 study/API tests, 4 message-idempotency/API tests, 7 optimistic-state tests, and the Filière, responsive and optimistic browser suites. Browser checks include paired-year defaults/legacy links/privacy, phones/tablets/desktops and RTL, delayed requests, failure rollback and SSE acknowledgement reconciliation. Each browser/API fixture uses a disposable PostgreSQL schema and injected provider/storage fixtures; application data is untouched by those tests.

The moderation browser suite also passed with the retained colors: public student identities, delete permissions, resource retention, one message menu, eight responsive/theme/RTL menu checks and live blocking/restoration. A held pending send returned 403 after blocking, and its draft stayed absent after restoration in the same mounted provider without reloading. No runtime errors or unexpected 500 responses occurred.

## 14. Student registration approval and account deletion

Self-service registration collects name, username, email, password, faculty, the faculty's existing Filière and the exact current semester. It creates a pending student whose session can inspect the request status but cannot enter the community or access private APIs. The global administrator receives requests across faculties and accepts or refuses them in **Administration → Demandes d’inscription**. Approved existing and administrator-provisioned accounts retain their access.

The administrator can delete a student through **Utilisateurs → Gérer → Supprimer l’étudiant**, with confirmation. The application immediately removes the row from the interface, revokes and unlinks the profile transactionally, closes its live chat session and anonymizes shared attribution. Academic files and their references remain available. Existing Neon provider identities are retained; this action removes local community account access. Concurrent registration refreshes cannot restore a student row while deletion is pending.

Migration 006 is present in the application schema. A transaction compared all existing fields across 19 application tables before and after migration: 12 profiles, 39 messages and 17 resources were preserved, including identities, study selections, references and shared files. No real student was registered, approved, rejected or deleted during validation. The API and Vite frontend were started on ports 3001 and 5173; direct and proxied health checks passed, and the public registration catalog returned the existing four faculties and 17 Filières.

Final validation passed: 10 registration/API tests, 7 optimistic-state tests, the registration browser suite, production build and whitespace checks. Browser checks include pending API/UI isolation, acceptance/refusal, live admin requests with muted notifications, delayed deletion during a concurrent signup, immediate logout from an open chat, retained files, and readable phone/tablet/desktop and Arabic RTL layouts. Database/browser fixtures used disposable schemas and identity/storage doubles and were cleaned afterward. A narrowly scoped CSS fix restores language, appearance and close controls inside the public phone settings drawer while preserving the existing header rules and chat colors.

The chat's three-dot message trigger is explicitly visible through a scoped CSS rule, despite the existing global icon-button hiding rule. Chat colors and menu logic were preserved. The final chat moderation browser rerun passed all eight device/theme/RTL menu checks, single-menu dismissal, message deletion/resource retention and live blocking; its disposable fixture was cleaned afterward.

## 15. Phone signup through the local network

The phone frontend origin reached Express successfully, but Neon Auth rejected that LAN origin with `INVALID_ORIGIN`. The auth proxy now uses the configured `APP_ORIGIN`, defaulting to `http://localhost:5173` in local development, for provider requests. Browser mutation-origin checks and HTTP/HTTPS cookie rules are preserved. No environment secrets or frontend/chat styles were changed.

Nine mock auth checks passed, including LAN registration/session lifecycle, default configuration, cookie transport and operator identity proof. A bounded real Neon signup/login/session/logout test also passed with LAN request headers and the factory's default origin; its temporary profile, provider identity and schema were removed. The backend was restarted, and the phone URL `http://192.168.1.102:5173` served the registration page and healthy API. Same-origin phone submissions reached field validation while foreign browser origins remained blocked. Existing application accounts were not changed.

## 16. Administrative popups, readable community pages and home-screen installation

Connected administrators receive temporary popups only for new unread reports, contact requests and registration requests. Existing notifications, ordinary conversations and important chat notices do not create these popups. Opening a popup marks its notice read and selects the matching administration tab. Account changes, duplicate refreshes, reconnects and notices read elsewhere cannot repeat or retain a stale popup. Muted administrative notifications suppress popups while the authorized inbox still refreshes live. Global administrators receive cross-faculty requests; faculty administrators and moderators retain their existing scoped permissions. New report/contact notices use the recipient's own faculty and commit together with the request.

Reply and the existing three-dot menu are visible on phones, tablets and desktops, with separate phone touch targets. Received-message text is readable in light mode; the existing dark chat canvas, bubbles and colors are retained. Library categories, study years and documents have distinct surfaces and accents. Member cards distinguish the current student and online status, retain public student identities and adapt to narrow screens. A scoped resource-card rule restores the save action without changing the user's global icon-button hiding rule.

Settings now contains an Application card with browser installation or home-screen instructions in French, Arabic and English. The manifest provides standalone display and correctly sized application icons. Secure contexts register a service worker that caches only public assets and shows a generic public offline page; private application HTML, API data, academic files and avatars never enter that cache. The phone's current HTTP LAN address offers a browser shortcut; full PWA installation requires HTTPS or localhost.

Validation passed: 17 backend/API tests, 2 administrative-arrival unit tests, 8 PWA unit tests, 7 optimistic-state tests, the administrative-alert browser suite and the registration browser suite. Additional mocked browser checks passed for 24 chat device/theme/RTL combinations, six library/member layouts, four short-phone popup bursts with touch/wheel scrolling, and the installation/offline/cache flow. Library route/preview/save/reload/search and member browser checks also passed. The full Study suite stops at the pre-existing hidden calendar “Mois suivant” control caused by the global icon-button rule; that unrelated calendar rule was preserved, and the full suite is not reported as passing.

Browser/API fixtures use disposable PostgreSQL schemas and injected identity/storage fixtures; cleanup completed and port 5174 closed. No real student was created, accepted, refused or deleted by these checks. This update needs no database migration. The final production build and whitespace/syntax checks passed. The backend was restarted with the new administrative notification logic; direct, frontend-proxy and phone-LAN health checks returned 200, as did the manifest, service worker and application icon URLs.

## 17. Instant message sending from phones on the local network

Reproduced the reported failure on the actual HTTP LAN origin with a touch phone viewport: the send button was enabled and reachable, but `crypto.randomUUID` was undefined. Tapping it threw before creating an optimistic message or making a POST; the typed draft stayed in the composer. The browser still provided `crypto.getRandomValues`, consistent with the documented [randomUUID secure-context requirement](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID) and [getRandomValues availability](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues).

A shared client-ID helper now uses native UUIDs when available and a cryptographic UUID v4 fallback otherwise. Both message drafts and toast IDs use it. Existing optimistic sending, server deduplication and retry IDs remain intact: the message appears immediately, the composer clears and remains usable, and delivery reconciles in the background. No backend, database, chat colors or layout changes were required.

Validation passed: three client-ID unit tests, seven optimistic-state tests, production build and whitespace checks. The new fully mocked phone browser suite passed on the actual LAN HTTP origin with native randomUUID still absent. It covers held concurrent POSTs, stale refreshes, SSE-before-ack deduplication, failed-send feedback and same-ID retries, major-group/reply payloads, read-only channels, and 12 French/Arabic light/dark touch layouts. A reduced viewport simulates keyboard space; send targets remain at least 44×44 pixels and unobstructed. All APIs and event streams are intercepted, so no real messages, users or provider records were created or changed. The local Vite frontend serves the fix immediately.

## 18. Receiving messages without leaving the chat

Reproduced missed incoming messages after stream reconnection and phone foreground/network recovery, and refresh starvation during a continuous burst of live events. The previous client listened only for update events and repeatedly postponed its debounce timer; it provided no catch-up or periodic reconciliation. An isolated in-memory backend with a real Vite proxy confirmed that SSE headers, general and major-scoped updates, foreign-faculty isolation and the fifteen-second heartbeat work without a transport redesign.

The frontend now coalesces background refreshes into one request at a time with one queued follow-up, catches up when SSE opens/reconnects or the browser returns online/foreground, and reconciles every ten seconds while visible and online. A twenty-second bootstrap deadline releases stalled requests. Hidden/offline polling pauses; logout/expiry remove live listeners, and chat blocking closes the stream. Pending drafts and same-ID retries remain visible and deduplicate as before. Account identity is included in live-stream ownership; faculty, major and paired-year permissions remain enforced by the existing backend.

During final service verification, the running backend had exited with an unhandled error event from its PostgreSQL pool. A pool error listener now logs a fixed sanitized message and allows pg to discard failed idle clients and reconnect, consistent with the [official pool error contract](https://node-postgres.com/apis/pool#events). The backend was restarted with this fix. No schema migration or chat style change was required.

Validation passed: three refresh-queue unit checks, one injected idle-pool-error check, seven optimistic-state checks and three client-ID checks. The live-chat browser suite passed all twelve groups, including held-request timeout, missed-event recovery, pending/retry preservation and session/major/block isolation. The HTTP LAN phone-send suite passed again, including twelve touch/theme/RTL layouts. Every browser API was mocked; no real student or message was created or modified. Production build and whitespace checks passed. Direct, frontend-proxy and phone-LAN health returned 200 after restart, and the compiled chat page was served successfully.
