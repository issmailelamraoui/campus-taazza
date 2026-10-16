export const UPLOAD_CHUNK_BYTES=2*1024*1024;
export const UPLOAD_CHUNK_THRESHOLD=3*1024*1024;
export const UPLOAD_MAX_BYTES=20*1024*1024;
export function chunkUploadTarget(path,method='POST'){
 return String(method).toUpperCase()==='POST'&&typeof path==='string'&&/^\/(?:uploads|admin\/resources\/[1-9]\d*\/replace|feedback\/[1-9]\d*\/attachments|document-repairs\/[1-9]\d*|campus\/forum\/[1-9]\d*\/attachments|resource-supplements\/[1-9]\d*\/upload)$/.test(path);
}
