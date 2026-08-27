import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { downloadFastScribd, extractExpectedPageCount, extractFastImageUrls, type FastFetcher } from "./fast-extractor.js";

const tinyJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/wAALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVL//2Q==",
  "base64",
);

const documentUrl = "https://www.scribd.com/document/123/example";
const firstImageUrl = "https://html.scribdassets.com/images/first.jpg?token=one";
const secondJsonpUrl = "https://html.scribdassets.com/pages/second.jsonp?token=two";
const secondImageUrl = "https://html.scribdassets.com/images/second.jpg?token=two";
const html = `
  <html><body>
    <img class="page absimg loaded" src="${firstImageUrl.replace("&", "&amp;")}">
    <script>window.page = "${secondJsonpUrl.replaceAll("/", "\\/")}";</script>
    <img class="other" src="https://example.com/ignored.jpg">
    <script type="application/json">{"id":123,"page_count":2}</script>
  </body></html>
`;

test("extractFastImageUrls reproduit les ressources absimg et JSONP dans l’ordre", () => {
  assert.deepEqual(extractFastImageUrls(html, documentUrl), [firstImageUrl, secondImageUrl]);
});

test("extractExpectedPageCount cible les métadonnées du bon document", () => {
  assert.equal(extractExpectedPageCount(html, documentUrl), 2);
});

test("downloadFastScribd construit un PDF ordonné sans navigateur", async () => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "look-scribd-fast-test-"));
  const requested: string[] = [];
  const progress: string[] = [];
  const fetcher: FastFetcher = async (url) => {
    requested.push(url);
    if (url === documentUrl) return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    if (url === firstImageUrl || url === secondImageUrl) {
      return new Response(tinyJpeg, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(tinyJpeg.length) } });
    }
    return new Response("missing", { status: 404 });
  };

  try {
    const result = await downloadFastScribd({
      url: documentUrl,
      outputDirectory,
      outputFilename: "Document de test",
      maxFileBytes: 1024 * 1024,
      signal: new AbortController().signal,
      fetcher,
      onProgress: async (_percentage, step, log) => { progress.push(log ? `${step}: ${log}` : step); },
    });

    assert.equal(result.fileName, "Document de test.pdf");
    assert.equal(result.format, "PDF");
    assert.equal(result.pageCount, 2);
    assert.ok(result.fileSize > tinyJpeg.length * 2);
    assert.deepEqual(new Set(requested), new Set([documentUrl, firstImageUrl, secondImageUrl]));
    assert.ok(progress.some((entry) => entry.includes("2 pages trouvées")));

    const pdf = await PDFDocument.load(await fs.readFile(path.join(outputDirectory, result.fileName)));
    assert.equal(pdf.getPageCount(), 2);
  } finally {
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }
});

test("downloadFastScribd échoue proprement quand Scribd n’expose aucune page", async () => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "look-scribd-fast-empty-"));
  try {
    await assert.rejects(
      downloadFastScribd({
        url: documentUrl,
        outputDirectory,
        outputFilename: "vide",
        maxFileBytes: 1024 * 1024,
        signal: new AbortController().signal,
        fetcher: async () => new Response("<html></html>", { status: 200 }),
        onProgress: async () => undefined,
      }),
      /Aucune image de page/,
    );
    assert.deepEqual(await fs.readdir(outputDirectory), []);
  } finally {
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }
});
