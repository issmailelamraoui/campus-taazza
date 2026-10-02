export async function api(path, options = {}) {
  const { body, ...rest } = options;
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...rest, headers: { ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...rest.headers }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || data.message || `Erreur ${response.status}`); error.status = response.status; error.data = data; throw error; }
  return data;
}
