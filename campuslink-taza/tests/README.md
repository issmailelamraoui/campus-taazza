# Validation

`npm test` runs API integration tests in temporary SQLite databases. It verifies actual permissions, session persistence, uploads, deep links, notifications, and cross-faculty isolation.

`npm run test:browser` builds and tests the production bundle with Playwright against an isolated temporary database at port 5174. It runs community, study and administration suites sequentially and cleans up the fixture. The main application database is left unchanged. `CAMPUS_CHROMIUM` can point to an existing Chromium executable.

Screenshots in `../screenshots/` record desktop, mobile and Arabic RTL inspection. They use illustrative local accounts and never publish externally.
