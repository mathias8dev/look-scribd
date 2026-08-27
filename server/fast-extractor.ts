import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";

export type FastDownload = {
  fileName: string;
  fileSize: number;
  format: string;
  pageCount: number;
};

export type FastProgress = (progress: number, step: string, log?: string) => Promise<void>;
export type FastFetcher = (url: string, signal: AbortSignal) => Promise<Response>;

type FastDownloadOptions = {
  url: string;
  outputDirectory: string;
  outputFilename: string;
  maxFileBytes: number;
  signal: AbortSignal;
  onProgress: FastProgress;
  fetcher?: FastFetcher;
};

type DownloadedImage = {
  filePath: string;
  width: number;
  height: number;
};

const maxHtmlBytes = 10 * 1024 * 1024;
const downloadConcurrency = positiveInteger("LOOK_SCRIBD_FAST_CONCURRENCY", 10, 1, 32);

function positiveInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.floor(parsed))) : fallback;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Canceled", "AbortError");
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1" || /^fe[89ab]/.test(normalized) || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && [18, 19].includes(parts[1]));
  }
  return false;
}

function isScribdHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "scribd.com" || host.endsWith(".scribd.com") || host === "scribdassets.com" || host.endsWith(".scribdassets.com");
}

async function assertScribdTarget(url: URL): Promise<void> {
  if (url.protocol !== "https:" || !isScribdHost(url.hostname)) {
    throw new Error("Une ressource rapide pointe vers une destination non autorisée.");
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Une ressource rapide pointe vers une adresse réseau privée.");
  }
}

async function fetchScribdResource(initialUrl: string, signal: AbortSignal): Promise<Response> {
  let current = new URL(initialUrl);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    await assertScribdTarget(current);
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal,
          headers: {
            accept: "*/*",
            // Scribd expose son HTML statique aux clients HTTP simples, alors qu’un UA navigateur reçoit un challenge JavaScript.
            "user-agent": "python-requests/2.32.5",
          },
        });
        break;
      } catch (error) {
        if (signal.aborted || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
    if (!response) throw new Error("Scribd ne répond pas à l’extracteur rapide.");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("La redirection Scribd est incomplète.");
      await response.body?.cancel();
      current = new URL(location, current);
      continue;
    }
    return response;
  }
  throw new Error("La ressource Scribd contient trop de redirections.");
}

function decodeHtml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|quot|apos|lt|gt);/gi, (entity, code: string) => {
    const named: Record<string, string> = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">" };
    const normalized = code.toLowerCase();
    if (named[normalized]) return named[normalized];
    const hex = normalized.startsWith("#x");
    const parsed = Number.parseInt(normalized.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s'\"=<>`]+))", "i"));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

function toImageUrl(jsonpUrl: string): string | undefined {
  try {
    const url = new URL(jsonpUrl);
    if (!url.pathname.includes("/pages/") || !url.pathname.endsWith(".jsonp")) return undefined;
    url.pathname = url.pathname.replace("/pages/", "/images/").replace(/\.jsonp$/i, ".jpg");
    return url.toString();
  } catch {
    return undefined;
  }
}

export function extractFastImageUrls(html: string, documentUrl: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const classes = attribute(tag, "class")?.split(/\s+/) || [];
    const source = attribute(tag, "src");
    if (!classes.includes("absimg") || !source) continue;
    try { urls.push(new URL(source, documentUrl).toString()); } catch { /* La ressource invalide est ignorée. */ }
  }

  const normalizedScripts = decodeHtml(html)
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\\//g, "/");
  for (const match of normalizedScripts.matchAll(/https:\/\/[^"'\\\s<>]+?\.jsonp(?:\?[^"'\\\s<>]*)?/gi)) {
    const imageUrl = toImageUrl(match[0]);
    if (imageUrl) urls.push(imageUrl);
  }
  return [...new Set(urls)];
}

export function extractExpectedPageCount(html: string, documentUrl: string): number | undefined {
  const segments = new URL(documentUrl).pathname.split("/").filter(Boolean);
  const documentId = segments.find((segment, index) => index > 0 && /^\d+$/.test(segment));
  if (!documentId) return undefined;
  const escapedId = documentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const afterId = html.match(new RegExp(`"id"\\s*:\\s*${escapedId}[\\s\\S]{0,2000}?"page_count"\\s*:\\s*(\\d+)`));
  const beforeId = html.match(new RegExp(`"page_count"\\s*:\\s*(\\d+)[\\s\\S]{0,2000}?"id"\\s*:\\s*${escapedId}`));
  const parsed = Number(afterId?.[1] || beforeId?.[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw new Error("Une page rapide n’est pas une image JPEG valide.");
  }
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (startOfFrameMarkers.has(marker)) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width > 0 && height > 0) return { width, height };
    }
    offset += length;
  }
  throw new Error("Les dimensions d’une page JPEG sont illisibles.");
}

async function downloadImage(
  url: string,
  filePath: string,
  signal: AbortSignal,
  fetcher: FastFetcher,
  accountBytes: (length: number) => void,
): Promise<DownloadedImage> {
  throwIfAborted(signal);
  const response = await fetcher(url, signal);
  if (!response.ok) throw new Error(`Une page Scribd a répondu ${response.status}.`);
  const announcedSize = Number(response.headers.get("content-length") || 0);
  if (announcedSize > 0 && announcedSize > 500 * 1024 * 1024) throw new Error("Une page Scribd est anormalement volumineuse.");
  const buffer = Buffer.from(await response.arrayBuffer());
  accountBytes(buffer.length);
  const dimensions = jpegDimensions(buffer);
  await fs.writeFile(filePath, buffer, { flag: "wx" });
  return { filePath, ...dimensions };
}

async function writePdf(images: DownloadedImage[], outputPath: string, signal: AbortSignal, onProgress: FastProgress): Promise<void> {
  const document = new PDFDocument({ autoFirstPage: false, compress: true, margin: 0 });
  const writer = createWriteStream(outputPath, { flags: "wx" });
  const outcome = new Promise<void>((resolve, reject) => {
    writer.once("finish", resolve);
    writer.once("error", reject);
    document.once("error", reject);
  });
  document.pipe(writer);
  try {
    for (let index = 0; index < images.length; index += 1) {
      throwIfAborted(signal);
      const image = images[index];
      const width = image.width * 0.75;
      const height = image.height * 0.75;
      document.addPage({ size: [width, height], margin: 0 });
      document.image(image.filePath, 0, 0, { width, height });
      if ((index + 1) % 20 === 0 || index === images.length - 1) {
        await onProgress(78 + ((index + 1) / images.length) * 15, "Assemblage du PDF");
      }
    }
    document.end();
    await outcome;
  } catch (error) {
    writer.destroy();
    throw error;
  }
}

function safePdfFilename(value: string): string {
  const clean = value.normalize("NFKC").replace(/\.pdf$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 156);
  return (clean || `scribd-${Date.now()}`) + ".pdf";
}

export async function downloadFastScribd(options: FastDownloadOptions): Promise<FastDownload> {
  const fetcher = options.fetcher || fetchScribdResource;
  const temporaryDirectory = await fs.mkdtemp(path.join(tmpdir(), "look-scribd-fast-"));
  const outputFilename = safePdfFilename(options.outputFilename);
  const outputPath = path.join(options.outputDirectory, outputFilename);
  let accountedBytes = 0;
  try {
    throwIfAborted(options.signal);
    await options.onProgress(15, "Analyse rapide", "Recherche directe des images Scribd.");
    const pageResponse = await fetcher(options.url, options.signal);
    if (!pageResponse.ok) throw new Error(`La page Scribd a répondu ${pageResponse.status}.`);
    const announcedHtmlSize = Number(pageResponse.headers.get("content-length") || 0);
    if (announcedHtmlSize > maxHtmlBytes) throw new Error("La page Scribd est trop volumineuse pour l’extracteur rapide.");
    const html = await pageResponse.text();
    if (Buffer.byteLength(html) > maxHtmlBytes) throw new Error("La page Scribd est trop volumineuse pour l’extracteur rapide.");
    const imageUrls = extractFastImageUrls(html, options.url);
    if (!imageUrls.length) throw new Error("Aucune image de page n’a été exposée par Scribd.");
    const expectedPageCount = extractExpectedPageCount(html, options.url);
    if (expectedPageCount && imageUrls.length !== expectedPageCount) {
      throw new Error(`Extraction rapide incomplète : ${imageUrls.length} page(s) sur ${expectedPageCount}.`);
    }
    await options.onProgress(20, "Pages détectées", `${imageUrls.length} page${imageUrls.length > 1 ? "s" : ""} trouvée${imageUrls.length > 1 ? "s" : ""} par l’extracteur rapide.`);

    const images = new Array<DownloadedImage>(imageUrls.length);
    let cursor = 0;
    let completed = 0;
    let progressQueue = Promise.resolve();
    const accountBytes = (length: number) => {
      accountedBytes += length;
      if (accountedBytes > options.maxFileBytes) throw new Error("Les pages dépassent la taille maximale autorisée.");
    };
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= imageUrls.length) return;
        const filePath = path.join(temporaryDirectory, `page-${String(index + 1).padStart(6, "0")}.jpg`);
        images[index] = await downloadImage(imageUrls[index], filePath, options.signal, fetcher, accountBytes);
        completed += 1;
        if (completed % 5 === 0 || completed === imageUrls.length) {
          const current = completed;
          progressQueue = progressQueue.then(() => options.onProgress(20 + (current / imageUrls.length) * 56, "Téléchargement rapide"));
          await progressQueue;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(downloadConcurrency, imageUrls.length) }, worker));

    await fs.mkdir(options.outputDirectory, { recursive: true });
    await options.onProgress(78, "Assemblage du PDF", "Toutes les pages sont téléchargées ; création du PDF.");
    await writePdf(images, outputPath, options.signal, options.onProgress);
    const fileSize = (await fs.stat(outputPath)).size;
    if (fileSize > options.maxFileBytes) throw new Error("Le PDF produit dépasse la taille maximale autorisée.");
    return { fileName: outputFilename, fileSize, format: "PDF", pageCount: images.length };
  } catch (error) {
    await fs.rm(outputPath, { force: true });
    throw error;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
