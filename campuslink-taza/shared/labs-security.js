// Worker connections are restricted to public runtime assets. The path matters:
// allowing the entire origin would include authenticated application APIs.
export const labsWorkerPolicy=origin=>`default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src ${origin}/labs-runtime/; worker-src 'none'`;
export const pythonFramePolicy=origin=>`default-src 'none'; script-src blob: ${origin}/labs-runtime/ 'unsafe-eval' 'wasm-unsafe-eval'; connect-src ${origin}/labs-runtime/; worker-src blob:; frame-src 'none'; form-action 'none'; base-uri 'none'`;
