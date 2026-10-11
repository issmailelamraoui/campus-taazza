export const INSTALL_SEEN_KEY = 'campuslink-prototype-v1:install-prompt-seen-v1';

const standalone = window.matchMedia('(display-mode: standalone)');
let snapshot = { installed: standalone.matches || navigator.standalone === true, prompt: null };
let seenInMemory = false;
const listeners = new Set();

export const getInstallSnapshot = () => snapshot;
export const subscribeInstall = listener => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function update(values) {
  snapshot = { ...snapshot, ...values };
  listeners.forEach(listener => listener());
}
export function hasSeenInstallPrompt() {
  try { return seenInMemory || localStorage.getItem(INSTALL_SEEN_KEY) === 'true'; }
  catch { return seenInMemory; }
}
export function markInstallPromptSeen() {
  seenInMemory = true;
  try { localStorage.setItem(INSTALL_SEEN_KEY, 'true'); } catch {}
}
export function takeInstallPrompt() {
  const event = snapshot.prompt;
  if (event) update({ prompt: null });
  return event;
}

// Capture this event before React mounts. A browser prompt can only be used once.
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  if (!snapshot.installed) update({ prompt: event });
});
window.addEventListener('appinstalled', () => {
  markInstallPromptSeen();
  update({ installed: true, prompt: null });
});
const updateDisplayMode = () => update({ installed: standalone.matches || navigator.standalone === true });
if (standalone.addEventListener) standalone.addEventListener('change', updateDisplayMode);
else standalone.addListener(updateDisplayMode);

export function registerInstallWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  const register = () => navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
