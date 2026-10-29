# Library hierarchy and official module catalog

The library uses this browsing order within the authenticated academic scope:

**Faculty → Filière → Semester → Canonical module → Category → Contributor → Files**

Existing faculty, program, semester visibility and ownership rules remain
authoritative. Browsing another contributor’s accessible material grants no
edit, deletion or upload rights over their records.

## Browsing and category isolation

- The semester overview shows module cards. Opening a module shows category
  cards; opening a category shows its contributor folders. Documents appear
  after entering a contributor folder. Cards show the module name; the original filename is preserved for downloads and accessible document labels.
- Browse folders exist only while they contain accessible files. Moving the
  last file to another semester, removing it, or changing its visibility removes
  the old virtual folder immediately. Empty official catalog entries remain
  available to the upload selector and do not appear as zero-file browse cards.
- Standard categories are Cours, Exercices, TD, TP, Corrections, Examens and
  Rattrapage. Existing additional categories remain browsable. Legacy TD/TP
  remains separate; its documents are never guessed into TD or TP. Missing
  metadata appears under the unclassified category.
- `shared/resource-categories.js` is the common classifier. Precise TD, TP and
  correction resource types take precedence over older broad category labels.
  Known French/English aliases collapse into one category label.
- Each virtual contributor folder uses the actual uploader user ID. Equal
  public names or usernames do not combine students. Counts include only
  accessible library resources in the current faculty, program, semester,
  canonical module ID and category.
- Accessible historical records without an uploader ID remain in a translated
  **Unknown contributor** bucket. The reserved `unknown` navigation token is
  not a user ID and grants no ownership or management privilege.
- Uploaded folder paths remain inside the selected contributor and category.
  Reusing the same path in another category or account cannot expose those
  files. No stored object is copied, renamed or moved to create these views.
- Search and author/chapter/year/date refinements retain the current category
  and contributor. Clearing filters preserves this navigation. The semester
  overview search returns matching module cards rather than bypassing the
  category and contributor levels.
- PDF text search and the indexing picker use only the current contributor and
  category resources. The server applies `resource_ids` before its candidate
  limit and continues to check each result’s existing access rules.
- Module and resource reads have loading, empty, error and retry states. Live
  resource changes refresh module contents and the catalog, so removed or
  inaccessible files stop contributing to folder counts.
- The module picker retains its responsive dialog/bottom-sheet presentation,
  keyboard navigation, focus trap and Escape dismissal. Category/contributor
  cards provide keyboard focus and touch targets. Breadcrumbs retain the
  selected path across previews and browser Back/Forward.

## Canonical identities and URL state

Example:

```text
/app/library?semester=5&module=id%3A12&category=tp&contributor=42&folder=TP%2FSemaine%201
```

| Parameter | Meaning |
| --- | --- |
| `semester` | Exact selected semester, 1–6. |
| `module=id:12` | Canonical module ID. Duplicate labels remain separate IDs. |
| `module=legacy:label` | Preserved resource group without a canonical module ID. |
| `category` | Canonical category; omitted at the module’s category overview. |
| `contributor` | Actual uploader ID, or reserved `unknown` for ownerless history. |
| `folder` | Existing relative directory inside that category/contributor. |
| `q`, `author`, `part`, `date`, `year`, `sort` | Search/refinements within the current navigation scope. |
| `documentsPage` | One-based library pagination, omitted for the first 24-document page. |

Old name-based module URLs resolve only when one module folder matches in the
exact academic scope. Names do not merge different module IDs. Historical
`folderOwner` is read for compatibility; new navigation writes `contributor`.
Old `view=documents` URLs no longer bypass the mandatory hierarchy. Shared
module references carry canonical IDs when available; older snapshots retain
their label without inventing an association.

The PDF reader’s `page` parameter remains independent of `documentsPage`.
Resource deep links reveal the appropriate category, contributor, relative path
and library page while retaining the target hash. Date values remain limited to
`7`, `30` and `90`. New module/semester/category navigation clears child folders.

## Server contracts

| Endpoint | Contract |
| --- | --- |
| `GET /api/modules?faculty_id=…&filiere_id=…&semester=…` | Authorized scoped catalog, including empty/history modules. Add `official=1` for upload choices. |
| `GET /api/library/modules/:id` | Authorized library resources in the module’s exact academic scope, plus category counts/contributor groups. Optional `category` and `uploader_id` restrict resources; `uploader_id=unknown` selects ownerless history. |
| `POST /api/admin/modules` | Authorized creation with scope, official name, `curriculum_source` and `confirmed: true`. |
| `PATCH /api/admin/modules/:id` | Authorized verification/status update with source/confirmation; does not rename or reassign history. |
| `POST /api/uploads` | Existing workflow plus required selected official `module_id`; scope/status validate before storage. Client labels cannot create modules. |
| `GET /api/document-search?q=…&resource_ids=…` | Search supplied accessible IDs when present; an empty list does not widen to global search. |

Module DTOs expose `id`, `name`, `faculty_id`, `filiere_id`, `semester`,
`catalog_status` and `curriculum_source`. Resource DTOs retain `module_id` and
expose `category_key` and `uploader_id`; frontend normalization maps these to
`moduleId`, `category` and `uploaderId`. File actions retain existing server-side
ownership and administrative/authorized XP-leader checks.

## Establishing the official curriculum

Migration `039_official_module_catalog.sql` adds status, normalized keys,
verification provenance and scoped uniqueness for verified names. Existing
modules start as `legacy`; historical uploads do not constitute a verified
university curriculum. The migration does not delete modules or change resource
associations. Production application is a separate release operation; this
implementation does not apply it remotely.

An authorized administrator opens **Administration → Modules officiels**, selects
the faculty, program and semester, and verifies entries against an actual
official curriculum. They record a precise link or source reference and confirm
the scope. Missing official entries can be added from the same verified source.
Module counts come from that curriculum, never a hardcoded assumption.

Students search the official selector and explicitly choose a suggestion. Case,
accents and whitespace normalize for search; `analyse nimeriqe` can suggest
`Analyse numérique`. Suggestions never select, create or merge automatically.
Numeric distinctions such as Analyse 1 and Analyse 4 remain meaningful. Typing
after a choice clears its confirmed ID.

If no entries are verified for a semester, new uploads remain blocked until an
administrator verifies its catalog; existing material remains browsable. The
missing-module link uses the existing feedback workflow for manual review.
There is no separate module-request queue or automatic approval. Normalized
duplicates are rejected; any consolidation needs separate investigation and
explicit approval.

## Deletion and data preservation

Removing the last file no longer prunes its academic module or clears the
soft-deleted resource’s historical module ID. An empty module is not evidence
that it is invalid. Catalog reads do not delete or hide rows merely because
their last active file was removed. Uploads cannot recreate arbitrary names
with fresh module identities.

Cleanup and consolidation remain separate from browsing/catalog verification.
The Neon audit is read-only. Future merges or test-data cleanup require a
reviewed dependency report, dry run, rollback/recovery plan and explicit
authorization. Resource IDs, ownership, categories, years, nested paths,
discussions, notifications and R2 keys must be preserved.

## Verification and historical test limitations

```sh
npm run test:library-contributors-unit
npm run test:library-catalog
npm run test:library-contributors
npm run build
```

Database suites require `CAMPUS_TEST_DATABASE_URL` pointing to an explicit
disposable local PostgreSQL database. The contributor browser suite starts its
own API/Vite server on loopback, uses synthetic local accounts, injected storage
and a disposable schema. It does not use real student files or mutate Neon/R2.
Its synthetic fixture curriculum does not verify a production academic catalog.

The contributor browser suite covers category/contributor navigation, nested
uploads, peer permissions, preview return state, explicit fuzzy selection and
responsive French/English/Arabic RTL and dark/light combinations.

Older browser suites retain historical assumptions and are not current
acceptance evidence until their fixtures and assertions are migrated:

| Historical suite | Stale expectations |
| --- | --- |
| `library-ux.browser.mjs`, `library-browse-clarity.browser.mjs` | Direct Documents overview/search results and module-name/`folderOwner` URLs. |
| `library-phase1.browser.mjs`, `library-type-separation.browser.mjs` | Module opens physical folders directly; username-based owners; no contributor step. |
| `library-clarity.browser.mjs` | Category tabs before selecting a module and unrestricted typed upload modules. |
| `module-library-upload.browser.mjs`, `library-academic.browser.mjs` | Free-text names create modules; module opening immediately renders documents. |
| `library-module-catalog.browser.mjs`, `library-module-responsive.browser.mjs` | Fixtures lack official status/module-resource responses and assume immediate document navigation. |

These suites were identified rather than broadly rewritten to preserve their
historical regression evidence. Unit tests for canonical merging, category
isolation, user-ID folders and shared references use the new contracts.
