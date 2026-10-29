export const RESOURCE_CATEGORIES = Object.freeze(['courses', 'exercises', 'td', 'tp', 'corrections', 'exams', 'rattrapage']);

const aliases = new Map([
  ['cours', 'courses'], ['course', 'courses'], ['courses', 'courses'],
  ['exercice', 'exercises'], ['exercices', 'exercises'], ['exercise', 'exercises'], ['exercises', 'exercises'],
  ['examen', 'exams'], ['examens', 'exams'], ['exam', 'exams'], ['exams', 'exams'],
  ['correction', 'corrections'], ['corrections', 'corrections'], ['corrige', 'corrections'], ['corriges', 'corrections'],
  ['td', 'td'], ['tp', 'tp'], ['tdtp', 'tdtp'], ['td / tp', 'tdtp'], ['td/tp', 'tdtp'],
  ['rattrapage', 'rattrapage'],
]);

export function normalizeResourceCategory(value) {
  const label = String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase().replace(/\s+/g, ' ');
  return aliases.get(label) || label;
}

// Earlier TD/TP/correction uploads used a broad category. Preserve the more
// precise authoritative type; never guess whether a legacy TD/TP was TD or TP.
export function resourceCategory(resource) {
  const type = normalizeResourceCategory(resource?.resource_type ?? resource?.resourceType);
  if (['td', 'tp', 'corrections'].includes(type)) return type;
  return normalizeResourceCategory(resource?.category_key ?? resource?.category) || 'unclassified';
}
