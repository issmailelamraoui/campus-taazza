import { api } from '../api.js';
import { requestId } from './identifiers.js';

const DATABASE = 'campuslink-push-device-v1', STORE = 'device';
const REVISION_KEY = 'campuslink-prototype-v1:push-revision';
let account = null, generation = 0, storageQueue = Promise.resolve(), browserQueue = Promise.resolve(), configRequest;

const failure = (code, message) => Object.assign(new Error(message), { code });
function changed() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('campus-push-changed'));
}
function announce() {
  try { localStorage.setItem(REVISION_KEY, requestId()); } catch {}
  changed();
}
function database() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(failure('STORAGE', 'Le stockage de cet appareil est indisponible.')); return; }
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(failure('STORAGE', 'Impossible de préparer cet appareil.'));
  });
}
async function readDevice(key) {
  await storageQueue;
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(failure('STORAGE', 'Impossible de lire les réglages de cet appareil.'));
    });
  } finally { db.close(); }
}
function writeDevice(change) {
  const result = storageQueue.catch(() => {}).then(async () => {
    const db = await database();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        try { change(transaction.objectStore(STORE)); }
        catch (error) { transaction.abort(); reject(error); return; }
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(failure('STORAGE', 'Impossible de conserver les réglages de cet appareil.'));
        transaction.onabort = () => reject(failure('STORAGE', 'La session de cet appareil a changé.'));
      });
    } finally { db.close(); }
  });
  storageQueue = result.catch(() => {});
  return result;
}
function current(owner, version) {
  if (account !== String(owner) || generation !== version) throw failure('SESSION_CHANGED', 'La session a changé. Réessayez depuis le compte actuel.');
}
export function setPushAccount(userId) {
  const next = userId == null ? null : String(userId);
  if (next !== account) { account = next; generation++; }
}
export function getPushCapability() {
  if (typeof window === 'undefined' || !window.isSecureContext) return { supported: false, reason: 'insecure' };
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (ios && !installed) return { supported: false, reason: 'install', ios, installed };
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return { supported: false, reason: 'unsupported', ios, installed };
  return { supported: true, reason: null, ios, installed };
}
export function decodePushPublicKey(value) {
  try {
    if (typeof value !== 'string' || !/^[\w-]+={0,2}$/.test(value)) throw new Error();
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), character => character.charCodeAt(0));
    if (bytes.length !== 65 || bytes[0] !== 4) throw new Error();
    return bytes;
  } catch { throw failure('CONFIGURATION', 'La configuration des notifications est indisponible.'); }
}
export function getPushConfig({ refresh = false } = {}) {
  if (refresh) configRequest = null;
  if (!configRequest) configRequest = api('/push/config').then(value => {
    if (value.enabled) decodePushPublicKey(value.publicKey);
    return { enabled: value.enabled === true, publicKey: value.publicKey || null };
  }).catch(error => { configRequest = null; throw error; });
  return configRequest;
}
async function worker() {
  if (!('serviceWorker' in navigator)) throw failure('UNSUPPORTED', 'Ce navigateur ne prend pas en charge les notifications.');
  let timer;
  try {
    const registration = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('WORKER_NOT_READY', 'L’application se prépare encore. Réessayez dans un instant.')), 10000);
    })]);
    if (!registration?.active || !registration.pushManager) throw failure('WORKER_NOT_READY', 'L’application se prépare encore. Réessayez dans un instant.');
    return registration;
  } finally { clearTimeout(timer); }
}
async function registeredWorker() {
  if (typeof navigator.serviceWorker?.getRegistration !== 'function') return null;
  let timer;
  try {
    return await Promise.race([navigator.serviceWorker.getRegistration('/'), new Promise(resolve => {
      timer = setTimeout(() => resolve(null), 1000);
    })]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
function withPushManager(operation, { waitForReady = true } = {}) {
  // Wait for an installation outside the operation queue: logout can invalidate
  // a pending enable without sitting behind serviceWorker.ready for ten seconds.
  const registration = waitForReady ? worker() : registeredWorker();
  return registration.then(value => {
    const result = browserQueue.catch(() => {}).then(() => operation(value?.pushManager || null));
    browserQueue = result.catch(() => {});
    return result;
  });
}
async function deviceId() {
  const existing = await readDevice('deviceId');
  if (existing) return existing;
  const value = requestId(); await writeDevice(store => store.put(value, 'deviceId')); return value;
}
export async function inspectPushDevice(userId) {
  const capability = getPushCapability();
  if (!capability.supported) return { ...capability, active: false, permission: typeof Notification === 'undefined' ? 'default' : Notification.permission };
  const owner = String(userId), version = generation;
  current(owner, version);
  const local = await readDevice('active'); current(owner, version);
  const permission = Notification.permission;
  if (permission !== 'granted') return { ...capability, active: false, permission };
  const registration = await worker(), subscription = await registration.pushManager.getSubscription();
  current(owner, version);
  if (!subscription || !local || local.userId !== owner) return { ...capability, active: false, permission };
  const receipt = await api('/push/subscriptions/status', { method: 'POST', body: {
    subscription: subscription.toJSON(), deviceId: local.deviceId, bindingId: local.bindingId, expectedUserId: owner,
  } });
  current(owner, version);
  const active = receipt.enabled === true && receipt.active === true && receipt.bindingId === local.bindingId;
  if (!active) await writeDevice(store => { current(owner, version); store.delete('active'); });
  return { ...capability, active, permission };
}

// requestPermission is deliberately supplied by the click handler, started
// before it awaits registration readiness or any network work.
export async function enablePushDevice({ userId, publicKey, permissionPromise }) {
  const owner = String(userId), version = generation;
  current(owner, version);
  if (!getPushCapability().supported) throw failure('UNSUPPORTED', 'Ce navigateur ne prend pas en charge les notifications.');
  const key = decodePushPublicKey(publicKey);
  const permission = await (permissionPromise || Promise.resolve(Notification.permission));
  current(owner, version);
  if (permission !== 'granted') throw failure(permission === 'denied' ? 'PERMISSION_DENIED' : 'PERMISSION_DISMISSED', 'Les notifications n’ont pas été autorisées.');
  const subscription = await withPushManager(async manager => {
    current(owner, version);
    let subscription = await manager.getSubscription(); current(owner, version);
    const local = await readDevice('active'); current(owner, version);
    // An unowned subscription must not migrate silently from another account.
    if (subscription && (!local || local.userId !== owner)) {
      await subscription.unsubscribe(); current(owner, version); subscription = null;
      await writeDevice(store => { current(owner, version); store.put(requestId(), 'deviceId'); store.delete('active'); });
    }
    if (!subscription) subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    current(owner, version); return subscription;
  });
  current(owner, version);
  const id = await deviceId(); current(owner, version);
  const result = await api('/push/subscriptions', { method: 'POST', body: {
    subscription: subscription.toJSON(), deviceId: id, expectedUserId: owner,
  } });
  current(owner, version);
  if (typeof result.bindingId !== 'string' || !result.bindingId) throw failure('REGISTRATION', 'Impossible de confirmer les notifications sur cet appareil.');
  await writeDevice(store => {
    current(owner, version);
    store.put({ userId: owner, deviceId: id, bindingId: result.bindingId }, 'active');
  });
  announce(); return { active: true, permission: 'granted', bindingId: result.bindingId };
}
export async function disablePushDevice({ detachServer = true, clearAccount = false } = {}) {
  const owner = account, version = ++generation;
  if (clearAccount) account = null;
  let local, storageError, unsubscribeError;
  try { local = await readDevice('active'); } catch (error) { storageError = error; }
  try {
    await writeDevice(store => {
      const request = store.get('active');
      request.onsuccess = () => {
        const value = request.result;
        // Never erase a newer account's binding from a delayed cleanup.
        const capturedOwner = generation === version || local?.userId === owner;
        if (capturedOwner && (local ? value?.bindingId === local.bindingId && value?.userId === local.userId : generation === version)) store.delete('active');
        if (generation === version) store.put(requestId(), 'deviceId');
      };
    });
  } catch (error) { storageError = error; }
  announce();
  try {
    await withPushManager(async manager => {
      if (generation !== version || !manager) return;
      const subscription = await manager.getSubscription();
      if (generation === version && subscription) await subscription.unsubscribe();
    }, { waitForReady: false });
  }
  catch (error) { unsubscribeError = error; }
  // Device is locally disabled before a slow server response. The worker
  // refuses every old binding, including when logout happens while offline.
  if (generation === version && account === owner && detachServer && local && local.userId === owner && navigator.onLine !== false) {
    await api('/push/subscriptions', { method: 'DELETE', body: { deviceId: local.deviceId,
      bindingId: local.bindingId, expectedUserId: owner } });
  }
  if (storageError) throw storageError;
  if (unsubscribeError && getPushCapability().supported) throw unsubscribeError;
  return { active: false };
}
export async function clearLocalPushDevice() {
  return disablePushDevice({ detachServer: false, clearAccount: true });
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === REVISION_KEY) { generation++; changed(); }
});
