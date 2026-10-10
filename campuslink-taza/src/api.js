let sessionGeneration = 0;
export const invalidateAPISession = () => { sessionGeneration++; };
const activityListeners = new Set();
let activity = { reads: 0, writes: 0 };
export function subscribeAPIActivity(listener) {
  activityListeners.add(listener); listener(activity);
  return () => activityListeners.delete(listener);
}
function updateActivity(kind, delta) {
  activity = { ...activity, [kind]: Math.max(0, activity[kind] + delta) };
  activityListeners.forEach(listener => listener(activity));
}
export async function api(path, options = {}) {
  const generation = sessionGeneration;
  const { body, timeout = 20000, signal, ...rest } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  const multipart = body instanceof FormData;
  const activityKind = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(String(rest.method || 'GET').toUpperCase()) ? 'writes' : 'reads';
  updateActivity(activityKind, 1);
  try {
    const response = await fetch(`/api${path}`, {
      ...rest, credentials: 'same-origin', signal: controller.signal,
      headers: { ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
      body: multipart ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = Object.assign(new Error(data?.error || data?.message || `Erreur ${response.status}`), { status: response.status, data: data || {} });
      if (response.status === 401 && path !== '/login' && generation === sessionGeneration) window.dispatchEvent(new Event('campus-session-expired'));
      throw error;
    }
    if (!data || typeof data !== 'object') throw new Error('La réponse du serveur est invalide. Réessayez.');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('La connexion a expiré. Réessayez.'), { code: 'TIMEOUT' });
    if (error instanceof TypeError) throw new Error('Impossible de joindre le serveur. Vérifiez votre connexion et réessayez.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    updateActivity(activityKind, -1);
  }
}
