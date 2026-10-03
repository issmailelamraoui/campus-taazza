# CampusLink Taza

React + React Router + Vite. Express API on port 3001. Node 22 SQLite, cryptographic password hashing, opaque persistent cookie sessions. Frontend development on port 5173; production API serves the built SPA. General chat uses the authenticated account's faculty. The separate private Filière channel uses the account's major plus one of three semester pairs. Local persistent storage in data/ (ignored).

## Shared frontend contract

`useApp()` from `src/context.jsx`: `{ user, data, loading, error, refresh, login, logout, t, lang, setLang, theme, toggleTheme, toast, openModal, closeModal, saved, toggleSave }`.
`data`: `{ user, faculty, filieres, messages, resources, announcements, notifications, members, events, saved, history }` from GET /api/bootstrap.
`api(path, options)` from `src/api.js`: JSON request with same-origin cookies; throws an Error with server message. Path is relative to /api. For FormData omit content-type.
`ResourceCard`, `EmptyState`, `Avatar`, `PageHeading`, `CategoryIcon`, `Badge` from `src/components/ui.jsx`.
`resourcePath(resource)` and `messagePath(message)` from `src/utils.js`.
`useApp.openModal(type,payload)` supports contact, upload, report, preview, search.

`shared/studies.js` exports the exact requested Filière labels mapped to the existing faculty IDs: `FILIERES_BY_FACULTY`, `getFilieres(facultyId)`, `getFiliere(id)` and `filiereBelongsToFaculty(facultyId,id)`. Both account completion and uploads use this catalog; neither asks for an already assigned faculty. `SEMESTER_CHAT_GROUPS` defines S1 / S2, S3 / S4 and S5 / S6. `getChatSemester(value)` normalizes 1–6 to pair starts 1, 3 or 5 and returns null for invalid input.

## API contract

GET /api/session -> `{ user }` (null allowed). POST /api/login `{ username,password }` -> `{ user }`. POST /api/logout.
GET /api/faculties -> `{ faculties }` only before faculty assignment (global admins also allowed). POST /api/faculty `{ faculty_id, confirmed:true }` -> `{ user }`, assignment once only.
GET /api/studies -> `{ filieres,user }` for the existing account faculty. POST /api/studies `{ filiere_id,current_semester?:1..6 }` -> `{ user }`; validates against that faculty and defaults the current semester to 1.
GET /api/bootstrap -> faculty data, including saved personal IDs and history; private Filière messages and linked announcements are filtered to the account's major. General history is faculty-wide. The client displays the three accessible private pairs separately.
GET /api/events/stream SSE broadcasts `update` (frontend refreshes); general changes reach the faculty, while private Filière changes target the same major.
GET /api/messages -> faculty-wide general chat without a major or semester requirement. GET /api/messages?channel=filiere&semester=2 -> the account's private S1 / S2 chat. GET /api/messages/:id applies the source channel's scope.
POST /api/messages `{ content, channel:'general'|'filiere'|'important'|'help'|'life', semester?:1..6, reply_to? }`. Only `filiere` requires a major and semester: major comes from the account and semester normalizes to 1, 3 or 5. General messages store null Filière/semester. Replies stay in the same channel and, for private Filière chats, the same pair. Other channels retain faculty scope.
POST /api/messages/:id/reaction `{ reaction:'like'|'heart' }` toggles current user's reaction. POST /api/messages/:id/pin authorized roles only, creates linked announcement.
POST /api/uploads FormData: required `file,title,filiere_id,semester:1..6,module,resource_type,category:'courses'|'exercises'|'exams'|'rattrapage'|'general'`; optional `channel,content,reply_to`. Private `filiere` uploads also require `chat_semester:1..6`, normalized to a pair start. Ordinary general uploads need no chat semester or account major. Resource Filière options must belong to the account faculty; private messages use the author's own major. Resource `semester` remains individual and independent of the source pair. Canonical UI resource types are `courses,exercises,exams,rattrapage,td,tp,correction,image,pdf,document,other`. The file is stored once and the message references the resource. Duplicate returns 409 with the existing resource.
GET /api/files/:resourceId?download=1 auth-scoped file streaming; records counts/history.
POST /api/saved `{ type:'resource'|'message'|'announcement', id }` toggles. POST /api/notifications/read `{ ids?:[] }` (omitting ids marks all).
POST /api/reports `{ target_type,target_id,reason,details }`. POST /api/contact `{ name?,email?,subject,message }` allows credential recovery unauthenticated and faculty-bound contact authenticated.
PATCH /api/profile `{ username?,avatar?,language?,preferences?,current_password?,password? }` never accepts faculty or role. Avatar data URL permitted with limits.
GET /api/search?q=...&type=...&semester=...&module=...&author=...&date=... -> `{ results:[{ id,type,title,context,path,author,semester,module,date }] }` scopes by faculty and additionally filters private messages/linked announcements by the account Filière. Semester filters normalize private message pairs; resource semesters remain individual.
GET /api/admin -> roles scoped reports/users/contacts. PATCH /api/admin/users/:id `{faculty_id?,role?,disabled?}` role gated. PATCH /api/admin/reports/:id `{ status }`. POST /api/admin/announcements `{content}`. POST /api/admin/events `{title,date,time,type}`.

## Entity shapes

User: `{id,username,name,avatar,role,faculty_id,filiere_id,current_semester,language,preferences}`. Roles `global_admin,faculty_admin,moderator,student`.
Faculty: `{id,code,name,arabic,description,icon,color,members,online,chat_online}`. `chat_online` counts online users of the viewer's Filière across all semesters; ordinary faculty member counts are unchanged. Use reference's four identities, with clear illustrative seed content.
Message: `{id,faculty_id,filiere_id,semester,channel,content,author:{id,name,username,avatar,role},created_at,resource_id,reply_to,pinned,reactions:{like:number,heart:number},my_reactions:[]}`. General identity is faculty-only; private `filiere` identity is the account's major plus pair start 1, 3 or 5.
Resource: `{id,faculty_id,filiere_id,title,filename,category,resource_type,semester,module,author:{...},created_at,size,mime,downloads,views,message_id,chat_semester,channel,status,version}`. Library visibility stays faculty-scoped. For a source chat the viewer cannot access, `message_id` and `chat_semester` are null.
Announcement: `{id,content,message_id,channel,filiere_id,semester,author:{...},created_at,resource_id,pinned}`. Source Filière/semester are derived from the original message.
Notification: `{id,type,title,body,path,created_at,read}` type resources/announcements/important/admin/calendar.
Event: `{id,title,date,time,type}`. Saved `{type,id}`. History `{resource_id,opened_at}`.

## Routes

/ landing; /login; /onboarding/faculty; /onboarding/studies; /app home; /app/chat/:channel; /app/announcements; /app/resources/:category?/:semester?/:module?; /app/calendar; /app/notifications; /app/saved; /app/members; /app/about; /app/profile; /app/settings; /app/search; /app/admin. General chat uses `/app/chat/general`. Private chats use `/app/chat/filiere?semester=1`, `3` or `5` and default to the pair containing the user's current semester. Anchors resource-ID, message-ID, announcement-ID. Account completion uses an already assigned faculty to show the correct Filières; administrative users can continue to administration before choosing their personal chat Filière. API guards enforce the actual faculty and chat permissions.

## Migration

Additive SQLite migrations introduce nullable `filiere_id` on users/messages/resources, `current_semester` on users, `semester` on messages and `resource_type` on resources. They do not guess a major for existing students. The paired-chat migration moves every general message with a nonempty major to `filiere`, normalizes valid semesters, and preserves IDs, attachment files, replies and pins. Linked resource/announcement channels and message notification paths follow the moved source. Malformed tagged messages stay private and hidden. Unclassified legacy history stays in the faculty-wide general chat. The migration is idempotent. Reassigning a faculty resets an incompatible account Filière and revokes sessions as before.

## Visual tokens

USMBA/FPT Taza inspired light palette: warm neutral background #f6f4ef; panels #fffefa / #eeece6; text #282721; muted #68645d; primary #2e529a, deep blue #174579 and action blue #16608b; border #dcd8cf; display Cormorant Garamond, sans DM Sans, Arabic Noto Sans Arabic. Adaptive 72–80px header; the main workspace expands to the viewport by default. At >=1280px optional 420px navigation and faculty panels toggle inline with per-browser persistence; below that width the hamburger and faculty toggle open accessible modal drawers. Phones place language and appearance in Settings. Shared body text is 16–18px, metadata 14px. Restrained violet/green/blue/rose category accents. Dark appearance uses warm charcoal #151412 / #1d1b18, with the same blue actions and faculty/category accents.
