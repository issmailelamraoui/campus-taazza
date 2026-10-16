// This script runs in an allow-scripts-only frame. Neither the frame nor the
// blob Worker it creates has CampusLink's origin or access to its private data.
const applicationOrigin = new URL(import.meta.url).origin;
const channel = 'campus-labs-python';
const send = data => parent.postMessage({ channel, ...data }, applicationOrigin);
let worker, workerURL;
function stop() {
  worker?.terminate(); worker = undefined;
  if (workerURL) URL.revokeObjectURL(workerURL);
  workerURL = undefined;
}
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== applicationOrigin || event.data?.channel !== channel) return;
  if (event.data.type === 'stop') { stop(); return; }
  if (event.data.type !== 'start' || worker) return;
  try {
    const scriptURL = new URL('./runner.js', import.meta.url).href;
    // The blob inherits this frame's opaque origin and asset-only CSP. Loading
    // the runner as a CORS module does not give the Worker the module's origin.
    workerURL = URL.createObjectURL(new Blob([`import(${JSON.stringify(scriptURL)}).then(() => self.postMessage({bootstrap:'ready'}), error => self.postMessage({bootstrap:'error',message:error.message}));`], { type: 'text/javascript' }));
    // Classic blob Workers retain opaque origins in browsers that reject
    // module blob Workers there; dynamic import still loads our ESM bundle.
    worker = new Worker(workerURL, { name: 'Campus Labs Python' });
    let started = false;
    worker.onmessage = message => {
      if (!started && message.data?.bootstrap === 'ready') { started = true; worker.postMessage(event.data.data); }
      else if (!started && message.data?.bootstrap === 'error') { send({ type: 'error', message: message.data.message }); stop(); }
      else if (started) send({ type: 'message', data: message.data });
    };
    worker.onerror = event => { event.preventDefault(); send({ type: 'error', message: event.message || 'Le moteur Python n’a pas pu démarrer.' }); stop(); };
  } catch (error) { send({ type: 'error', message: error.message }); stop(); }
});
window.addEventListener('pagehide', stop);
send({ type: 'ready' });
