import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";

const navigationTimeout = positiveInteger("LOOK_SCRIBD_BROWSER_TIMEOUT_MS", 60_000, 10_000);
const pageLoadTimeout = positiveInteger("LOOK_SCRIBD_PAGE_LOAD_TIMEOUT_MS", 120_000, 10_000);
const renderSettleTimeout = positiveInteger("LOOK_SCRIBD_RENDER_SETTLE_TIMEOUT_MS", 30_000, 1_000);
const exportBatchSize = positiveInteger("LOOK_SCRIBD_EXPORT_BATCH_SIZE", 8, 1);
const pdfStreamChunkSize = 1024 * 1024;

export type BrowserDownload = {
  fileName: string;
  fileSize: number;
  format: string;
};

export type BrowserProgress = (progress: number, step: string, log?: string) => Promise<void>;

type PageGeometry = {
  width: number;
  height: number;
};

type BatchLoadResult = {
  supported: boolean;
  failed: Array<{ pageNum: number; reason: string }>;
};

type ScribdRuntimePage = {
  pageNum: number;
  innerPageElem?: HTMLElement | null;
  loadHasStarted?: boolean;
  _imagesTurnedOn?: boolean;
  load: () => void;
  display: () => void;
  turnOnImages: () => void;
  remove: () => void;
};

type ScribdRuntimeWindow = Window & {
  docManager?: {
    pages: Record<number, ScribdRuntimePage | undefined>;
  };
};

function positiveInteger(name: string, fallback: number, minimum: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Canceled", "AbortError");
}

export async function findBrowserExecutable(): Promise<string> {
  const candidates = [
    process.env.LOOK_SCRIBD_BROWSER_PATH,
    chromium.executablePath(),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new Error("Chromium est introuvable. Définissez LOOK_SCRIBD_BROWSER_PATH ou utilisez l’image Docker fournie.");
}

export function toScribdEmbedUrl(input: string): string {
  const url = new URL(input);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean);
  const supportedPath = ["document", "doc", "presentation"].includes(segments[0]);
  if (host !== "scribd.com" || !supportedPath || !/^\d+$/.test(segments[1] || "")) {
    throw new Error("Le lien Scribd ne contient pas d’identifiant de document exploitable.");
  }
  return "https://www.scribd.com/embeds/" + segments[1] + "/content";
}

function safePdfFilename(value: string, fallback: string): string {
  let decoded = value;
  try { decoded = decodeURIComponent(decoded); } catch { /* Le segment encodé reste exploitable. */ }
  const clean = decoded.normalize("NFKC")
    .replace(/\.pdf$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 156);
  return (clean || fallback) + ".pdf";
}

function outputFilename(input: string): string {
  const url = new URL(input);
  const segments = url.pathname.split("/").filter(Boolean);
  const fallback = "scribd-" + (segments[1] || Date.now());
  return safePdfFilename(segments.slice(2).join("-") || fallback, fallback);
}

async function prepareDocument(page: Page): Promise<number> {
  return page.evaluate(() => {
    const removableSelectors = [
      ".toolbar_top",
      ".toolbar_bottom",
      "[class*='cookie']",
      "[class*='Cookie']",
      "[class*='consent']",
      "[class*='Consent']",
      "[class*='gdpr']",
      "[class*='privacy-notice']",
      "[class*='notice-banner']",
      "[id*='cookie']",
      "[id*='consent']",
      "[class*='osano-cm']",
      "[id*='osano']",
    ];
    for (const selector of removableSelectors) {
      document.querySelectorAll(selector).forEach((element) => element.remove());
    }

    document.querySelectorAll(".document_scroller").forEach((element) => {
      element.setAttribute("data-scribd-print-root", "true");
    });

    document.getElementById("look-scribd-print-styles")?.remove();
    const style = document.createElement("style");
    style.id = "look-scribd-print-styles";
    style.textContent = [
      "[data-scribd-print-root='true'], .document_scroller {",
      "  position: static !important;",
      "  inset: auto !important;",
      "  overflow: visible !important;",
      "  height: auto !important;",
      "  max-height: none !important;",
      "  margin: 0 !important;",
      "  padding: 0 !important;",
      "}",
      "@media print {",
      "  html, body {",
      "    margin: 0 !important;",
      "    padding: 0 !important;",
      "    -webkit-print-color-adjust: exact !important;",
      "    print-color-adjust: exact !important;",
      "  }",
      "  .toolbar_top, .toolbar_bottom { display: none !important; }",
      "  mjx-container, .MathJax, .katex, math, svg {",
      "    visibility: visible !important;",
      "    overflow: visible !important;",
      "  }",
      "}",
    ].join("\n");
    document.head.appendChild(style);

    return document.querySelectorAll(".outer_page").length;
  });
}

async function loadPageBatch(page: Page, pageNumbers: number[]): Promise<void> {
  const result = await page.evaluate<BatchLoadResult, { pageNumbers: number[]; timeoutMs: number }>(
    async ({ pageNumbers: requestedPages, timeoutMs }) => {
      const manager = (window as ScribdRuntimeWindow).docManager;
      if (!manager?.pages) return { supported: false, failed: [] };

      const states = requestedPages.map((pageNum) => ({
        pageNum,
        page: manager.pages[pageNum],
        error: undefined as string | undefined,
      }));
      const startedAt = Date.now();

      for (const state of states) {
        if (!state.page) {
          state.error = "page object missing";
          continue;
        }
        try {
          if (!state.page.innerPageElem && !state.page.loadHasStarted) state.page.load();
        } catch (error) {
          state.error = String(error);
        }
      }

      return new Promise<BatchLoadResult>((resolve) => {
        const timer = window.setInterval(() => {
          let ready = 0;
          for (const state of states) {
            if (state.error) {
              ready += 1;
              continue;
            }
            const runtimePage = state.page;
            if (!runtimePage?.innerPageElem) continue;
            try {
              runtimePage.display();
              if (!runtimePage._imagesTurnedOn) runtimePage.turnOnImages();
            } catch (error) {
              state.error = String(error);
              ready += 1;
              continue;
            }
            const images = Array.from(runtimePage.innerPageElem.querySelectorAll("img"));
            if (images.every((image) => image.complete)) ready += 1;
          }

          const timedOut = Date.now() - startedAt >= timeoutMs;
          if (ready !== states.length && !timedOut) return;

          if (timedOut) {
            for (const state of states) {
              if (state.error) continue;
              const runtimePage = state.page;
              if (!runtimePage?.innerPageElem) {
                state.error = "page load timed out";
              } else if (Array.from(runtimePage.innerPageElem.querySelectorAll("img")).some((image) => !image.complete)) {
                state.error = "image load timed out";
              }
            }
          }

          window.clearInterval(timer);
          resolve({
            supported: true,
            failed: states
              .filter((state) => state.error)
              .map((state) => ({ pageNum: state.pageNum, reason: state.error || "unknown error" })),
          });
        }, 50);
      });
    },
    { pageNumbers, timeoutMs: pageLoadTimeout },
  );

  if (!result.supported) throw new Error("Le chargeur de pages interne de Scribd n’est pas disponible.");
  if (result.failed.length) {
    const details = result.failed.map(({ pageNum, reason }) => pageNum + " (" + reason + ")").join(", ");
    throw new Error("Échec du chargement des pages Scribd : " + details + ".");
  }
}

async function isolatePageForPrint(page: Page, pageIndex: number): Promise<PageGeometry> {
  const geometry = await page.evaluate<PageGeometry | null, number>((targetIndex) => {
    const pages = Array.from(document.querySelectorAll<HTMLElement>(".outer_page"));
    const target = pages[targetIndex];
    if (!target) return null;

    document.getElementById("look-scribd-isolated-page")?.remove();
    pages.forEach((candidate) => candidate.removeAttribute("data-export-target"));
    target.setAttribute("data-export-target", "true");

    const rect = target.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    if (width <= 0 || height <= 0) return null;

    const style = document.createElement("style");
    style.id = "look-scribd-isolated-page";
    style.textContent = [
      "@page { size: " + width + "px " + height + "px; margin: 0; }",
      "@media print {",
      "  html, body {",
      "    width: " + width + "px !important;",
      "    height: " + height + "px !important;",
      "    min-width: " + width + "px !important;",
      "    min-height: " + height + "px !important;",
      "    max-width: " + width + "px !important;",
      "    max-height: " + height + "px !important;",
      "    margin: 0 !important;",
      "    padding: 0 !important;",
      "    overflow: hidden !important;",
      "  }",
      "  .outer_page { display: none !important; }",
      "  .outer_page[data-export-target='true'] {",
      "    display: block !important;",
      "    visibility: visible !important;",
      "    position: absolute !important;",
      "    inset: 0 auto auto 0 !important;",
      "    width: " + width + "px !important;",
      "    height: " + height + "px !important;",
      "    min-width: 0 !important;",
      "    min-height: 0 !important;",
      "    max-width: none !important;",
      "    max-height: none !important;",
      "    margin: 0 !important;",
      "    padding: 0 !important;",
      "    transform: none !important;",
      "    break-before: auto !important;",
      "    break-after: auto !important;",
      "    break-inside: auto !important;",
      "    overflow: hidden !important;",
      "  }",
      "}",
    ].join("\n");
    document.head.appendChild(style);
    return { width, height };
  }, pageIndex);

  if (!geometry) throw new Error("La page " + (pageIndex + 1) + " n’a pas de dimensions imprimables.");
  return geometry;
}

async function waitForRenderStability(page: Page): Promise<void> {
  await page.evaluate(async (timeoutMs) => {
    await (document.fonts?.ready || Promise.resolve()).catch(() => undefined);
    const deadline = performance.now() + timeoutMs;
    let stableTicks = 0;
    let previous = "";

    while (stableTicks < 2 && performance.now() < deadline) {
      const target = document.querySelector<HTMLElement>(".outer_page[data-export-target='true']");
      const rect = target?.getBoundingClientRect() || { width: 0, height: 0 };
      const pendingImages = target
        ? Array.from(target.querySelectorAll<HTMLImageElement>("img")).filter((image) => !image.complete).length
        : 0;
      const sample = JSON.stringify({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        pendingImages,
      });
      stableTicks = pendingImages === 0 && sample === previous ? stableTicks + 1 : 0;
      previous = sample;
      if (stableTicks < 2) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
      }
    }
  }, renderSettleTimeout);
}

async function writeCdpStream(session: CDPSession, stream: string, destination: string, maxBytes: number): Promise<number> {
  const handle = await fs.open(destination, "wx");
  let written = 0;
  try {
    while (true) {
      const chunk = await session.send("IO.read", { handle: stream, size: pdfStreamChunkSize });
      const buffer = chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : Buffer.from(chunk.data, "utf8");
      written += buffer.length;
      if (written > maxBytes) throw new Error("Le PDF dépasse la taille maximale autorisée.");
      if (buffer.length) await handle.write(buffer);
      if (chunk.eof) break;
    }
  } finally {
    await handle.close();
    await session.send("IO.close", { handle: stream }).catch(() => undefined);
  }
  return written;
}

async function printPageToFile(
  session: CDPSession,
  geometry: PageGeometry,
  destination: string,
  maxBytes: number,
): Promise<number> {
  const result = await session.send("Page.printToPDF", {
    landscape: false,
    displayHeaderFooter: false,
    printBackground: true,
    scale: 1,
    paperWidth: geometry.width / 96,
    paperHeight: geometry.height / 96,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    preferCSSPageSize: true,
    pageRanges: "1",
    transferMode: "ReturnAsStream",
  });

  if (result.stream) return writeCdpStream(session, result.stream, destination, maxBytes);
  const buffer = Buffer.from(result.data || "", "base64");
  if (!buffer.length) throw new Error("Chromium n’a produit aucune donnée PDF.");
  if (buffer.length > maxBytes) throw new Error("Le PDF dépasse la taille maximale autorisée.");
  await fs.writeFile(destination, buffer, { flag: "wx" });
  return buffer.length;
}

async function assertSinglePagePdf(filePath: string, pageNumber: number): Promise<void> {
  const document = await PDFDocument.load(await fs.readFile(filePath));
  if (document.getPageCount() !== 1) {
    throw new Error(
      "La page Scribd " + pageNumber + " a produit " + document.getPageCount() + " feuilles PDF au lieu d’une.",
    );
  }
}

async function releasePageBatch(page: Page, session: CDPSession, pageNumbers: number[]): Promise<void> {
  await page.evaluate((releasedPages) => {
    const manager = (window as ScribdRuntimeWindow).docManager;
    if (!manager?.pages) return;
    for (const pageNum of releasedPages) {
      const runtimePage = manager.pages[pageNum];
      if (!runtimePage) continue;
      try {
        runtimePage.remove();
      } catch {
        document.getElementById("outer_page_" + pageNum)?.querySelector(".newpage")?.remove();
      }
    }
  }, pageNumbers);
  await session.send("HeapProfiler.collectGarbage").catch(() => undefined);
}

async function mergePdfPages(pageFiles: string[], maxFileBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const pageFile of pageFiles) {
    throwIfAborted(signal);
    const source = await PDFDocument.load(await fs.readFile(pageFile));
    const [copiedPage] = await merged.copyPages(source, [0]);
    merged.addPage(copiedPage);
  }
  throwIfAborted(signal);
  const bytes = await merged.save({ useObjectStreams: true });
  if (bytes.length > maxFileBytes) throw new Error("Le PDF final dépasse la taille maximale autorisée.");
  return bytes;
}

export async function exportRenderedDocumentWithPlaywright(options: {
  pageUrl: string;
  fileName: string;
  outputDirectory: string;
  maxFileBytes: number;
  signal: AbortSignal;
  onProgress: BrowserProgress;
}): Promise<BrowserDownload> {
  const { pageUrl, outputDirectory, maxFileBytes, signal, onProgress } = options;
  const fileName = safePdfFilename(options.fileName, "document");
  const executablePath = await findBrowserExecutable();
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "look-scribd-export-"));
  let browser: Browser | undefined;

  const closeOnAbort = () => { void browser?.close(); };
  signal.addEventListener("abort", closeOnAbort, { once: true });

  try {
    throwIfAborted(signal);
    await onProgress(18, "Démarrage du navigateur", "Chromium démarre pour rendre l’aperçu Scribd.");
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu",
        "--force-color-profile=srgb",
        "--hide-scrollbars",
      ],
    });

    const context = await browser.newContext({ locale: "fr-FR", viewport: { width: 1600, height: 2200 } });
    const page = await context.newPage();
    page.setDefaultTimeout(navigationTimeout);

    await onProgress(28, "Ouverture de l’aperçu", "Playwright ouvre la version intégrée du document.");
    const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeout });
    if (response && response.status() >= 400) {
      throw new Error("Scribd a répondu " + response.status() + " dans le navigateur.");
    }
    await page.locator(".outer_page").first().waitFor({ state: "attached", timeout: navigationTimeout });

    const pageCount = await prepareDocument(page);
    if (pageCount <= 0) throw new Error("Aucune page Scribd imprimable n’a été détectée.");
    const plural = pageCount > 1 ? "s" : "";
    await onProgress(35, "Analyse du document", pageCount + " page" + plural + " détectée" + plural + ".");

    const session = await context.newCDPSession(page);
    await session.send("Page.enable");
    await session.send("Emulation.setEmulatedMedia", { media: "print" });
    const pageFiles: string[] = [];
    let spooledBytes = 0;

    for (let batchStart = 0; batchStart < pageCount; batchStart += exportBatchSize) {
      throwIfAborted(signal);
      const batchEnd = Math.min(pageCount, batchStart + exportBatchSize);
      const pageNumbers = Array.from({ length: batchEnd - batchStart }, (_, index) => batchStart + index + 1);
      await onProgress(
        35 + (batchStart / pageCount) * 48,
        "Chargement des pages",
        "Chargement du lot " + (batchStart + 1) + "–" + batchEnd + "/" + pageCount + ".",
      );
      await loadPageBatch(page, pageNumbers);

      for (const pageNumber of pageNumbers) {
        throwIfAborted(signal);
        const geometry = await isolatePageForPrint(page, pageNumber - 1);
        await waitForRenderStability(page);
        const pageFile = path.join(temporaryRoot, "page-" + String(pageNumber).padStart(8, "0") + ".pdf");
        const remainingBytes = maxFileBytes - spooledBytes;
        if (remainingBytes <= 0) throw new Error("Le PDF dépasse la taille maximale autorisée.");
        spooledBytes += await printPageToFile(session, geometry, pageFile, remainingBytes);
        await assertSinglePagePdf(pageFile, pageNumber);
        pageFiles.push(pageFile);
        await onProgress(35 + (pageNumber / pageCount) * 48, "Export des pages");
      }

      await releasePageBatch(page, session, pageNumbers);
    }

    throwIfAborted(signal);
    const pagePlural = pageFiles.length > 1 ? "s" : "";
    await onProgress(88, "Assemblage du PDF", "Fusion de " + pageFiles.length + " page" + pagePlural + ".");
    const mergedPdf = await mergePdfPages(pageFiles, maxFileBytes, signal);
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(path.join(outputDirectory, fileName), mergedPdf, { flag: "wx" });
    return { fileName, fileSize: mergedPdf.length, format: "PDF" };
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await browser?.close().catch(() => undefined);
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function downloadWithPlaywright(options: {
  url: string;
  outputDirectory: string;
  maxFileBytes: number;
  signal: AbortSignal;
  onProgress: BrowserProgress;
}): Promise<BrowserDownload> {
  return exportRenderedDocumentWithPlaywright({
    pageUrl: toScribdEmbedUrl(options.url),
    fileName: outputFilename(options.url),
    outputDirectory: options.outputDirectory,
    maxFileBytes: options.maxFileBytes,
    signal: options.signal,
    onProgress: options.onProgress,
  });
}
