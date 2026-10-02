# CampusLink Taza

React + React Router + Vite. Express API on port 3001. Node 22 SQLite, cryptographic password hashing, opaque persistent cookie sessions. Frontend development on port 5173; production API serves the built SPA. All university content is isolated by the faculty read from the authenticated server-side user, never a client-supplied faculty. Local persistent storage in data/ (ignored).

## Shared frontend contract

`useApp()` from `src/context.jsx`: `{ user, data, loading, error, refresh, login, logout, t, lang, setLang, toast, openModal, closeModal, saved, toggleSave }`.
`data`: `{ faculty, messages, resources, announcements, notifications, members, events, saved, history }` from GET /api/bootstrap.
`api(path, options)` from `src/api.js`: JSON request with same-origin cookies; throws an Error with server message. Path is relative to /api. For FormData omit content-type.
`ResourceCard`, `EmptyState`, `Avatar`, `PageHeading`, `CategoryIcon`, `Badge` from `src/components/ui.jsx`.
`resourcePath(resource)` and `messagePath(message)` from `src/utils.js`.
`useApp.openModal(type,payload)` supports contact, upload, report, preview, search.

## API contract

GET /api/session -> `{ user }` (null allowed). POST /api/login `{ username,password }` -> `{ user }`. POST /api/logout.
GET /api/faculties -> `{ faculties }` only before faculty assignment (global admins also allowed). POST /api/faculty `{ faculty_id, confirmed:true }` -> `{ user }`, assignment once only.
GET /api/bootstrap -> all data in user's faculty, including saved personal IDs and history.
GET /api/events/stream SSE broadcasts `update` (frontend refreshes).
POST /api/messages `{ content, channel:'general'|'important'|'help'|'life', reply_to? }`.
POST /api/messages/:id/reaction `{ reaction:'like'|'heart' }` toggles current user's reaction. POST /api/messages/:id/pin authorized roles only, creates linked announcement.
POST /api/uploads FormData: `file,title,category:'courses'|'exercises'|'exams'|'rattrapage'|'general',semester:1..6,module,channel,content,reply_to?`; file stored once, message references resource. Duplicate returns 409 with existing resource.
GET /api/files/:resourceId?download=1 auth-scoped file streaming; records counts/history.
POST /api/saved `{ type:'resource'|'message'|'announcement', id }` toggles. POST /api/notifications/read `{ ids?:[] }` (omitting ids marks all).
POST /api/reports `{ target_type,target_id,reason,details }`. POST /api/contact `{ name?,email?,subject,message }` allows credential recovery unauthenticated and faculty-bound contact authenticated.
PATCH /api/profile `{ username?,avatar?,language?,preferences?,current_password?,password? }` never accepts faculty or role. Avatar data URL permitted with limits.
GET /api/search?q=...&type=...&semester=...&module=...&author=...&date=... -> `{ results:[{ id,type,title,context,path,author,semester,module,date }] }` scopes by faculty.
GET /api/admin -> roles scoped reports/users/contacts. PATCH /api/admin/users/:id `{faculty_id?,role?,disabled?}` role gated. PATCH /api/admin/reports/:id `{ status }`. POST /api/admin/announcements `{content}`. POST /api/admin/events `{title,date,time,type}`.

## Entity shapes

User: `{id,username,name,avatar,role,faculty_id,language,preferences}`. Roles `global_admin,faculty_admin,moderator,student`.
Faculty: `{id,code,name,arabic,description,icon,color,members,online}`. Use reference's four identities, with clear illustrative seed content.
Message: `{id,faculty_id,channel,content,author:{id,name,username,avatar,role},created_at,resource_id,reply_to,pinned,reactions:{like:number,heart:number},my_reactions:[]}`.
Resource: `{id,faculty_id,title,filename,category,semester,module,author:{...},created_at,size,mime,downloads,views,message_id,channel,status,version}`.
Announcement: `{id,content,message_id,channel,author:{...},created_at,resource_id,pinned}`.
Notification: `{id,type,title,body,path,created_at,read}` type resources/announcements/important/admin/calendar.
Event: `{id,title,date,time,type}`. Saved `{type,id}`. History `{resource_id,opened_at}`.

## Routes

/ landing; /login; /onboarding/faculty; /app home; /app/chat/:channel; /app/announcements; /app/resources/:category?/:semester?/:module?; /app/calendar; /app/notifications; /app/saved; /app/members; /app/about; /app/profile; /app/settings; /app/search; /app/admin. Anchors resource-ID, message-ID, announcement-ID. Route guards enforce login and permanent faculty onboarding; API guards enforce actual permissions.

## Visual tokens

Black #080808; panels #101011 / #151515; text #f2eee7; muted #97948c; champagne #e6c487; border #292722; display Cormorant Garamond, sans DM Sans, Arabic Noto Sans Arabic. 76px header; four columns 190px / 230px / minmax(0,1fr) / 300px. Responsive drawers at tablet/mobile. Restrained violet/green/gold/rose category accents.
