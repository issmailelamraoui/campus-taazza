let initialized = false;
let snapshot = { prompt: null, installed: false };
const listeners = new Set();

function update(values) {
  snapshot = { ...snapshot, ...values };
  for (const listener of listeners) listener();
}

export const subscribeInstall = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getInstallState = () => snapshot;

// Listen before the Settings page mounts: browsers can offer installation at
// any point after loading the site. The prompt is only used from a button click.
export function initializePwa() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  const standalone = window.matchMedia('(display-mode: standalone)');
  const syncInstalled = () => update({ installed: standalone.matches || navigator.standalone === true });
  syncInstalled();
  standalone.addEventListener?.('change', syncInstalled);
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    update({ prompt: event });
  });
  window.addEventListener('appinstalled', () => update({ installed: true, prompt: null }));
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

export async function promptInstall() {
  const event = snapshot.prompt;
  if (!event) return null;
  // A browser installation event can only be prompted once.
  update({ prompt: null });
  const result = await event.prompt();
  const choice = result?.outcome ? result : await event.userChoice;
  if (choice?.outcome === 'accepted') update({ installed: true });
  return choice?.outcome || null;
}
