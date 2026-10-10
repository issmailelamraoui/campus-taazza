import { getFiliere, getChatSemester } from '../data/studies.js';
import { normalizePart } from './resources.js';

const id = value => value === null || value === undefined ? null : String(value);
export const ADMIN_ROLES = ['global_admin', 'faculty_admin', 'moderator'];
export const isAdministrator = user => ADMIN_ROLES.includes(user?.role);
export function normalizeUser(raw) {
  if (!raw) return null;
  return { ...raw, id: id(raw.id), facultyId: raw.faculty_id, filiereId: raw.filiere_id,
    semester: Number(raw.current_semester) || 1, bio: raw.bio || '', avatar: raw.avatar || '',
    accountStatus: raw.account_status || 'approved', chatBlocked: Boolean(raw.chat_blocked), disabled: Boolean(raw.disabled) };
}
export function chatRequest(channel) {
  const year = /^year-([135])$/.exec(channel || '');
  return year ? { channel: 'filiere', semester: Number(year[1]) } : { channel: channel || 'general' };
}
export function normalizeResource(raw) {
  const filename = raw.filename || raw.originalName || raw.title || '';
  const fileType = filename.includes('.') ? filename.split('.').pop().toUpperCase() : String(raw.mime || '').includes('pdf') ? 'PDF' : 'FILE';
  const category = ['td', 'tp'].includes(raw.resource_type) ? raw.resource_type : ['correction', 'corrections'].includes(raw.resource_type) ? 'corrections' : raw.category;
  const bytes = Number(raw.size) || 0;
  return { ...raw, id: id(raw.id), facultyId: raw.faculty_id, filiereId: raw.filiere_id,
    filiereName: getFiliere(raw.filiere_id)?.name || raw.filiere_id, semester: Number(raw.semester), category,
    part: normalizePart(raw.part_number ?? raw.part ?? 'complete'), author: raw.teacher_name || '',
    uploader: raw.author?.name || raw.uploader || '', originalName: filename, name: filename,
    date: raw.created_at || raw.date || '', sizeBytes: bytes,
    size: bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} Ko` : `${(bytes / (1024 * 1024)).toFixed(1)} Mo`,
    fileType, path: raw.relative_path || filename, url: `/api/files/${raw.id}`, downloadUrl: `/api/files/${raw.id}?download=1`,
    localOnly: false, sample: false, messageId: id(raw.message_id), libraryVisible: raw.library_visible !== false };
}
export function normalizeMessage(raw, resources = []) {
  const author = typeof raw.author === 'object' ? raw.author : { name: raw.author, id: raw.author_id, username: raw.username };
  let attachments = (raw.attachments || []).map(normalizeResource);
  const resource = resources.find(item => item.id === id(raw.resource_id));
  if (!attachments.length && resource) attachments = [resource];
  const semester = getChatSemester(raw.semester);
  return { ...raw, id: id(raw.id), facultyId: raw.faculty_id, filiereId: raw.filiere_id,
    channel: raw.channel === 'filiere' ? `year-${semester || 1}` : raw.channel,
    date: raw.created_at || raw.date || '', author: author?.name || 'Utilisateur', authorId: id(author?.id),
    username: author?.username || '', avatar: author?.avatar || '', replyTo: id(raw.reply_to),
    pinned: Boolean(raw.pinned), reactions: Object.fromEntries(Object.entries(raw.reactions || {}).map(([key, value]) => [key, Number(value) || 0])),
    myReactions: raw.my_reactions || [], attachments, attachment: null, deleted: Boolean(raw.removed) };
}
export function normalizeAnnouncement(raw) {
  return { ...raw, id: id(raw.id), facultyId: raw.faculty_id, filiereId: raw.filiere_id,
    title: raw.title || String(raw.content || '').split('\n')[0].slice(0, 140), content: raw.content || '',
    author: raw.author?.name || raw.author || 'Administration', date: raw.created_at || raw.date || '',
    resourceId: id(raw.resource_id), messageId: id(raw.message_id),
    channel: raw.channel === 'filiere' ? `year-${getChatSemester(raw.semester) || 1}` : raw.channel,
    kind: raw.kind && raw.kind !== 'announcement' ? raw.kind : raw.message_id ? 'community' : raw.resource_id ? 'resources' : 'administration', pinned: Boolean(raw.pinned) };
}
export function clientPath(path, resources = []) {
  const raw = String(path || '');
  if (raw.includes('/calendar')) return '/app/announcements';
  const message = /#message-(\d+)/.exec(raw);
  if (raw.includes('/chat/')) {
    const channel = /\/chat\/([^?#/]+)/.exec(raw)?.[1] || 'general';
    const year = getChatSemester(new URLSearchParams(raw.split('?')[1]?.split('#')[0]).get('semester')) || 1;
    return `/app/community?channel=${channel === 'filiere' ? `year-${year}` : channel}${message ? `&message=${message[1]}` : ''}`;
  }
  const document = /#resource-(\d+)/.exec(raw);
  if (raw.includes('/resources/')) {
    const resource = resources.find(item => item.id === document?.[1]);
    const query = new URLSearchParams(resource ? { semester: resource.semester, category: resource.category, module: resource.module } : {});
    return `/app/library${query.size ? `?${query}` : ''}${document ? `#resource-${document[1]}` : ''}`;
  }
  if (raw.includes('/admin')) return raw.replace('tab=contacts', 'tab=assistance').replace('tab=registrations', 'tab=accounts');
  return raw || '/app';
}
export function normalizeBootstrap(raw) {
  const resources = (raw.resources || []).map(normalizeResource);
  const user = normalizeUser(raw.user);
  const hiddenMessages = new Set((raw.messages || []).filter(item => ['help','life'].includes(item.channel)).map(item => id(item.id)));
  return { ...raw, user, resources,
    messages: (raw.messages || []).filter(item => !['help','life'].includes(item.channel)).map(item => normalizeMessage(item, resources)),
    announcements: (raw.announcements || []).filter(item => !['help','life'].includes(item.channel) && !hiddenMessages.has(id(item.message_id))).map(normalizeAnnouncement),
    notifications: (raw.notifications || []).filter(item => item.type !== 'calendar' && !String(item.path || '').includes('/calendar')).map(item => {
      const target = /#(?:resource|announcement|message|event)-(\d+)/.exec(item.path || '');
      const type = { resources: 'document', announcements: 'announcement', important: 'discussion', admin: 'administration', mentions: 'mention', calendar: 'calendar' }[item.type] || item.type;
      const href = clientPath(item.path, resources);
      return { ...item, id: id(item.id), type, date: item.created_at, description: item.body || item.description || '', read: Boolean(item.read), href, path: href,
        facultyId: user?.facultyId, targetId: target?.[1], channel: new URLSearchParams(href.split('?')[1]).get('channel') };
    }),
    saved: (raw.saved || []).map(item => ({ ...item, type: { resource: 'document', message: 'discussion' }[item.type] || item.type, id: id(item.id) })),
    history: (raw.history || []).map(item => id(item.resource_id)),
    events: [],
    channels: (raw.channels || []).filter(item => !['help','life'].includes(item.id)),
  };
}
