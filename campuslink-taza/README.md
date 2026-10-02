# CampusLink Taza

A working private university community platform inspired by the supplied black/champagne-gold reference. French is the default; English and Arabic translations include proper RTL layouts. The application includes a welcome page, persistent secure login, one-time confirmed faculty selection, a four-column desktop workspace, mobile/tablet drawers, academic resources, live chat, search, personal saved items, calendar, notifications, settings and scoped administration.

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

## Working flows

- Academic uploads open a classification dialog before sending. Category, semester and optional module determine the library location. Chat and library reference the same resource and stored file. SHA-256 detects exact duplicates.
- Chat supports live faculty-scoped SSE updates, reply, reactions, bookmark, report and copy-link actions. Authorized pins create announcements that preserve the original author/date/attachment and link back to the source. General messages do not generate notifications.
- Resource cards open real locally generated PDFs or uploaded files, allow download/save, show metadata and counts, and link to their original discussions. Corrected documents preserve their resource ID and version history.
- Resource and message routes use exact anchors, with temporary highlighting. Refresh preserves the route, session, selected faculty and database content.
- Search and Ctrl/Cmd+K query faculty-scoped messages, announcements, members, filenames, modules and academic documents. Advanced filters cover type, semester, module, author and date.
- Calendar supports month/day selection, exact event links and `.ics` export. Notification filters and read states persist per user. Reading history powers the home dashboard's Reprendre area.
- Settings support avatar, username, password (requiring the current password), language and notification preferences. Faculty membership is read-only.
- Administration supports private account creation, faculty/role assignment, account suspension, reports, contact requests, announcements, events, channel read-only controls, resource correction, replacement and withdrawal. Faculty administrators and moderators have smaller server-enforced permission scopes.

## Verification

```sh
npm test
npm run test:browser
```

The API suite uses temporary SQLite databases. The Playwright suite builds and serves the actual production bundle at port 5174 against an isolated temporary database, then tests community, study and administrator workflows. It does not change the main demo data. Install a Playwright browser with `npx playwright install chromium` if necessary; `CAMPUS_CHROMIUM` can point to an existing executable.

Browser validation includes first visit, translations and RTL, authentication and recovery requests, permanent faculty choice, sessions across refresh, reactions/replies/bookmarks, staged classified uploads, duplicate detection, library/chat deep links, real search, reports, pins/announcements, important-discussion notifications, calendar export, profile edits, permissions, mobile layouts and keyboard navigation.

## Persistence and deployment

SQLite, session hashes and documents live in `data/`, which is ignored by Git. Use a persistent volume and back up the database and document directory together. Configure `APP_ORIGIN` to the exact HTTPS deployment origin and `COOKIE_SECURE=true` behind a TLS reverse proxy. Replace or disable demonstration accounts and provide institution-approved faculty information/materials before admitting real students. The supplied faculty identities follow the user's reference design; all initial course/exam documents are clearly labeled educational demonstrations. Contact requests are stored for administrator review; the application does not send email or reset credentials automatically.

See [ARCHITECTURE.md](ARCHITECTURE.md) for routes, components, entity contracts and design tokens, and [server/README.md](server/README.md) for the API and security details.

## Design assets

Locally hosted DM Sans, Cormorant Garamond and Noto Sans Arabic fonts provide the UI typography. Seed portraits are illustrative Unsplash assets saved locally in `public/avatars/`. `public/favicon.svg` and the brand mark are native SVG drawings.

The campus-inspired image is saved in `public/campus-gateway.png`. It was created with the built-in imagegen tool, following the [imagegen skill](/home/issmail/.codex/skills/.system/imagegen/SKILL.md). It is an illustration of a possible campus atmosphere, not an official photograph of FPT/USMBA. Final generation prompt:

> Use case: photorealistic-natural. Asset type: panoramic hero and small faculty banner for a premium Moroccan university portal. Create a beautiful realistic editorial architectural photograph of a Moroccan university-inspired grand cream sandstone horseshoe arch gateway and symmetrical low academic buildings, viewed at a slight angle, palm trees and cypress trees in a serene manicured courtyard. Late afternoon golden sunlight, amber stone highlights, deep soft shadows. Rich tasteful cinematic palette warm cream, antique champagne gold, subdued olive greenery, charcoal. The gateway occupies center-right, a foreground path leads toward it. Wide landscape 16:9 composition cropped well as banner. Inspired by elegant Moroccan institutional architecture in Taza, without claiming to depict an actual campus. No people, no writing, no signage, no letters, no logos, no watermark. Fine material detail and realistic lens capture, not fantasy or illustration.
