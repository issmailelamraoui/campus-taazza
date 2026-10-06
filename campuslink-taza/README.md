# CampusLink Taza

The existing React/React Router/Vite frontend and Express 5 backend now use **Neon PostgreSQL**, **Neon Auth**, and **private Cloudflare R2** storage. The current layout, faculty colors, dark/light appearance, French/Arabic/English translations, RTL behavior and mobile settings are preserved.

## Run

Requires Node 22.13+ and npm. Server configuration is loaded from the existing ignored `.env.local`; variable names are documented in [.env.example](.env.example). Never add client prefixes to credentials.

```sh
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

Frontend: http://localhost:5173. API: http://localhost:3001.

```sh
npm run build
npm start
```

Production serves the SPA and API together on port 3001. `./start.sh` discovers the workspace's Node runtime, builds and starts the application. Startup applies reproducible migrations and idempotent reference seeding; it does not silently create demo users.

## Existing data and account identities

The read-only importer preserves existing numeric IDs, account roles and academic selections, messages, replies, pins, saved items, notifications and resource/version references. It transfers local files to private R2; the original SQLite database and files remain untouched.

```sh
npm run db:import-local
```

Import requires an empty application content schema and records its source checksum. Repeating the same import does not create duplicate rows or files. Legacy unclassified resources retain their metadata; no major or module assignment is guessed.

Existing local accounts have no email identity. They remain securely unlinked until a trusted operator associates them with a real Neon Auth account. Local passwords and sessions are no longer accepted. To provision and link an existing profile:

```sh
npm run auth:link -- --username admin --email REAL_EMAIL --confirm-role global_admin --create
```

The command prompts privately for a new Neon password. Omit `--create` when the email already has a Neon identity, and enter that identity's password. It validates the provider session/JWKS and preserves the existing profile ID and role. Repeat for other existing profiles with their actual email and stored role. Passwords are never passed as command arguments.

New students can use **Créer un compte** at `/register` and enter their name, username, email, password, faculty, Filière and current semester. Their account stays pending on `/account-review` until the global administrator accepts it in **Administration → Demandes d’inscription**. Pending and rejected accounts have no access to community data, chats or files. Existing accounts and accounts created directly by the administrator retain approved access. **Administration → Utilisateurs → Gérer → Supprimer l’étudiant** removes a student’s account access after confirmation and anonymizes their attribution; shared academic resources are preserved.

For an explicitly requested empty demonstration setup, `npm run db:seed -- --demo` uses the existing sample dataset and private R2. These profiles also need explicit identity linking; demo passwords are confined to injected test fixtures.

## Working flows

- Account completion asks for Filière and current semester using the student's already selected faculty. The exact source catalog stays in [shared/studies.js](shared/studies.js).
- Faculty-wide general chat remains shared by all majors. The Community Filière section has three study-year chats: S1/S2, S3/S4 and S5/S6. Students can visit any of those groups inside their own major. Old even-semester links open the corresponding group. Messages, replies, pins, search and live updates enforce this on the backend.
- Upload classification remains Filière → semester → module → resource type → title → file. Modules load from persisted rows and can use an existing user-entered name. No faculty is requested again.
- **Bibliothèque → Partager une ressource → Choisir un dossier** uploads a whole folder, including nested folders. One academic classification applies to the selection; each file keeps an editable title and its original folder path. Progress and per-file results stay visible, and retries send only failed files. **Choisir un fichier** also supports multiple documents when a phone's picker cannot select folders. Each document keeps the existing 20 MB limit and supported formats.
- The academic library keeps its existing faculty scope. A resource's academic semester can differ from its private source chat semester. Inaccessible source chat links are hidden without changing library access.
- The server validates classification, signatures and the 20 MB limit before uploading. Safe UUID object keys and PostgreSQL metadata keep the original filename as metadata only. Exact duplicate bytes return the existing resource.
- Authenticated backend routes stream previews/downloads from the private R2 bucket with permission checks, private caching and safe content headers. No permanent public object URLs are issued.
- Resource replacements preserve IDs and version history. Upload, avatar and replacement failures attempt object cleanup if metadata cannot commit.
- On phones, language/theme stay in Settings and semester selection stays compact inside the existing chat header. Desktop/tablet navigation and faculty panels remain collapsible.
- Message replies remain directly accessible beside the three-dot menu on phones, tablets and desktops. Light-mode message text is readable while the existing dark chat colors are retained. Library categories, study years and member cards have distinct surfaces and accents.
- New reports, contact requests and registration requests show a temporary popup to their authorized administrators while connected. Existing notices and ordinary chat messages stay quiet. Opening the popup selects the matching administration tab; muted administrative notifications still refresh the request queue.
- **Settings → Application** offers installation when the browser supports it, or instructions to add CampusLink to the home screen. Full PWA installation requires HTTPS or localhost; the phone's local HTTP address supports a browser shortcut. The public offline page never stores private messages, account data or academic files.
- Existing search, saved items, calendar, notifications, profile settings, password changes, contacts and scoped administration remain available.

## Verification

```sh
npm test
npm run test:browser
npm run test:r2
npm run test:infrastructure
```

Regression suites use disposable schemas in the configured real PostgreSQL database, with explicitly injected identity/storage fixtures for bounded UI/API checks. Live checks exercise the configured Neon Auth and private R2, then remove their temporary accounts, objects and schema. Browser tests use Chromium; `CAMPUS_CHROMIUM` can point to an installed executable.

See [tests/README.md](tests/README.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [server/README.md](server/README.md) for contracts and validation details.

## Deployment

Keep `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL` and the five `R2_*` variables server-side. Application storage deliberately ignores Neon Object Storage `AWS_*` variables. The existing `neon.ts` bucket configuration is not used for application uploads.

Set `APP_ORIGIN` to the deployed browser origin, allow that origin in Neon Auth, and set `COOKIE_SECURE=true` behind HTTPS. Back up Neon and R2 together. Contact forms persist administrator requests; they do not send email or automatically reset passwords.

## Design assets

Locally hosted DM Sans, Cormorant Garamond and Noto Sans Arabic fonts provide the UI typography. Seed portraits are illustrative Unsplash assets saved locally in `public/avatars/`. `public/favicon.svg` and the brand mark are native SVG drawings.

The campus-inspired image is saved in `public/campus-gateway.png`. It was created with the built-in imagegen tool, following the [imagegen skill](/home/issmail/.codex/skills/.system/imagegen/SKILL.md). It is an illustration of a possible campus atmosphere, not an official photograph of FPT/USMBA. Final generation prompt:

> Use case: photorealistic-natural. Asset type: panoramic hero and small faculty banner for a premium Moroccan university portal. Create a beautiful realistic editorial architectural photograph of a Moroccan university-inspired grand cream sandstone horseshoe arch gateway and symmetrical low academic buildings, viewed at a slight angle, palm trees and cypress trees in a serene manicured courtyard. Late afternoon golden sunlight, amber stone highlights, deep soft shadows. Rich tasteful cinematic palette warm cream, antique champagne gold, subdued olive greenery, charcoal. The gateway occupies center-right, a foreground path leads toward it. Wide landscape 16:9 composition cropped well as banner. Inspired by elegant Moroccan institutional architecture in Taza, without claiming to depict an actual campus. No people, no writing, no signage, no letters, no logos, no watermark. Fine material detail and realistic lens capture, not fantasy or illustration.
