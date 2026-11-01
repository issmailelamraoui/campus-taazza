# Library browsing experience

The academic boundary remains the authenticated faculty and program plus the
selected exact semester. Removed and non-library resources stay excluded.
Canonical module identities, uploader-owned folders, separate document types,
academic-year ordering and the compact document-card fields are unchanged.

## Primary paths

- Start with modules, a compact semester selector and search. Refinements appear
  when opening Filters, a module, the Documents view, or an active search/filter.
- Switch between Modules and Documents. Searching from the overview shows the
  matching documents directly across the selected semester.
- Search matches accents, Arabic vocalization and words in any order across
  document metadata. It does not rename records or merge module identities.
- Searching inside a folder retains its owner and category scope. An explicit
  action widens the search to the whole module while keeping academic filters.
- The module picker opens in a viewport-level portal: a centered dialog on
  desktop and a bottom sheet on phones. Keyboard opening focuses its search;
  Escape returns focus to the trigger. Keyboard module/folder navigation places
  focus at the destination. Enter in document search moves to the results.
- Module choices combine the authenticated `/api/modules` catalogue with visible
  uploaded documents for the exact program and semester. Registered modules
  remain selectable before their first document; no mock curriculum is added.
  Empty modules have no document-sharing action. Catalogue reads are cancelled
  when the account or academic scope changes, with loading and retry states.
  Search and Arrow Up/Down, Home/End support quick selection.
  The background is inert and page scrolling is locked while the dialog is open.
  Tab stays inside it; Escape, Close, and the backdrop return to the trigger.
  The list scrolls internally and fits the visual viewport, including the phone
  keyboard and bottom navigation. Resource-membership changes refresh the
  catalogue, so deleted modules cannot survive in a stale open-page cache.
- All document types remain available in a horizontal, keyboard-scrollable
  strip. Academic year, author, chapter and date live in the Filters panel.
- Empty semesters, empty folders and filtered-out results have different copy
  and recovery actions. Counts inside folders describe their current contents.

## Removing the final file

Deleting the final active resource removes its module record in the same
transaction. This applies to administrative deletion and confirmed report
removal. Active files in chat or legacy files with only a canonical module name
still keep their module. Faculty, program and exact semester stay isolated.
Removed file metadata, versions and moderation evidence retain their existing
history; only the obsolete module link is detached. Uploads and removals share a
module identity lock so a simultaneous new upload cannot lose its folder.

Catalogue reads hide historical modules whose files were all removed without
writing to the database. Never-used catalogue entries remain valid. A new upload
after a completed removal can create the module again with a fresh identity.

## URL and history

`view=documents` explicitly chooses document overview; otherwise modules are the
default. A nonempty `q` temporarily displays documents without adding a view
parameter. Clearing it restores the chosen view.

`documentsPage` is one-based, omitted for page one, and limited to the available
24-document pages. Filter/scope/sort changes reset it; reload and browser
Back/Forward restore it. The independent PDF reader's `page` parameter is never
used for library pagination. Automatic folder/page correction preserves a
`#resource-ID` link and scrolls the target into view.

Date values are limited to `7`, `30`, and `90`; invalid values are removed rather
than silently hiding the library. Clearing filters preserves the module and
sort, as before. PDF full-text search remains independent of academic filters.

## Verification

```sh
node --test tests/library-browse.test.mjs tests/resource-folders.test.mjs tests/resources.test.mjs
node tests/library-ux.browser.mjs
node tests/library-browse-clarity.browser.mjs
node tests/library-type-separation.browser.mjs
node tests/library-module-catalog.browser.mjs
node --test tests/backend-module-pruning.test.mjs tests/backend-module-folders.test.mjs
```

Browser scenarios intercept account, document and upload APIs; they do not alter
real users, files or private sessions. Use `CAMPUSLINK_TEST_URL` for a frontend
other than `http://127.0.0.1:5180`.
