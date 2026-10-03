# CampusLink API

Run from the project root with Node 22.13 or later. `npm run dev` starts the API on port 3001 and Vite on port 5173. `npm run build && npm start` serves the compiled application and API from port 3001. `npm test` runs isolated integration tests against temporary databases; it does not change the application data.

SQLite, sessions and documents persist under `data/`. The first start generates the sample faculties, accounts, discussions, academic events and real PDF demonstration documents. The PDFs contain short educational examples and are clearly labelled as demonstration materials; they are not official USMBA examination papers. Sample identities illustrate the design. Faculty member counts reflect the actual active assigned accounts.

The initial local development student account is `ismail` / `Campus2026!`. Its faculty is unassigned so the first login demonstrates permanent onboarding. The initial local development global administrator account is `admin` / `Admin2026!`, associated with FLAA. Additional illustrative participants exist for testing permissions. All accounts are password hashed with unique salts. Credentials are documented here for local development and are never displayed in the application UI.

Set `CAMPUS_STUDENT_PASSWORD` and `CAMPUS_ADMIN_PASSWORD` before the first start to override the initial sample credentials. These variables do not overwrite existing passwords. Administrators can provision new private accounts through `POST /api/admin/users`; no public signup route exists. Remove demonstration accounts and change the initial passwords before using the system with real students.

Configuration:

- `PORT`: API port, default 3001.
- `CAMPUS_DATA_DIR`: persistent data directory, default `./data`.
- `APP_ORIGIN`: exact additional allowed browser origin for requests that change data. Configure the deployed HTTPS origin or any preview origin explicitly.
- `COOKIE_SECURE=true`: require secure cookies when TLS terminates at a reverse proxy. Direct HTTPS requests also receive secure cookies automatically.

Session tokens are random, stored as SHA-256 hashes in SQLite, and sent using HttpOnly, SameSite=Lax cookies with 30-day expiration. Logout revokes the session. Password changes require the current password and revoke all previous sessions. Faculty, role and disable changes also revoke affected sessions. SSE updates are restricted by faculty and session and close on logout; private `filiere` updates additionally require the same major. General updates reach all majors of that faculty.

Each protected content query reads the faculty from the authenticated server-side user. Student faculty selection requires explicit confirmation and cannot be changed by a student. Resource download, search, replies, reactions, bookmarks and reports all enforce faculty isolation. Account completion uses `GET /api/studies` and `POST /api/studies` with `filiere_id` and optional `current_semester` (1–6), validating the exact catalog in `shared/studies.js` against the account’s existing faculty. General chat is faculty-wide and needs no major or semester. The separate `filiere` channel has private S1 / S2, S3 / S4 and S5 / S6 conversations; semester inputs normalize to 1, 3 and 5. Students can switch among pairs within their own major, and linked messages, pins, search and actions enforce that scope. Other discussions and the academic library retain faculty scope. The global administrator can manage accounts, reports, contacts and resources across faculties. Faculty administrators can only manage their own faculty and student/moderator accounts. Moderators can process reports, remove chat messages and pin messages into announcements.

Uploads accept valid PDFs, PNG/JPG/WebP/GIF images, text, DOCX/PPTX/XLSX and ODT, up to 20 MB. Executable content and SVG/HTML uploads are rejected. File types are checked against bytes, not the supplied MIME type. SHA-256 detects exact duplicates within the faculty. One upload creates one resource, one physical file and one linked chat message. Upload classification requires `filiere_id`, `semester`, `module`, `resource_type`, `title` and `file`, with an internal library `category`. Filière options come from the account faculty. Only private `filiere` uploads require `chat_semester`, normalized to the source pair; the resource's individual academic semester stays independent. General uploads need no chat semester or account major. Source-discussion IDs are null when the viewer cannot access that chat. Protected file routes never expose disk paths. Admin replacement retains the resource ID and its chat references, stores real version history, and marks the document updated.

The API in `../ARCHITECTURE.md` is implemented. Additional administration endpoints are:

- `POST /api/admin/users` with `username`, `name`, `password`, optional `role` and `faculty_id` (global administrator only).
- `PATCH /api/admin/channels/:id` with `name`, `description`, `read_only` and optional `faculty_id` (global or faculty administrator). Stable channel keys are `general`, `filiere`, `important`, `help` and `life`; a read-only channel accepts publications from moderators and administrators only.
- `PATCH /api/admin/contacts/:id` with `status: open|resolved` and optional `reply`; authenticated contacts receive a notification.
- `POST /api/admin/messages/:id/remove` for chat moderation.
- `PATCH /api/admin/resources/:id` for title/category/semester/module/status correction.
- `POST /api/admin/resources/:id/replace` with one `file` in multipart FormData.
- `DELETE /api/admin/resources/:id` to withdraw a document and its attachment references.

Global announcement and calendar publication accepts optional `faculty_id` as a faculty ID or `all`. Other roles are restricted to their own faculty. Normal general-chat messages do not generate notifications. Academic uploads, important discussions, pinned announcements and calendar publications do, subject to each student's preferences. Contact forms are stored for administrator review; they do not send email or perform automatic credential resets.

The integration suite covers faculty isolation, private-major/semester-pair scope, shared general access, permissions, onboarding, real file streaming, duplicate detection, notifications, pin provenance, preferences, bookmarks, resource versioning, password/session revocation, live SSE boundaries and full application restart persistence.

Additive migrations preserve existing accounts and content without guessing a student’s Filière. Unclassified legacy history remains visible in faculty-wide general chat. Previously tagged general messages move to private `filiere` pairs while retaining IDs, files, replies, pins and linked announcement/resource channels; direct notification links are updated. Tagged malformed semesters remain private and hidden. Reopening the database repeats no changes to already normalized rows. Existing library resources remain available.
