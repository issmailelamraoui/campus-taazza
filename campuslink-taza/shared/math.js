const functions = { sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs, log: Math.log, exp: Math.exp, floor: Math.floor, ceil: Math.ceil };
const fail = () => { throw new Error('Expression invalide. Utilisez x, pi, e, + − * / ^ et les fonctions proposées.'); };

// This grammar constructs numbers and arithmetic nodes. It never creates or
// evaluates JavaScript, accesses object properties, or calls user functions.
export function parseMathExpression(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 256) return fail();
  const tokens = [];
  let offset = 0;
  while (offset < input.length) {
    if (/\s/.test(input[offset])) { offset++; continue; }
    const match = /^(?:(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[a-z]+|[()+*/^−-])/i.exec(input.slice(offset));
    if (!match || tokens.length >= 128) return fail();
    tokens.push(match[0].toLowerCase().replace('−', '-')); offset += match[0].length;
  }
  let position = 0, depth = 0;
  const take = value => tokens[position] === value && (++position, true);
  function primary() {
    if (++depth > 32) return fail();
    const token = tokens[position++];
    let node;
    if (token === '(') { node = sum(); if (!take(')')) return fail(); }
    else if (token === 'x') node = { type: 'x' };
    else if (token === 'pi' || token === 'e') node = { type: 'number', value: token === 'pi' ? Math.PI : Math.E };
    else if (Object.hasOwn(functions, token)) {
      if (!take('(')) return fail();
      node = { type: 'function', name: token, value: sum() };
      if (!take(')')) return fail();
    } else if (token && /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/.test(token) && Number.isFinite(Number(token))) node = { type: 'number', value: Number(token) };
    else return fail();
    depth--; return node;
  }
  function power() { const left = primary(); return take('^') ? { type: '^', left, right: unary() } : left; }
  function unary() {
    if (++depth > 32) return fail();
    const result = take('-') ? { type: 'negative', value: unary() } : take('+') ? unary() : power();
    depth--; return result;
  }
  function product() {
    let left = unary();
    while (['*', '/'].includes(tokens[position])) { const type = tokens[position++]; left = { type, left, right: unary() }; }
    return left;
  }
  function sum() {
    let left = product();
    while (['+', '-'].includes(tokens[position])) { const type = tokens[position++]; left = { type, left, right: product() }; }
    return left;
  }
  const tree = sum(); if (position !== tokens.length) return fail();
  return tree;
}
export function evaluateMath(tree, x) {
  switch (tree.type) {
    case 'number': return tree.value;
    case 'x': return x;
    case 'negative': return -evaluateMath(tree.value, x);
    case 'function': return functions[tree.name](evaluateMath(tree.value, x));
    case '+': return evaluateMath(tree.left, x) + evaluateMath(tree.right, x);
    case '-': return evaluateMath(tree.left, x) - evaluateMath(tree.right, x);
    case '*': return evaluateMath(tree.left, x) * evaluateMath(tree.right, x);
    case '/': return evaluateMath(tree.left, x) / evaluateMath(tree.right, x);
    case '^': return evaluateMath(tree.left, x) ** evaluateMath(tree.right, x);
    default: return fail();
  }
}
export function sampleGraph(expression, min = -10, max = 10, count = 321) {
  if (![min, max].every(value => typeof value === 'number' && Number.isFinite(value)) || min >= max || Math.max(Math.abs(min), Math.abs(max)) > 1e6
    || !Number.isInteger(count) || count < 20 || count > 1000) throw new Error('Intervalle invalide.');
  const tree = parseMathExpression(expression);
  return Array.from({ length: count }, (_, index) => {
    const x = min + (max - min) * index / (count - 1), y = evaluateMath(tree, x);
    return { x, y: Number.isFinite(y) && Math.abs(y) <= 1e12 ? y : null };
  });
}
export const MATH_FUNCTIONS = Object.keys(functions);
