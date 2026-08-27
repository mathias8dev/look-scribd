import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  exportRenderedDocumentWithPlaywright,
  findBrowserExecutable,
  toScribdEmbedUrl,
} from "./browser.js";

test("convertit les URL Scribd vers la version intégrée", () => {
  assert.equal(
    toScribdEmbedUrl("https://www.scribd.com/document/123456789/Document-Title"),
    "https://www.scribd.com/embeds/123456789/content",
  );
  assert.equal(
    toScribdEmbedUrl("https://scribd.com/presentation/42/Slides"),
    "https://www.scribd.com/embeds/42/content",
  );
  assert.throws(() => toScribdEmbedUrl("https://example.com/document/42/Slides"));
});

test("Playwright rend et fusionne les pages du document", async (context) => {
  try {
    await findBrowserExecutable();
  } catch {
    context.skip("Aucun navigateur compatible n’est installé.");
    return;
  }

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "look-scribd-browser-"));
  const outputDirectory = path.join(temporaryRoot, "output");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end([
      "<!doctype html>",
      "<html>",
      "<head>",
      "<style>",
      "html, body { margin: 0; padding: 0; }",
      ".document_scroller { width: 320px; }",
      ".outer_page { box-sizing: border-box; width: 320px; height: 480px; overflow: hidden; background: white; }",
      ".newpage { box-sizing: border-box; width: 100%; height: 100%; padding: 32px; color: #111; font: 24px sans-serif; }",
      "</style>",
      "</head>",
      "<body>",
      "<div class='toolbar_top'>Toolbar</div>",
      "<main class='document_scroller'>",
      "<section class='outer_page' id='outer_page_1'><div class='newpage'>Première page</div></section>",
      "<section class='outer_page' id='outer_page_2'><div class='newpage'>Deuxième page</div></section>",
      "</main>",
      "<script>",
      "const makePage = (pageNum) => ({",
      "  pageNum,",
      "  innerPageElem: document.querySelector('#outer_page_' + pageNum + ' .newpage'),",
      "  loadHasStarted: true,",
      "  _imagesTurnedOn: true,",
      "  load() {},",
      "  display() {},",
      "  turnOnImages() { this._imagesTurnedOn = true; },",
      "  remove() {",
      "    if (this.innerPageElem) this.innerPageElem.remove();",
      "    this.innerPageElem = null;",
      "  }",
      "});",
      "window.docManager = { pages: { 1: makePage(1), 2: makePage(2) } };",
      "</script>",
      "</body>",
      "</html>",
    ].join("\n"));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  const address = server.address();
  assert(address && typeof address !== "string");
  const steps: string[] = [];
  const result = await exportRenderedDocumentWithPlaywright({
    pageUrl: "http://127.0.0.1:" + address.port,
    fileName: "Fixture export.pdf",
    outputDirectory,
    maxFileBytes: 10 * 1024 * 1024,
    signal: new AbortController().signal,
    onProgress: async (_progress, step) => { steps.push(step); },
  });

  assert.equal(result.fileName, "Fixture export.pdf");
  assert.equal(result.format, "PDF");
  assert(result.fileSize > 0);
  const output = await fs.readFile(path.join(outputDirectory, result.fileName));
  assert.equal(output.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal((await PDFDocument.load(output)).getPageCount(), 2);
  assert(steps.includes("Export des pages"));
  assert(steps.includes("Assemblage du PDF"));
});
