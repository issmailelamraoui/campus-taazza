# CampusLink Taza architecture

## Application

React 19, React Router and Vite serve the existing SPA. Express 5 serves JSON APIs, private file streams and SSE on port 3001; development Vite proxies same-origin `/api` requests. No ORM was present or added. The existing prepared-query interface now wraps asynchronous `pg` queries.

PostgreSQL stores all application records in the isolated `campuslink` schema. The managed `neon_auth` schema remains provider-owned. R2 stores document/image bytes; localStorage only keeps non-sensitive language, theme and panel preferences. SSE clients and rate counters are process-local; persisted content is independent of them.

## PostgreSQL

[server/db.js](server/db.js) binds all values as parameters, qualifies application tables for Neon transaction pooling, and retains `prepare().get/all/run` as async operations. `run` returns inserted IDs and affected counts. Transactions use AsyncLocalStorage and a dedicated pool client, with queued queries and nested savepoints.

The versioned SQL migration [001_application_schema.sql](server/migrations/001_application_schema.sql) creates:

| Tables | Purpose |
| --- | --- |
| faculties, filieres, semesters | Existing reference catalog and exact mappings |
| users | Linked provider subject/email, existing numeric ID, role, faculty, major, current semester, settings |
| modules | Existing/imported or user-submitted module names scoped to faculty, major and semester |
| messages, reactions | Faculty discussions and private major/semester chats |
| resources, resource_versions | Metadata, owner, module reference, original filename, MIME/size/hash, private object key and revisions |
| announcements, notifications, events | Existing communication and calendar records |
| channels | Existing channel settings/read-only controls |
| saved, history, reports, contacts | Existing personal and administration workflows |
| schema_migrations, legacy_imports | Migration checksums and idempotent import markers |

There is no application sessions table and no active local password verifier. Imported legacy password hashes are inactive archival fields and are removed on identity linking. Resources retain existing field names: `author_id` is the owner, `filename` is the original filename, `mime` is the MIME type and `size` is byte size. New resources reference a persisted `module_id`.

## Identity and authorization

[server/auth.js](server/auth.js) calls the configured Neon Auth Better Auth REST service. Login submits email/password to that provider; a username first resolves its linked email from PostgreSQL. The backend verifies the remote session and JWKS-signed JWT subject, issuer, audience and expiry. Provider claims never assign application roles.

The browser receives a host-only HttpOnly SameSite=Lax cookie containing the opaque provider token. Localhost uses the same proxy flow without a Secure-only provider cookie name. The backend translates it when calling Neon Auth; it issues no competing local session. Logout and password changes use provider APIs.

Trusted PostgreSQL profiles determine faculty, major and role on every request. Disabled, unlinked, mismatched and revoked profiles are denied. If the managed provider does not allow cross-user admin session revocation, the persisted application authorization cutoff still denies prior sessions. The configured branch disables self-deletion; failed fresh provisioning cleanup is guarded to the exact new, unlinked subject/email/recent creation time. Arbitrary identity removal uses provider admin APIs.

[server/link-auth.js](server/link-auth.js) is a trusted operator command with private stdin password entry, provider ownership proof, and explicit confirmation of the already stored role. It does not create roles from browser/provider data or automatically link legacy usernames.

## Frontend contract

`useApp()` continues to supply user, bootstrap data, login/logout, refresh, translations, theme, modals and saved items. `api()` calls same-origin `/api` with cookies. JSON/FormData contracts remain compatible, apart from actual email required for new Neon account provisioning.

Bootstrap contains user, faculty, filieres, channels, messages, resources, announcements, notifications, members, events, saved and history. Storage keys, legacy hashes and private provider session data are excluded from DTOs.

Migration 006 adds `account_status` with approved, pending, rejected and deleted states; existing profiles default to approved. Public registration uses Neon Auth and creates a pending student with their full academic selection. Pending/rejected sessions expose only account status and public metadata, and are rejected by the API gate before private reads or writes. Global administrators review requests independently of their own faculty; notification and SSE recipients remain restricted to approved global administrators. Student account deletion revokes and unlinks the profile in a transaction, preserves an anonymous row for academic references, and closes its live streams. Client registration revisions refresh the admin queue even with muted notifications; pending deletion overlays survive concurrent queue updates.

`AdminNotificationFeed` establishes a baseline for each administrator identity/faculty/role and emits only subsequent unread administrative requests. Seen IDs suppress repeated refreshes and reconnects; account changes clear transient alerts. Report/contact notifications and authorized `adminInbox` SSE events support global cross-faculty review while keeping faculty-admin/moderator permissions scoped. Reading a notice also dismisses its open popup.

The installable frontend uses a manifest, application icons and an early browser-install listener. Settings provides installation or browser-specific home-screen instructions. A secure-context service worker caches only explicitly allowed public assets; navigation uses the network and falls back to a generic public offline page. Application HTML, API responses, messages, uploads, avatars and academic documents are never stored in its cache. Local HTTP phone access provides home-screen shortcuts; full installation uses HTTPS or localhost.

## Important routes

| Route | Behavior |
| --- | --- |
| POST /api/login; GET /api/session; POST /api/logout | Provider authentication through the backend |
| GET /api/faculties; POST /api/faculty | Confirmed first faculty selection |
| GET/POST /api/studies | Major/current semester for the existing faculty |
| GET /api/modules | Persisted module options by own faculty, major and semester |
| GET /api/bootstrap | Scoped existing application content |
| GET/POST /api/messages | Faculty channel or own-major study-year chat; optional author-scoped client_id for safe send retries |
| GET /api/messages/:id; POST reaction/pin | Scope-aware message actions |
| POST /api/uploads | Validated classification, private R2 object and transactional metadata/message |
| GET /api/files/:id | Authorized resource preview/download with optional byte range |
| GET /api/avatars/:id | Protected uploaded avatar |
| GET /api/events/stream | Authorized live refresh events |
| GET /api/search; POST /api/saved; POST /api/notifications/read | Existing scoped search/personal workflows |
| PATCH /api/profile | Profile/settings/avatar and provider password change |
| GET /api/admin; POST /api/admin/users | Existing administration and account provisioning |
| PATCH /api/admin/users/:id; channels/reports/contacts | Existing role-gated management |
| PATCH /api/admin/resources/:id; POST replace; DELETE resource | Existing correction/versioning/withdrawal |
| POST /api/admin/announcements; events | Scoped announcements and calendar publication |

Existing SPA routes and resource/message/announcement anchors are preserved.

## Chats

`shared/studies.js` remains the faculty/Filière source of truth. Academic semesters stay independent; private chat groups are S1/S2, S3/S4 and S5/S6, stored as 1, 3 and 5. General chat stores null major/semester and stays faculty-wide. Private `filiere` messages use the account's major, with replies constrained to that study-year group. Students can visit any group within their own major. Migration 004 folds previous even-semester conversations while retaining message IDs and academic selections.

The frontend keeps authoritative bootstrap data separate from pending action overlays. Sending, deleting, pinning, reacting, saving and reading notifications update immediately; a failed action removes only its own overlay. Sends retain their client UUID for manual retry, with server uniqueness on `(author_id, client_id)` and transactional notifications. SSE and mutation refreshes are coalesced, and older in-flight snapshots cannot overwrite a confirmed action. Toggle endpoints are not retried automatically after ambiguous network failures.

`createClientId` uses native `crypto.randomUUID` when available and otherwise constructs a cryptographic UUID v4 from `crypto.getRandomValues`. This supports the phone's HTTP LAN origin without changing the backend UUID contract or requiring HTTPS to send. Toasts use the same helper so failed-send feedback remains functional. Optimistic messages appear before the asynchronous request completes; retry retains the original message UUID.

Live signals use `RefreshQueue`: the first signal schedules a snapshot without waiting for the entire event burst to end, and signals received during a slow refresh queue one following snapshot. SSE opening/reconnection and browser foreground/network recovery also synchronize the current account. Visible, online accounts reconcile every ten seconds if a stream silently misses an event; polling pauses when hidden/offline and ends on logout or expiry. Chat blocking closes its stream while authorized bootstrap polling can observe restored access. Bootstrap requests have a twenty-second deadline so a stalled request cannot hold the queue forever. Existing account epochs, optimistic overlays and backend faculty/major permissions still apply.

The PostgreSQL pool handles idle-client error events with a fixed sanitized log message. Failed idle clients are removed by pg, and subsequent requests can reconnect without terminating Express and every live chat stream.

Private message permissions apply to direct reads, replies, reactions, saves, reports, pins, search, linked announcements, notification filtering and SSE. The existing faculty-wide library is preserved; source discussion IDs are omitted for an inaccessible private chat.

## Private storage and consistency

[server/storage.js](server/storage.js) uses only explicit `R2_*` configuration with the minimal S3 SDK. New resource keys contain major/semester/module/UUID. Legacy unclassified files and replacements retain classification and use safe UUID legacy/version prefixes. Original names are never object identifiers.

The server validates supported signatures/extensions, fields, faculty catalog and size before PUT. Transactional metadata links one resource to its chat message. Attempted UUID objects are deleted on failed PUT/DB commit where possible; cleanup failures have sanitized diagnostics. Files stream through protected backend routes with private caching, nosniff and sandboxed previews, without public URLs or client credentials.

## Import and startup

Migration and reference seed commands are reproducible and idempotent. The importer opens SQLite read-only, checks source file integrity, preserves all existing IDs/relationships/selections, transfers bytes to R2, and stores an import checksum inside the transaction. Repeated identical import does not duplicate data. Legacy canonical semester values are preserved; lost historical even-semester origins are not guessed.

Fresh startup applies migrations and exact reference data. Demo content is optional through the existing seed system. Existing dark/light/RTL/responsive design tokens and components remain in place.
