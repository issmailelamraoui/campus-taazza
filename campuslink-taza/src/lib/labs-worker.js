import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import releaseSync from '@jitl/quickjs-wasmfile-release-sync';
import { createToolchain, compilerDiagnostics, CLANG_DRIVER_DEFAULT_ARGS } from '@live-codes/clang-wasm/toolchain';
import { boundWasmMemory } from './labs-wasm.js';

// JavaScript runs in QuickJS. Python additionally requires an opaque-origin
// owner because its ffi can reach the Worker's JavaScript realm.
const postToHost = self.postMessage.bind(self);
let messageToken, started = false;
const send = value => postToHost({ ...value, token: messageToken });
const encodeOutput = new TextEncoder().encode.bind(new TextEncoder());
let outputSize = 0, outputLimit = 64000, writes = 0;
const output = (stream, text) => {
  text = String(text);
  if (!text) return;
  outputSize += encodeOutput(text).length;
  if (outputSize > outputLimit || ++writes > 1500) throw new Error('Sortie limitée à 64 Ko et 1 500 écritures. Réduisez les affichages de votre programme.');
  send({ type: 'output', stream, text });
};
const phase = value => send({ type: 'phase', phase: value });
const runtimeURL = new URL('./', import.meta.url);
const describe = value => typeof value === 'string' ? value : value === undefined ? 'undefined' : typeof value === 'bigint' ? `${value}n` : typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value, null, 2) ?? String(value);

async function javascript(source, input, executionMs) {
  const QuickJS = await newQuickJSWASMModuleFromVariant(newVariant(releaseSync, { wasmLocation: new URL('./quickjs.wasm', runtimeURL).href }));
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024); runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext();
  let interrupted = false, evaluation;
  try {
    const consoleObject = vm.newObject();
    for (const name of ['log', 'info', 'debug', 'warn', 'error']) {
      const fn = vm.newFunction(name, (...args) => { output(['warn', 'error'].includes(name) ? 'stderr' : 'stdout', args.map(arg => describe(vm.dump(arg))).join(' ') + '\n'); });
      vm.setProp(consoleObject, name, fn); fn.dispose();
    }
    vm.setProp(vm.global, 'console', consoleObject); consoleObject.dispose();
    const lines = input.split('\n'); let line = 0;
    const prompt = vm.newFunction('prompt', () => line < lines.length ? vm.newString(lines[line++]) : vm.null);
    vm.setProp(vm.global, 'prompt', prompt); prompt.dispose();
    phase('running');
    const deadline = Date.now() + executionMs;
    runtime.setInterruptHandler(() => { interrupted = Date.now() >= deadline; return interrupted; });
    const result = vm.evalCode(source, 'campus.js', { type: 'module' });
    if (result.error) {
      const error = vm.dump(result.error); result.error.dispose();
      output('stderr', `${error?.name || 'Error'}: ${error?.message || describe(error)}${error?.stack ? '\n' + error.stack : ''}\n`);
      return { status: interrupted ? 'timeout' : 'error', exitCode: 1 };
    }
    evaluation = result.value;
    while (runtime.hasPendingJob()) {
      const jobs = runtime.executePendingJobs();
      if (jobs.error) { const error = vm.dump(jobs.error); jobs.error.dispose(); output('stderr', describe(error) + '\n'); return { status: interrupted ? 'timeout' : 'error', exitCode: 1 }; }
    }
    const promise = vm.getPromiseState(evaluation);
    if (promise.type === 'rejected') {
      const error = vm.dump(promise.error); promise.error.dispose();
      output('stderr', `${error?.name || 'Error'}: ${error?.message || describe(error)}\n`);
      return { status: 'error', exitCode: 1 };
    }
    if (promise.type === 'pending') { output('stderr', 'Une promesse est restée en attente. Les API du navigateur ne sont pas disponibles dans ce moteur.\n'); return { status: 'error', exitCode: 1 }; }
    if (!promise.notAPromise) promise.value.dispose();
    return { status: 'success', exitCode: 0 };
  } finally { evaluation?.dispose(); vm.dispose(); runtime.dispose(); }
}

async function python(source, input) {
  const { loadPyodide } = await import(/* @vite-ignore */ new URL('./python/pyodide.mjs', runtimeURL).href);
  const lines = input ? input.replace(/\n$/, '').split('\n') : []; let index = 0;
  const pyodide = await loadPyodide({
    indexURL: new URL('./python/', runtimeURL).href,
    jsglobals: Object.freeze(Object.create(null)),
    stdin: () => index < lines.length ? lines[index++] : null,
    stdout: text => output('stdout', text + '\n'), stderr: text => output('stderr', text + '\n'),
  });
  // write() keeps partial prints and stdout/stderr in their original order.
  for (const [method, stream] of [['setStdout', 'stdout'], ['setStderr', 'stderr']]) {
    const decoder = new TextDecoder();
    pyodide[method]({ write: bytes => { output(stream, decoder.decode(bytes, { stream: true })); return bytes.length; } });
  }
  phase('running');
  try { const result = await pyodide.runPythonAsync(source, { filename: 'campus.py' }); result?.destroy?.(); return { status: 'success', exitCode: 0 }; }
  catch (error) { output('stderr', (error.message || String(error)) + '\n'); return { status: 'error', exitCode: 1 }; }
}

async function clang(language, source, input) {
  const toolchain = await createToolchain({ baseUrl: new URL('./clang/', runtimeURL).href, maxAssetBytes: 96 * 1024 * 1024, onProgress: progress => send({ type: 'progress', progress }) });
  try {
    phase('compiling');
    const started = performance.now();
    const compiled = await toolchain.captureCompilerOutput(() => toolchain.runtime.compileArtifact(source, {
      language: language === 'c' ? 'C' : 'CPP', fileName: language === 'c' ? 'campus.c' : 'campus.cpp',
      compileArgs: [...CLANG_DRIVER_DEFAULT_ARGS, language === 'c' ? '-std=gnu17' : '-std=gnu++20', '-O0', '-ferror-limit', '8'],
    }));
    const compileMs = Math.round(performance.now() - started);
    if (compiled.error) { output('stderr', compilerDiagnostics(compiled.raw).join('\n') || compiled.error.message); return { status: 'error', exitCode: null, compileMs }; }
    const artifact = { ...compiled.result, bytes: boundWasmMemory(compiled.result.bytes, 128) };
    let consumed = false;
    phase('running');
    const result = await toolchain.execute(artifact, { stdin: () => { if (consumed) return null; consumed = true; return input; }, stdout: text => output('stdout', text), stderr: text => output('stderr', text) });
    return { status: result.exitCode === 0 ? 'success' : 'error', exitCode: result.exitCode, compileMs };
  } finally { toolchain.dispose(); }
}

self.onmessage = async ({ data }) => {
  if (started) return;
  started = true; messageToken = data.token;
  outputLimit = data.outputBytes; outputSize = 0; writes = 0;
  phase('loading');
  try {
    let result;
    if (data.language === 'json') { phase('running'); output('stdout', JSON.stringify(JSON.parse(data.source), null, 2) + '\n'); result = { status: 'success', exitCode: 0 }; }
    else if (data.language === 'javascript') result = await javascript(data.source, data.input, data.executionMs);
    else if (data.language === 'python') {
      if (self.origin !== 'null') throw new Error('Le moteur Python nécessite son espace isolé.');
      result = await python(data.source, data.input);
    }
    else result = await clang(data.language, data.source, data.input);
    send({ type: 'done', result });
  } catch (error) {
    send({ type: 'output', stream: 'stderr', text: (error.message || String(error)).slice(0, 2000) + '\n' });
    send({ type: 'done', result: { status: 'error', exitCode: 1 } });
  }
};
