// Keep server snapshots separate from local actions so refreshes cannot erase
// a pending action, and a failed action only rolls back its own change.
export class OptimisticState {
  constructor(publish) { this.base = null; this.operations = new Map(); this.publish = publish; }
  project() {
    let data = this.base;
    if (data) for (const apply of this.operations.values()) data = apply(data);
    return data;
  }
  emit() { this.publish(this.project()); }
  replace(data) { this.base = data; this.emit(); }
  put(key, apply) { this.operations.set(key, apply); this.emit(); }
  remove(key) { this.operations.delete(key); this.emit(); }
  confirm(key, commit) {
    if (this.base && commit) this.base = commit(this.base);
    this.operations.delete(key); this.emit();
  }
  reset() { this.operations.clear(); this.base = null; this.emit(); }
}

export const updateMessage = (data, id, update) => ({ ...data, messages: data.messages.map(m => m.id === id ? update(m) : m) });

const canShowMessage = (data, message) => (!data.user?.account_status || data.user.account_status === 'approved') && !data.user?.chat_blocked && (!data.user?.faculty_id || data.user.faculty_id === message.faculty_id) && (message.channel !== 'filiere' || data.user?.filiere_id === message.filiere_id);

export function putMessage(data, message) {
  if (!canShowMessage(data, message)) return data;
  const messages = data.messages.filter(m => m.id !== message.id && (!message.client_id || m.client_id !== message.client_id || m.author?.id !== message.author?.id));
  return { ...data, messages: [...messages, message].sort((a, b) => a.created_at.localeCompare(b.created_at)) };
}

export function pendingMessage(data, draft) {
  if (!canShowMessage(data, draft) || data.messages.some(m => m.client_id === draft.client_id && m.author?.id === draft.author?.id)) return data;
  return putMessage(data, draft);
}

export function removeMessage(data, id) {
  const announcements = data.announcements.filter(a => a.message_id === id);
  return {
    ...data,
    messages: data.messages.filter(m => m.id !== id).map(m => m.reply_to === id ? { ...m, reply_to: null } : m),
    announcements: data.announcements.filter(a => a.message_id !== id),
    resources: data.resources.map(r => r.message_id === id ? { ...r, message_id: null } : r),
    saved: data.saved.filter(s => !(s.type === 'message' && s.id === id) && !(s.type === 'announcement' && announcements.some(a => a.id === s.id))),
    notifications: data.notifications.filter(n => !n.path?.endsWith(`#message-${id}`) && !announcements.some(a => n.path?.endsWith(`#announcement-${a.id}`))),
  };
}

export function setPinned(data, message, pinned, announcement) {
  if (!canShowMessage(data, message) || !data.messages.some(m => m.id === message.id)) return data;
  const next = updateMessage(data, message.id, m => ({ ...m, pinned }));
  const existing = data.announcements.find(a => a.message_id === message.id);
  const announcements = data.announcements.filter(a => a.message_id !== message.id);
  if (pinned) announcements.unshift(announcement || existing || { ...message, id: `pending-pin-${message.id}`, message_id: message.id, pinned: true, _status: 'pending' });
  return { ...next, announcements, saved: pinned ? data.saved : data.saved.filter(s => !(s.type === 'announcement' && s.id === existing?.id)) };
}

export function setSaved(data, type, id, saved) {
  const items = data.saved.filter(s => !(s.type === type && s.id === id));
  const table={message:'messages',resource:'resources',announcement:'announcements'}[type];
  const exists=data[table]?.some(item => item.id === id);
  return { ...data, saved: saved && exists ? [...items, { type, id }] : items };
}

export function setReaction(data, id, reaction, active) {
  return updateMessage(data, id, m => {
    const wasActive = m.my_reactions?.includes(reaction) || false;
    const mine = (m.my_reactions || []).filter(value => value !== reaction);
    return { ...m, my_reactions: active ? [...mine, reaction] : mine, reactions: { ...m.reactions, [reaction]: Math.max(0, (m.reactions?.[reaction] || 0) + Number(active) - Number(wasActive)) } };
  });
}

export function readNotifications(data, ids) {
  return { ...data, notifications: data.notifications.map(n => !ids || ids.includes(n.id) ? { ...n, read: 1 } : n) };
}
