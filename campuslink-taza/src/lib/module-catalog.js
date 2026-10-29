export const normalizeModuleSearch = value => String(value ?? '').normalize('NFKD')
  .replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');

function editDistance(left, right) {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let index = 0; index < left.length; index++) {
    const next = [index + 1];
    for (let position = 0; position < right.length; position++) next.push(Math.min(
      next[position] + 1, row[position + 1] + 1, row[position] + (left[index] === right[position] ? 0 : 1),
    ));
    row = next;
  }
  return row[right.length];
}

// Suggestions never select, merge or create a module. Numerical curriculum
// distinctions remain significant even when the rest of a name is misspelled.
export function suggestOfficialModules(catalog, query = '') {
  const search = normalizeModuleSearch(query), digits = search.match(/\d+/g)?.join(',') || '';
  return (Array.isArray(catalog) ? catalog : []).filter(item => item?.id != null && item.catalog_status === 'official')
    .map(item => {
      const name = normalizeModuleSearch(item.name), numbers = name.match(/\d+/g)?.join(',') || '';
      if (digits && numbers !== digits) return null;
      const distance = search ? editDistance(search, name) : 0;
      const score = !search || name === search ? 0 : name.includes(search) ? 1 : distance / Math.max(name.length, search.length);
      return !search || name.includes(search) || (search.length >= 4 && score <= .35) ? { item, score } : null;
    }).filter(Boolean).sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name)).map(entry => entry.item);
}
