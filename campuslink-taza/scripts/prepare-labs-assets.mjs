import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { boundWasmMemory } from '../src/lib/labs-wasm.js';

const require = createRequire(import.meta.url), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'public/labs-runtime');
await mkdir(destination, { recursive: true });
await cp(resolve(root, 'src/lib/labs-python-frame.js'), resolve(destination, 'python-frame.js'));
await writeFile(resolve(destination, 'python-frame.html'), '<!doctype html><meta charset="utf-8"><title>Campus Labs Python</title><script type="module" src="./python-frame.js"></script>\n');
const packageRoot = name => dirname(require.resolve(`${name}/package.json`));
const pythonRoot = packageRoot('pyodide');
await mkdir(resolve(destination, 'python'), { recursive: true });
for (const file of ['pyodide.mjs', 'pyodide.asm.mjs', 'python_stdlib.zip', 'pyodide-lock.json']) await cp(resolve(pythonRoot, file), resolve(destination, 'python', file));
// Patch the module's declared limit, rather than replacing Memory.grow in JS:
// instructions running inside WASM must obey the same 256 MB ceiling.
await writeFile(resolve(destination, 'python/pyodide.asm.wasm'), boundWasmMemory(await readFile(resolve(pythonRoot, 'pyodide.asm.wasm')), 256));
await cp(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'), resolve(destination, 'quickjs.wasm'));
const clangRoot = dirname(dirname(require.resolve('@live-codes/clang-wasm')));
await cp(resolve(clangRoot, 'assets'), resolve(destination, 'clang'), { recursive: true });
for (const file of ['clang.wasm.gz', 'lld.wasm.gz']) {
  const bytes = gunzipSync(await readFile(resolve(clangRoot, 'assets/bin', file)));
  await writeFile(resolve(destination, 'clang/bin', file), gzipSync(boundWasmMemory(bytes, 512)));
}
await cp(resolve(clangRoot, 'THIRD-PARTY-NOTICES.md'), resolve(destination, 'clang/THIRD-PARTY-NOTICES.md'));
await cp(resolve(clangRoot, 'LICENSE'), resolve(destination, 'clang/LICENSE'));
await cp(resolve(packageRoot('quickjs-emscripten'), 'LICENSE'), resolve(destination, 'quickjs-LICENSE'));
await cp(resolve(root, 'scripts/licenses/pyodide-MPL-2.0.txt'), resolve(destination, 'python/LICENSE-MPL-2.0.txt'));
await cp(resolve(root, 'scripts/licenses/CPython-3.14-LICENSE.txt'), resolve(destination, 'python/LICENSE-CPython.txt'));
// Keep upstream licenses and source attribution beside the downloadable code.
await writeFile(resolve(destination, 'NOTICE.txt'), 'Campus Labs uses QuickJS (MIT), Pyodide (MPL-2.0; source: https://github.com/pyodide/pyodide), CPython (PSF), and Clang/LLVM/WASI (permissive third-party licenses listed in clang/THIRD-PARTY-NOTICES.md).\nRuntime assets are packaged from the pinned npm dependencies; no third-party execution service receives student code.\nCampusLink bounds the declared WebAssembly maximum memory in pyodide.asm.wasm (256 MB) and the Clang/LLD binaries (512 MB), without changing their program instructions. The transformation source is src/lib/labs-wasm.js in the CampusLink repository.\n');
await build({ entryPoints: [resolve(root, 'src/lib/labs-worker.js')], outfile: resolve(destination, 'runner.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, logLevel: 'warning', conditions: ['browser'] });
console.log('Campus Labs: browser runtimes prepared (lazy JavaScript, Python, C and C++).');
