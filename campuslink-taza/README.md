# CampusLink Taza

A working private university community platform using the supplied layout reference with warm ivory/charcoal backgrounds and blue accents adapted from the [official FPT Taza website](https://fpt.usmba.ac.ma/). Dark appearance is the default on new visits; saved light/dark preferences persist and stay synchronized across tabs. Appearance and language live in Settings on phones, with header shortcuts on larger screens. French is the default; English and Arabic translations include proper RTL layouts. The application includes a welcome page, persistent secure login, one-time confirmed faculty selection, a spacious desktop workspace with saved collapsible panels and a hamburger on every screen, accessible mobile/tablet drawers, academic resources, live chat, search, personal saved items, calendar, notifications, settings and scoped administration.

## Run

Requires Node 22.13+ with npm. From this directory:

```sh
npm ci
npm run dev
```

Development: http://localhost:5173. API: http://localhost:3001.

```sh
npm run build
npm start
```

The production build and API are served together at http://localhost:3001. `./start.sh` also builds and starts the application and discovers the existing Node runtime in this workspace environment.

## Local demonstration accounts

| Account | Username | Initial local password | Faculty |
| --- | --- | --- | --- |
| Student | `ismail` | `Campus2026!` | Selected once on first login |
| Global administrator | `admin` | `Admin2026!` | FLAA |
| Student used in isolated tests | `sara` | `Campus2026!` | FLAA |

These are local development fixtures. Set `CAMPUS_STUDENT_PASSWORD` and `CAMPUS_ADMIN_PASSWORD` before the first start to override them. Existing passwords are never overwritten. The UI never displays passwords. Account creation is restricted to the global administrator; there is no public registration route. The first faculty selection requires a confirmation checkbox; further student changes are rejected by the API.

Account completion then asks for the student's Filière and current semester, using the faculty already on the account; it does not ask for the faculty again. The exact requested Filière groups and their existing faculty-ID mapping are in [`shared/studies.js`](shared/studies.js). Existing students without a Filière complete this step rather than receiving a guessed assignment.

## Working flows

- The hamburger toggles the desktop navigation and opens a focus-managed drawer on tablets and phones. Faculty information has its own toggle. Both panels start hidden so conversations have ample width. On phones, open Settings through the hamburger to change language or appearance. Body text is 16–18px with readable 14px metadata and theme-aware colors.

- Academic uploads open a classification dialog before sending. Required fields are Filière, semester, module, resource type, title and file; Filière options come from the account's existing faculty. Types include courses, exams, exercises, TD, TP, corrections, images, PDFs, documents and other resources. Chat and library reference the same resource and stored file. In private Filière chats, the resource's academic `semester` is independent of its source `chat_semester`: a document classified in S4 can be shared in the S5 / S6 group. Ordinary general-chat uploads need no chat semester. SHA-256 detects exact duplicates.
- Chat général is shared by everyone in the account's faculty, regardless of Filière or semester, with the original faculty-wide history available. The separate Chats de filière section has three private conversations: S1 / S2, S3 / S4 and S5 / S6. The pair containing the current semester opens by default; students can switch among the three groups within their own Filière. Private messages, their actions, linked pinned announcements and live updates enforce that Filière scope on the server. Important/help/student-life discussions retain their faculty scope. Authorized pins preserve the original author/date/attachment and link back to the source. Ordinary general and Filière messages do not generate notifications.
- Resource cards open real locally generated PDFs or uploaded files, allow download/save, show metadata and counts, and link to their original discussions. Corrected documents preserve their resource ID and version history.
- Resource and message routes use exact anchors, with temporary highlighting; private chat links use `/app/chat/filiere?semester=1`, `3` or `5` for the three pairs. Refresh preserves the route, session, faculty, Filière and database content. Faculty-shared resource cards show a source-discussion link only when that chat is accessible to the current user.
- Search and Ctrl/Cmd+K query permitted messages, announcements, members, filenames, modules and academic documents. The library and general chat remain faculty-scoped; private Filière chats and their linked announcements are limited to the account's Filière. Semester filters normalize private messages to their pair and keep individual resource semesters. Advanced filters cover type, semester, module, author and date.
- Calendar supports month/day selection, exact event links and `.ics` export. Notification filters and read states persist per user. Reading history powers the home dashboard's Reprendre area.
- Settings support avatar, username, password (requiring the current password), language and notification preferences. Faculty membership is read-only.
- Administration supports private account creation, faculty/role assignment, account suspension, reports, contact requests, announcements, events, channel read-only controls, resource correction, replacement and withdrawal. Faculty administrators and moderators have smaller server-enforced permission scopes.

## Verification

```sh
npm test
npm run test:browser
```

The API suite uses temporary SQLite databases. The Playwright suite builds and serves the actual production bundle at port 5174 against an isolated temporary database, then tests Filière, community, study, administrator, theme and responsive workflows. It does not change the main demo data. Install a Playwright browser with `npx playwright install chromium` if necessary; `CAMPUS_CHROMIUM` can point to an existing executable.

Filière API coverage includes the exact catalog, account setup, shared faculty chat, three private semester pairs, cross-Filière access prevention, upload classification/source-pair separation, live-update scope and migration preserving message IDs and references.

Browser validation includes first visit, translations and RTL, authentication and recovery requests, permanent faculty choice, sessions across refresh, reactions/replies/bookmarks, staged classified uploads, duplicate detection, library/chat deep links, real search, reports, pins/announcements, important-discussion notifications, calendar export, profile edits, permissions, mobile layouts and keyboard navigation.

## Persistence and deployment

SQLite, session hashes and documents live in `data/`, which is ignored by Git. Use a persistent volume and back up the database and document directory together. Configure `APP_ORIGIN` to the exact HTTPS deployment origin and `COOKIE_SECURE=true` behind a TLS reverse proxy. Replace or disable demonstration accounts and provide institution-approved faculty information/materials before admitting real students. The supplied faculty identities follow the user's reference design; all initial course/exam documents are clearly labeled educational demonstrations. Contact requests are stored for administrator review; the application does not send email or reset credentials automatically.

The migration preserves existing accounts and content. Unclassified legacy general messages remain in the faculty-wide general chat. Messages previously tagged with a Filière move to the private Filière channel, with semester pairs normalized to 1, 3 or 5; message/resource IDs, files, replies, pins and source links are retained. Tagged messages with malformed semester data stay private and hidden. Older academic resources remain available in the faculty library. New local fixtures have explicit Filières; the `ismail` fixture still completes account setup.

See [ARCHITECTURE.md](ARCHITECTURE.md) for routes, components, entity contracts and design tokens, and [server/README.md](server/README.md) for the API and security details.

## Design assets

Locally hosted DM Sans, Cormorant Garamond and Noto Sans Arabic fonts provide the UI typography. Seed portraits are illustrative Unsplash assets saved locally in `public/avatars/`. `public/favicon.svg` and the brand mark are native SVG drawings.

The campus-inspired image is saved in `public/campus-gateway.png`. It was created with the built-in imagegen tool, following the [imagegen skill](/home/issmail/.codex/skills/.system/imagegen/SKILL.md). It is an illustration of a possible campus atmosphere, not an official photograph of FPT/USMBA. Final generation prompt:

> Use case: photorealistic-natural. Asset type: panoramic hero and small faculty banner for a premium Moroccan university portal. Create a beautiful realistic editorial architectural photograph of a Moroccan university-inspired grand cream sandstone horseshoe arch gateway and symmetrical low academic buildings, viewed at a slight angle, palm trees and cypress trees in a serene manicured courtyard. Late afternoon golden sunlight, amber stone highlights, deep soft shadows. Rich tasteful cinematic palette warm cream, antique champagne gold, subdued olive greenery, charcoal. The gateway occupies center-right, a foreground path leads toward it. Wide landscape 16:9 composition cropped well as banner. Inspired by elegant Moroccan institutional architecture in Taza, without claiming to depict an actual campus. No people, no writing, no signage, no letters, no logos, no watermark. Fine material detail and realistic lens capture, not fantasy or illustration.
