# Validation

`npm test` runs API integration tests in temporary SQLite databases. It verifies actual permissions, session persistence, uploads, deep links, notifications, and cross-faculty isolation.

`npm run test:browser` builds and tests the production bundle with Playwright against an isolated temporary database at port 5174. It runs filière, community, study, administration, appearance and responsive suites sequentially and cleans up the fixture. The main application database is left unchanged. `CAMPUS_CHROMIUM` can point to an existing Chromium executable. Use `CAMPUS_BROWSER_SUITES=filiere` to run the new account and chat flow on its own.

The filière suite provisions accounts whose faculties are already assigned, checks the exact four supplied major catalogs, and verifies setup never asks for the faculty again. General chat remains faculty-wide with no semester selector and preserves original history and resource links. The separate private Filière channel has three independent groups: S1/S2, S3/S4 and S5/S6. Tests exercise shared messages within a pair, canonical even-semester URLs, current-pair defaults, foreign-Filière privacy, home/saved announcement origins and earlier general deep links. Upload classification keeps the resource's academic semester independent of its private source pair; general uploads require no chat semester. Phone selectors stay inside the header, and tablet/desktop tabs and Arabic RTL remain covered. API integration tests separately verify migration of previous-model data without changing message/resource IDs.

The responsive suite checks phone, tablet and desktop headers at 390, 768, 1024, 1280 and 1440 pixels; navigation collapse increases the chat area, keyboard drawers trap focus and restore it on Escape, and phone Settings exposes language and appearance controls. It measures actual text contrast and size in both themes and verifies persistent preferences and Arabic RTL.

Screenshots in `../screenshots/` record desktop, mobile and Arabic RTL inspection. They use illustrative local accounts and never publish externally.

The responsive suite checks phone/tablet/desktop layouts at 390, 768, 1024, 1280 and 1440px, header geometry, light/dark text contrast, readable sizes, saved collapsible panels, keyboard focus in drawers, relocated mobile settings and Arabic RTL.
