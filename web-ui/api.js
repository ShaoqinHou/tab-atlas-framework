export const TOKEN_STORAGE_KEY = 'tabatlas.localToken';

export async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has('content-type') && options.body) headers.set('content-type', 'application/json');
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (token) headers.set('x-tab-atlas-token', token);
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data && data.error ? data.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export async function getJson(path) {
  return api(path);
}

export async function postJson(path, body = {}) {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}

export function getSavedToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
}

export function saveToken(token) {
  const trimmed = token.trim();
  if (trimmed) localStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}
