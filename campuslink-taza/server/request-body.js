// Vercel exposes req.body through a lazy getter that can consume the incoming
// stream. Leave streaming upload bodies untouched for Multer/express.raw.
export function requestBodyForValidation(req) {
  const contentType = String(
    req.get?.("content-type") ?? req.headers?.["content-type"] ?? "",
  )
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    contentType === "multipart/form-data" ||
    contentType === "application/octet-stream"
  )
    return null;
  req.body ??= {};
  return req.body;
}
