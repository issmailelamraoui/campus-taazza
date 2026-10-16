import { createPythonWorker } from './labs-python-runner.js';

export const LAB_RUNTIME_VERSION = '2026-10-16-v2';
export const LAB_RUN_LIMITS = Object.freeze({ sourceBytes: 16000, inputBytes: 16000, outputBytes: 64000, startupMs: 120000, compileMs: 30000, executionMs: 5000 });

export function runLabCode(language, source, { input = '', onEvent = () => {}, signal, executionMs = LAB_RUN_LIMITS.executionMs } = {}) {
  return new Promise((resolve, reject) => {
    if (!['javascript', 'python', 'c', 'cpp', 'json'].includes(language)) return reject(new Error('Langage indisponible.'));
    if (!source.trim() || new TextEncoder().encode(source).length > LAB_RUN_LIMITS.sourceBytes || source.includes('\0')) return reject(new Error('Code invalide ou trop long (16 Ko maximum).'));
    if (new TextEncoder().encode(input).length > LAB_RUN_LIMITS.inputBytes) return reject(new Error('Les entrées sont limitées à 16 Ko.'));
    if (signal?.aborted) return resolve({ status: 'stopped', exitCode: null });
    // Pyodide's ffi can construct JavaScript objects even with an empty `js`
    // namespace. Give its Worker an opaque origin rather than the app's origin.
    const worker = language === 'python' ? createPythonWorker(LAB_RUNTIME_VERSION) : new Worker(`/labs-runtime/runner.js?v=${LAB_RUNTIME_VERSION}`, { type: 'module', name: 'Campus Labs' });
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    let settled = false, timer, phase = 'loading';
    const cleanup = () => { clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', stop); };
    const finish = value => { if (settled) return; settled = true; cleanup(); resolve(value); };
    const fail = error => { if (settled) return; settled = true; cleanup(); reject(error); };
    const stop = () => finish({ status: 'stopped', exitCode: null });
    const deadline = ms => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        onEvent({ type: 'output', stream: 'stderr', text: phase === 'running' ? 'Temps limite atteint (5 secondes).\n' : 'Le chargement ou la compilation a dépassé le délai.\n' });
        finish({ status: 'timeout', exitCode: null });
      }, ms);
    };
    signal?.addEventListener('abort', stop, { once: true });
    worker.onmessage = ({ data }) => {
      if (!data || settled || data.token !== token) return;
      delete data.token;
      if (data.type === 'phase') {
        if (data.phase === 'running' && phase !== 'running') { phase = 'running'; deadline(executionMs); }
        else if (data.phase === 'compiling' && phase === 'loading' && ['c', 'cpp'].includes(language)) { phase = 'compiling'; deadline(LAB_RUN_LIMITS.compileMs); }
        else return;
      }
      if (data.type === 'done') finish(data.result);
      else onEvent(data);
    };
    worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Le moteur de code n’a pas pu démarrer.')); };
    deadline(LAB_RUN_LIMITS.startupMs);
    worker.postMessage({ token, language, source, input, executionMs, outputBytes: LAB_RUN_LIMITS.outputBytes });
  });
}
