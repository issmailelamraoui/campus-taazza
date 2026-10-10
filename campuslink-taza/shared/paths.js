// The API, library filters and command palette share one canonical module slug.
export const slug = (text = '') => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
