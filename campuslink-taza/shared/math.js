const functions = {
  sin: Math.sin, cos: Math.cos,
  tan: value => Math.abs(Math.cos(value)) < 1e-14 ? NaN : Math.tan(value),
  sqrt: value => value < 0 ? NaN : Math.sqrt(value), abs: Math.abs,
  ln: value => value > 0 ? Math.log(value) : NaN,
  log: value => value > 0 ? Math.log10(value) : NaN,
  exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
};
const messages = {
  SYNTAX: ['Expression invalide. Utilisez x, pi, e, + − * / ^, |x| et les fonctions proposées.', 'Invalid expression. Use x, pi, e, + − * / ^, |x| and the listed functions.', 'تعبير غير صالح. استعمل x وpi وe والعمليات + − * / ^ و|x| والدوال المقترحة.'],
  EMPTY: ['Saisissez une fonction à tracer.', 'Enter a function to plot.', 'أدخل دالة لرسمها.'],
  COMPLEXITY: ['Expression trop longue ou trop imbriquée. Simplifiez-la (256 caractères maximum).', 'Expression too long or deeply nested. Simplify it (256 characters maximum).', 'التعبير طويل أو متداخل بزاف. بسّطو (256 حرفاً كحد أقصى).'],
  PARENTHESIS: ['Expression invalide : vérifiez les parenthèses et utilisez sin(x), ln(x), etc.', 'Invalid expression: check parentheses and use sin(x), ln(x), etc.', 'تعبير غير صالح: راجع الأقواس واستعمل sin(x) أو ln(x) مثلاً.'],
  ABSOLUTE: ['Expression invalide : fermez chaque valeur absolue, par exemple |x-3|.', 'Invalid expression: close each absolute-value pair, for example |x-3|.', 'تعبير غير صالح: سدّ كل زوج ديال علامات القيمة المطلقة، مثلاً |x-3|.'],
  NAME: ['Expression invalide : fonction ou constante inconnue. Utilisez les noms proposés et * pour séparer les termes.', 'Invalid expression: unknown function or constant. Use the listed names and * to separate terms.', 'تعبير غير صالح: دالة أو ثابت غير معروف. استعمل الأسماء المقترحة و* للفصل بين الحدود.'],
  INTERVAL: ['Intervalle horizontal invalide. Choisissez deux bornes finies et croissantes, entre −1000000 et 1000000.', 'Invalid horizontal range. Choose two increasing finite bounds between −1000000 and 1000000.', 'نطاق أفقي غير صالح. اختر حدّين محدودين ومتزايدين بين −1000000 و1000000.'],
};
const fail = (code = 'SYNTAX') => { throw Object.assign(new Error(messages[code][0]), { code: 'MATH_' + code }); };
export function mathErrorMessage(error, language = 'fr') {
  const group = messages[String(error?.code || '').replace(/^MATH_/, '')];
  return group ? group[language === 'ar' ? 2 : language === 'en' ? 1 : 0] : error?.message || messages.SYNTAX[0];
}

// Arithmetic grammar only: it cannot create JavaScript, access properties or
// call student-defined functions. Implicit products have the same precedence
// and left associativity as *, /: write 1/(2x) for both terms below a fraction.
export function parseMathExpression(input) {
  if (typeof input !== 'string' || !input.trim()) return fail('EMPTY');
  if (input.length > 256) return fail('COMPLEXITY');
  const tokens = [];
  let offset = 0;
  while (offset < input.length) {
    if (/\s/.test(input[offset])) { offset++; continue; }
    const match = /^(?:(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[a-z]+|[π()+*/^|−×·÷-])/i.exec(input.slice(offset));
    if (!match) return fail();
    if (tokens.length >= 128) return fail('COMPLEXITY');
    const token = match[0].toLowerCase();
    tokens.push(({ '−': '-', '×': '*', '·': '*', '÷': '/', 'π': 'pi' })[token] || token);
    offset += match[0].length;
  }
  let position = 0, depth = 0;
  const take = value => tokens[position] === value && (++position, true);
  const nested = operation => {
    if (++depth > 32) return fail('COMPLEXITY');
    const result = operation(); depth--; return result;
  };
  function primary() {
    return nested(() => {
      const token = tokens[position++];
      if (token === '(') { const node = sum(false); if (!take(')')) return fail('PARENTHESIS'); return node; }
      if (token === '|') { const value = sum(true); if (!take('|')) return fail('ABSOLUTE'); return { type: 'function', name: 'abs', value }; }
      if (token === 'x') return { type: 'x' };
      // e(x) is an explicit graph shorthand; bare e remains Euler's constant.
      if (Object.hasOwn(functions, token) || token === 'e' && tokens[position] === '(') {
        if (!take('(')) return fail('PARENTHESIS');
        const value = sum(false); if (!take(')')) return fail('PARENTHESIS');
        return { type: 'function', name: token === 'e' ? 'exp' : token, value };
      }
      if (token === 'pi' || token === 'e') return { type: 'number', value: token === 'pi' ? Math.PI : Math.E };
      if (token && /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/.test(token) && Number.isFinite(Number(token))) return { type: 'number', value: Number(token) };
      return fail(token && /^[a-z]+$/.test(token) ? 'NAME' : 'SYNTAX');
    });
  }
  function power(stopAtBar) { const left = primary(); return take('^') ? { type: '^', left, right: unary(stopAtBar) } : left; }
  function unary(stopAtBar) {
    return nested(() => take('-') ? { type: 'negative', value: unary(stopAtBar) } : take('+') ? unary(stopAtBar) : power(stopAtBar));
  }
  function implicit(stopAtBar) {
    const token = tokens[position];
    return token === '(' || token === 'x' || token === 'pi' || token === 'e' || Object.hasOwn(functions, token) || token === '|' && !stopAtBar;
  }
  function product(stopAtBar) {
    let left = unary(stopAtBar);
    while (['*', '/'].includes(tokens[position]) || implicit(stopAtBar)) {
      const type = ['*', '/'].includes(tokens[position]) ? tokens[position++] : '*';
      left = { type, left, right: unary(stopAtBar) };
    }
    return left;
  }
  function sum(stopAtBar) {
    let left = product(stopAtBar);
    while (['+', '-'].includes(tokens[position])) { const type = tokens[position++]; left = { type, left, right: product(stopAtBar) }; }
    return left;
  }
  const tree = sum(false); if (position !== tokens.length) return fail(tokens[position] === ')' ? 'PARENTHESIS' : 'SYNTAX');
  return tree;
}

// Exact small integer fractions allow real odd roots such as x^(1/3), without
// rounding arbitrary decimal exponents into a different mathematical value.
const fractions = new WeakMap();
function fraction(node) {
  if (fractions.has(node)) return fractions.get(node);
  let result = null;
  if (node.type === 'number' && Number.isSafeInteger(node.value)) result = [node.value, 1];
  else if (node.type === 'negative') { const value = fraction(node.value); if (value) result = [-value[0], value[1]]; }
  else if (['+', '-', '*', '/'].includes(node.type)) {
    const a = fraction(node.left), b = fraction(node.right);
    if (a && b) {
      if (node.type === '+') result = [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
      if (node.type === '-') result = [a[0] * b[1] - b[0] * a[1], a[1] * b[1]];
      if (node.type === '*') result = [a[0] * b[0], a[1] * b[1]];
      if (node.type === '/' && b[0]) result = [a[0] * b[1], a[1] * b[0]];
    }
  }
  if (result) {
    let [a, b] = result;
    if (![a, b].every(Number.isSafeInteger) || !b || Math.max(Math.abs(a), Math.abs(b)) > 1e6) result = null;
    else {
      if (b < 0) { a = -a; b = -b; }
      let x = Math.abs(a), y = b; while (y) [x, y] = [y, x % y];
      result = [a / x, b / x];
    }
  }
  fractions.set(node, result); return result;
}
function realPower(base, exponent, exponentNode) {
  if (base === 0 && exponent <= 0) return NaN;
  if (base < 0 && !Number.isInteger(exponent)) {
    const exact = fraction(exponentNode);
    return exact && Math.abs(exact[1] % 2) === 1 ? (Math.abs(exact[0] % 2) === 1 ? -1 : 1) * Math.abs(base) ** exponent : NaN;
  }
  return base ** exponent;
}
export function evaluateMath(tree, x) {
  if (tree.type === 'number') return tree.value;
  if (tree.type === 'x') return Number.isFinite(x) ? x : NaN;
  if (tree.type === 'negative') return -evaluateMath(tree.value, x);
  if (tree.type === 'function') { const value = evaluateMath(tree.value, x); return Number.isFinite(value) && Object.hasOwn(functions, tree.name) ? functions[tree.name](value) : NaN; }
  const left = evaluateMath(tree.left, x), right = evaluateMath(tree.right, x);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN;
  switch (tree.type) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right === 0 ? NaN : left / right;
    case '^': return realPower(left, right, tree.right);
    default: return fail();
  }
}

const unknown = () => ({ low: -Infinity, high: Infinity, safe: false });
const bounds = (low, high, safe = true) => ({ low, high, safe: safe && Number.isFinite(low) && Number.isFinite(high) });
const crosses = (range, point = 0) => range.low <= point && range.high >= point;
const lattice = (low, high, start, step) => Math.ceil((low - start) / step) <= Math.floor((high - start) / step);
function trigBounds(range, cosine) {
  const { low, high } = range, shift = cosine ? 0 : Math.PI / 2, fn = cosine ? Math.cos : Math.sin;
  return bounds(lattice(low, high, shift + Math.PI, Math.PI * 2) ? -1 : Math.min(fn(low), fn(high)), lattice(low, high, shift, Math.PI * 2) ? 1 : Math.max(fn(low), fn(high)));
}
function multiply(a, b) { const values = [a.low * b.low, a.low * b.high, a.high * b.low, a.high * b.high]; return bounds(Math.min(...values), Math.max(...values)); }
function interval(tree, low, high, budget) {
  if (--budget.remaining < 0) return unknown();
  if (tree.type === 'number') return bounds(tree.value, tree.value);
  if (tree.type === 'x') return bounds(low, high);
  if (tree.type === 'negative') { const a = interval(tree.value, low, high, budget); return bounds(-a.high, -a.low, a.safe); }
  if (tree.type === 'function') {
    const a = interval(tree.value, low, high, budget); if (!a.safe) return unknown();
    if (a.low === a.high) { const value = functions[tree.name](a.low); return bounds(value, value); }
    switch (tree.name) {
      case 'abs': return bounds(crosses(a) ? 0 : Math.min(Math.abs(a.low), Math.abs(a.high)), Math.max(Math.abs(a.low), Math.abs(a.high)));
      case 'sqrt': return a.low < 0 ? unknown() : bounds(Math.sqrt(a.low), Math.sqrt(a.high));
      case 'ln': case 'log': return a.low <= 0 ? unknown() : bounds(functions[tree.name](a.low), functions[tree.name](a.high));
      case 'exp': return bounds(Math.exp(a.low), Math.exp(a.high));
      case 'sin': return trigBounds(a, false);
      case 'cos': return trigBounds(a, true);
      case 'tan': return lattice(a.low, a.high, Math.PI / 2, Math.PI) ? unknown() : bounds(functions.tan(a.low), functions.tan(a.high));
      case 'floor': case 'ceil': { const value = functions[tree.name](a.low), end = functions[tree.name](a.high); return bounds(value, end, value === end); }
      default: return unknown();
    }
  }
  const a = interval(tree.left, low, high, budget), b = interval(tree.right, low, high, budget);
  if (!a.safe || !b.safe) return unknown();
  switch (tree.type) {
    case '+': return bounds(a.low + b.low, a.high + b.high);
    case '-': return tree.left.type === 'x' && tree.right.type === 'x' ? bounds(0, 0) : bounds(a.low - b.high, a.high - b.low);
    case '*': return multiply(a, b);
    case '/': return crosses(b) ? unknown() : multiply(a, bounds(1 / b.high, 1 / b.low));
    case '^': {
      if (b.low !== b.high) {
        if (a.low === 0 && a.high === 0 && b.low > 0) return bounds(0, 0);
        return a.low <= 0 ? unknown() : interval({ type: 'function', name: 'exp', value: { type: '*', left: tree.right, right: { type: 'function', name: 'ln', value: tree.left } } }, low, high, budget);
      }
      const exponent = b.low, exact = fraction(tree.right);
      if (exponent === 0 && crosses(a)) return unknown();
      if (exponent < 0 && crosses(a) || a.low < 0 && !Number.isInteger(exponent) && (!exact || exact[1] % 2 === 0)) return unknown();
      const values = [realPower(a.low, exponent, tree.right), realPower(a.high, exponent, tree.right)];
      if (crosses(a) && exponent > 0) values.push(0);
      return bounds(Math.min(...values), Math.max(...values));
    }
    default: return unknown();
  }
}
function continuous(tree, left, right, budget, depth = 0) {
  if (budget.remaining <= 0) return false;
  if (interval(tree, left, right, budget).safe) return true;
  if (depth >= 9) return false;
  const middle = left + (right - left) / 2;
  if (middle === left || middle === right || !Number.isFinite(evaluateMath(tree, middle))) return false;
  return continuous(tree, left, middle, budget, depth + 1) && continuous(tree, middle, right, budget, depth + 1);
}
export function sampleGraph(expression, min = -10, max = 10, count = 321) {
  if (![min, max].every(value => typeof value === 'number' && Number.isFinite(value)) || min >= max || Math.max(Math.abs(min), Math.abs(max)) > 1e6
    || !Number.isInteger(count) || count < 20 || count > 1000) return fail('INTERVAL');
  const tree = parseMathExpression(expression), budget = { remaining: 250000 };
  const points = Array.from({ length: count }, (_, index) => {
    const x = min + (max - min) * index / (count - 1), y = evaluateMath(tree, x);
    return { x, y: Number.isFinite(y) && Math.abs(y) <= 1e12 ? y : null, breakBefore: index === 0 };
  });
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1], point = points[index];
    // Domain intervals, rather than visible-height jumps, catch poles between
    // samples (including even powers and tiny scaled residues). Ambiguous or
    // excessively oscillatory spans stay disconnected within a bounded budget.
    point.breakBefore = previous.y === null || point.y === null || !continuous(tree, previous.x, point.x, budget);
  }
  return points;
}
export const MATH_FUNCTIONS = Object.keys(functions);
