const STORAGE_PREFIX = 'tabatlas.workspace.';

export const state = {
  page: read('page', 'ask'),
  activeViewId: read('activeViewId', ''),
  activeThreadId: read('activeThreadId', ''),
  layout: read('layout', 'board'),
  focusedSectionId: read('focusedSectionId', ''),
  selectedTarget: null,
  settingsPanel: '',
};

const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setState(patch) {
  Object.assign(state, patch);
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'string') write(key, value);
  }
  listeners.forEach(listener => listener(state));
}

function read(key, fallback) {
  return localStorage.getItem(`${STORAGE_PREFIX}${key}`) ?? fallback;
}

function write(key, value) {
  localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
}
