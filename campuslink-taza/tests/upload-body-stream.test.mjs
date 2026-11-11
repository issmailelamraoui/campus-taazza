import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import multer from "multer";
import test from "node:test";
import { requestBodyForValidation } from "../server/request-body.js";
import { createVercelHandler } from "../server/vercel-handler.js";

async function listen(t, handler, beforeRequest = () => {}) {
  const server = createServer((req, res) => {
    beforeRequest(req);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function withLazyPlatformBody(req) {
  let value;
  Object.defineProperty(req, "body", {
    configurable: true,
    get() {
      // Model Vercel's lazy body helper: reading it starts consuming the stream.
      if (!req.readableEnded) {
        req.platformBodyReads = (req.platformBodyReads || 0) + 1;
        req.on("data", () => {});
      }
      return value;
    },
    set(next) {
      value = next;
    },
  });
}

test("Vercel upload routes leave multipart and octet streams unread until their parser runs", async (t) => {
  const backend = express();
  backend.use("/api", (req, _res, next) => {
    const body = requestBodyForValidation(req);
    if (body?.faculty_id && typeof body.faculty_id !== "string")
      return next(new Error("Invalid faculty"));
    next();
  });
  const upload = multer({ storage: multer.memoryStorage() });
  backend.post("/api/uploads", upload.single("file"), (req, res) => {
    res.json({
      field: req.file?.fieldname,
      name: req.file?.originalname,
      size: req.file?.size,
      bytes: req.file?.buffer.toString(),
      platformBodyReads: req.platformBodyReads || 0,
    });
  });
  backend.put(
    "/api/upload-sessions/:id/parts/:part",
    express.raw({ type: "application/octet-stream", limit: "2mb" }),
    (req, res) =>
      res.json({
        size: req.body.length,
        bytes: req.body.toString(),
        platformBodyReads: req.platformBodyReads || 0,
      }),
  );
  const origin = await listen(
    t,
    createVercelHandler(() => backend),
    withLazyPlatformBody,
  );

  const fileBytes = "valid multipart file payload";
  const form = new FormData();
  form.set("file", new Blob([fileBytes], { type: "text/plain" }), "notes.txt");
  const multipart = await fetch(`${origin}/api/backend?__path=uploads`, {
    method: "POST",
    body: form,
  });
  assert.equal(multipart.status, 200);
  assert.deepEqual(await multipart.json(), {
    field: "file",
    name: "notes.txt",
    size: Buffer.byteLength(fileBytes),
    bytes: fileBytes,
    platformBodyReads: 0,
  });

  const chunkBytes = Buffer.from("exact non-empty chunk bytes");
  const chunk = await fetch(
    `${origin}/api/backend?__path=upload-sessions%2Fsession%2Fparts%2F1`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunkBytes,
    },
  );
  assert.equal(chunk.status, 200);
  assert.deepEqual(await chunk.json(), {
    size: chunkBytes.length,
    bytes: chunkBytes.toString(),
    platformBodyReads: 0,
  });
});

test("ordinary JSON requests still expose their parsed body to API validation", () => {
  const req = {
    headers: { "content-type": "application/json" },
    body: { faculty_id: "flaa" },
  };
  assert.equal(requestBodyForValidation(req), req.body);
  assert.equal(req.body.faculty_id, "flaa");
});
