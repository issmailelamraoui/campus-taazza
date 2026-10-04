const administrativeRoles = new Set(['global_admin', 'faculty_admin', 'moderator']);

export function isAdminInboxNotification(user, notification) {
  return user && (user.account_status || 'approved') === 'approved' && administrativeRoles.has(user.role)
    && notification.type === 'admin' && !notification.read
    && /^\/app\/admin(?:[?#]|$)/.test(notification.path || '');
}

// A first snapshot establishes the inbox baseline. Only later arrivals produce
// popups; reconnects, read changes and ordinary conversations stay quiet.
export class AdminNotificationFeed {
  reset() { this.owner = null; this.seen = new Set(); }
  constructor() { this.reset(); }
  capture(user, notifications) {
    const eligible = user && (user.account_status || 'approved') === 'approved' && administrativeRoles.has(user.role);
    if (!eligible) { this.reset(); return []; }
    const owner = `${user.id}:${user.faculty_id}:${user.role}`;
    if (this.owner !== owner) {
      this.owner = owner;
      this.seen = new Set(notifications.map(item => item.id));
      return [];
    }
    const arrivals = notifications.filter(item => !this.seen.has(item.id) && isAdminInboxNotification(user, item));
    for (const item of notifications) this.seen.add(item.id);
    return arrivals.sort((a, b) => a.id - b.id);
  }
}
