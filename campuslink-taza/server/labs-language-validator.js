import { Worker } from 'node:worker_threads';

export const ADDITIONAL_LABS_LANGUAGES = Object.freeze(['python', 'c', 'cpp']);
export const LABS_VALIDATOR_LIMITS = Object.freeze({ maximumConcurrentChecks: 2, timeoutMs: 3000, maximumSourceBytes: 16000, heapMb: 64, wasmMb: 64, maximumDiagnostics: 10 });
const unavailable = () => ({ status: 'validation_unavailable', diagnostics: [{ message: 'Le service de validation est temporairement indisponible. Réessayez.' }], eligiblePractice: false });
let activeChecks = 0;

// Each check gets a disposable parser worker. Source is data supplied to the
// grammar; imports/includes are never loaded and no program is executed.
export async function validateAdditionalLabSource(language, source) {
  if (!ADDITIONAL_LABS_LANGUAGES.includes(language)) throw Object.assign(new Error('Langage non pris en charge.'), { status: 400 });
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source, 'utf8') > LABS_VALIDATOR_LIMITS.maximumSourceBytes || source.includes('\0')) throw Object.assign(new Error('Code invalide ou trop long (16 Ko maximum).'), { status: 400 });
  if (activeChecks >= LABS_VALIDATOR_LIMITS.maximumConcurrentChecks) return unavailable();
  activeChecks++;
  let worker;
  try {
    return await new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(unavailable()), LABS_VALIDATOR_LIMITS.timeoutMs);
      try {
        worker = new Worker(new URL('./labs-language-worker.js', import.meta.url), {
          workerData: { language, source, limits: LABS_VALIDATOR_LIMITS },
          env: {}, execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: LABS_VALIDATOR_LIMITS.heapMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        });
        worker.once('message', finish);
        worker.once('error', () => finish(unavailable()));
        worker.once('exit', () => finish(unavailable()));
      } catch {
        finish(unavailable());
      }
    });
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    activeChecks--;
  }
}
