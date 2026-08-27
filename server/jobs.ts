import { once } from "node:events";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  findJob,
  findJobs,
  insertJob,
  recoverInterruptedJobs,
  removeJobRecord,
  saveJob,
} from "./db.js";
import { downloadWithPlaywright } from "./browser.js";
import { downloadFastScribd } from "./fast-extractor.js";
import type { DocumentJob, ExtractorMode, ParsedDocument } from "./types.js";

const downloadRoot = process.env.LOOK_SCRIBD_DOWNLOAD_DIR || path.join(process.cwd(), "downloads");
const maxConcurrent = Math.max(1, Number(process.env.LOOK_SCRIBD_MAX_CONCURRENT || 2));
const maxFileBytes = Math.max(1, Number(process.env.LOOK_SCRIBD_MAX_FILE_MB || 500)) * 1024 * 1024;
const supportedExtensions = new Set(["pdf", "doc", "docx", "ppt", "pptx", "txt", "epub"]);
const queue: string[] = [];
const running = new Set<string>();
const controllers = new Map<string, AbortController>();

function now(): string {
  return new Date().toISOString();
}

function readableTitle(value: string): string {
  const clean = value.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.split(" ").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") : "Document sans titre";
}

function safeFilename(value: string): string {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* Le nom encodé brut reste exploitable. */ }
  const clean = decoded.normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  return clean || `document-${Date.now()}.pdf`;
}

export function parseExtractorMode(input: unknown): ExtractorMode {
  if (input === undefined || input === null || input === "") return "auto";
  if (input === "auto" || input === "fast" || input === "browser") return input;
  throw new Error("L’extracteur demandé n’est pas reconnu.");
}

export function parseDocumentUrl(input: unknown): ParsedDocument {
  if (typeof input !== "string" || !input.trim()) throw new Error("Ajoutez un lien de document.");

  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Le lien fourni n’est pas valide.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Seuls les liens HTTP et HTTPS sont acceptés.");

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean);
  const scribdType = segments[0];

  if (host === "scribd.com" && ["document", "doc", "presentation"].includes(scribdType) && /^\d+$/.test(segments[1] || "")) {
    return {
      url: url.toString(),
      kind: "scribd",
      source: "Scribd",
      title: readableTitle(segments.slice(2).join("-")),
      format: scribdType === "presentation" ? "Présentation" : "Document",
      actionUrl: url.toString(),
    };
  }

  const filename = segments.at(-1) || "document";
  const extension = filename.split(".").at(-1)?.toLowerCase() || "";
  if (!supportedExtensions.has(extension)) {
    throw new Error("Utilisez un lien Scribd compatible ou une URL directe PDF, DOCX, PPTX, TXT ou EPUB.");
  }

  return {
    url: url.toString(),
    kind: "direct",
    source: host,
    title: readableTitle(filename),
    format: extension.toUpperCase(),
  };
}

async function setJob(job: DocumentJob, progress: number, currentStep: string, log?: string): Promise<void> {
  job.progress = Math.max(job.progress, Math.min(100, progress));
  job.currentStep = currentStep;
  job.updatedAt = now();
  if (log) job.logs.push(`${new Date().toLocaleTimeString("fr-FR")} · ${log}`);
  await saveJob(job);
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

async function assertPublicTarget(url: URL): Promise<void> {
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("Les adresses locales ne sont pas acceptées.");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Cette destination réseau n’est pas autorisée.");
}

async function fetchPublicFile(initialUrl: string, signal: AbortSignal): Promise<Response> {
  let current = new URL(initialUrl);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    await assertPublicTarget(current);
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal,
          headers: { "user-agent": "LookScribd/0.2 (+public-document-downloader)" },
        });
        break;
      } catch (error) {
        if (signal.aborted || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
    if (!response) throw new Error("La source distante ne répond pas.");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("La redirection distante est incomplète.");
      await response.body?.cancel();
      current = new URL(location, current);
      continue;
    }
    return response;
  }
  throw new Error("Le lien contient trop de redirections.");
}

async function processDirectJob(job: DocumentJob, signal: AbortSignal): Promise<void> {
  await setJob(job, 8, "Connexion à la source", "Connexion au serveur distant.");
  const response = await fetchPublicFile(job.url, signal);
  if (!response.ok || !response.body) throw new Error(`Le serveur distant a répondu ${response.status}.`);

  const announcedSize = Number(response.headers.get("content-length") || 0);
  if (announcedSize > maxFileBytes) throw new Error("Le fichier dépasse la taille maximale autorisée.");

  const urlName = new URL(response.url || job.url).pathname.split("/").filter(Boolean).at(-1) || `${job.title}.${job.format.toLowerCase()}`;
  let fileName = safeFilename(urlName);
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  if (!extension || !supportedExtensions.has(extension)) fileName += `.${job.format.toLowerCase()}`;
  const outputDirectory = path.join(downloadRoot, job.id);
  const outputPath = path.join(outputDirectory, fileName);
  await fs.mkdir(outputDirectory, { recursive: true });
  await setJob(job, 15, "Téléchargement", `Téléchargement de ${fileName}.`);

  const writer = createWriteStream(outputPath, { flags: "wx" });
  const writerOutcome = new Promise<void>((resolve, reject) => {
    writer.once("finish", resolve);
    writer.once("error", reject);
  });
  void writerOutcome.catch(() => undefined);
  const reader = response.body.getReader();
  let received = 0;
  let lastPersistedProgress = 15;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) throw new DOMException("Canceled", "AbortError");
      received += value.byteLength;
      if (received > maxFileBytes) throw new Error("Le fichier dépasse la taille maximale autorisée.");
      if (!writer.write(Buffer.from(value))) await Promise.race([once(writer, "drain"), writerOutcome]);

      const nextProgress = announcedSize ? Math.min(94, 15 + (received / announcedSize) * 79) : Math.min(94, 15 + Math.log10(Math.max(1, received)) * 8);
      if (nextProgress - lastPersistedProgress >= 2) {
        lastPersistedProgress = nextProgress;
        await setJob(job, nextProgress, "Téléchargement");
      }
    }
    writer.end();
    await writerOutcome;
  } catch (error) {
    writer.destroy();
    await fs.rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }

  job.fileName = fileName;
  job.fileSize = received;
  await setJob(job, 98, "Finalisation", "Vérification du fichier téléchargé.");
}

async function processScribdJob(job: DocumentJob, signal: AbortSignal): Promise<void> {
  await setJob(job, 12, "Validation du lien", "Lien Scribd reconnu.");
  const outputDirectory = path.join(downloadRoot, job.id);
  const runFastExtractor = () => downloadFastScribd({
    url: job.url,
    outputDirectory,
    outputFilename: job.title,
    maxFileBytes,
    signal,
    onProgress: (progress, step, log) => setJob(job, progress, step, log),
  });
  const runBrowserExtractor = () => downloadWithPlaywright({
    url: job.url,
    outputDirectory,
    maxFileBytes,
    signal,
    onProgress: (progress, step, log) => setJob(job, progress, step, log),
  });

  try {
    let result;
    if (job.extractor === "fast") {
      result = await runFastExtractor();
    } else if (job.extractor === "browser") {
      result = await runBrowserExtractor();
    } else {
      try {
        result = await runFastExtractor();
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        await fs.rm(outputDirectory, { recursive: true, force: true });
        job.progress = 12;
        const reason = error instanceof Error ? error.message : String(error);
        await setJob(job, 14, "Repli navigateur", `Extraction rapide indisponible (${reason}). Repli vers Playwright.`);
        result = await runBrowserExtractor();
      }
    }
    job.fileName = result.fileName;
    job.fileSize = result.fileSize;
    job.format = result.format;
    job.actionUrl = undefined;
    const extractorLabel = job.extractor === "browser" ? "navigateur" : job.extractor === "fast" ? "rapide" : "automatique";
    await setJob(job, 98, "Finalisation", `Fichier ${result.fileName} prêt (mode ${extractorLabel}).`);
  } catch (error) {
    await fs.rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function runJob(id: string): Promise<void> {
  const job = await findJob(id);
  if (!job || job.status !== "queued") {
    running.delete(id);
    void pumpQueue();
    return;
  }

  const controller = new AbortController();
  controllers.set(id, controller);

  try {
    job.status = "running";
    job.error = undefined;
    await setJob(job, 3, "Démarrage", "Le worker a démarré le job.");
    if (job.kind === "direct") await processDirectJob(job, controller.signal);
    else await processScribdJob(job, controller.signal);
    if (controller.signal.aborted) throw new DOMException("Canceled", "AbortError");
    job.status = "completed";
    await setJob(job, 100, job.fileName ? "Fichier prêt" : "Lien prêt", "Job terminé avec succès.");
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      job.status = "canceled";
      job.currentStep = "Annulé";
      job.logs.push(`${new Date().toLocaleTimeString("fr-FR")} · Job annulé.`);
    } else {
      job.status = "failed";
      job.currentStep = "Échec du traitement";
      job.error = error instanceof Error ? error.message : String(error);
      job.logs.push(`${new Date().toLocaleTimeString("fr-FR")} · ${job.error}`);
    }
    job.updatedAt = now();
    await saveJob(job);
  } finally {
    controllers.delete(id);
    running.delete(id);
    void pumpQueue();
  }
}

async function pumpQueue(): Promise<void> {
  while (running.size < maxConcurrent && queue.length) {
    const id = queue.shift();
    if (id) {
      running.add(id);
      void runJob(id);
    }
  }
}

export async function initializeJobs(): Promise<void> {
  await fs.mkdir(downloadRoot, { recursive: true });
  queue.push(...await recoverInterruptedJobs());
  await pumpQueue();
}

export async function createJob(input: unknown, extractorInput?: unknown): Promise<DocumentJob> {
  const parsed = parseDocumentUrl(input);
  const extractor = parseExtractorMode(extractorInput);
  const timestamp = now();
  const job: DocumentJob = {
    id: randomUUID(),
    ...parsed,
    extractor,
    status: "queued",
    progress: 0,
    currentStep: "En attente",
    createdAt: timestamp,
    updatedAt: timestamp,
    logs: [`${new Date().toLocaleTimeString("fr-FR")} · Job ajouté à la file (extracteur : ${extractor}).`],
  };
  await insertJob(job);
  queue.push(job.id);
  void pumpQueue();
  return job;
}

export async function listJobs(): Promise<DocumentJob[]> {
  return findJobs();
}

export async function getJob(id: string): Promise<DocumentJob | undefined> {
  return findJob(id);
}

export async function cancelJob(id: string): Promise<DocumentJob | undefined> {
  const job = await findJob(id);
  if (!job || !["queued", "running"].includes(job.status)) return job;
  const queueIndex = queue.indexOf(id);
  if (queueIndex >= 0) queue.splice(queueIndex, 1);
  controllers.get(id)?.abort();
  job.status = "canceled";
  job.currentStep = "Annulé";
  job.updatedAt = now();
  job.logs.push(`${new Date().toLocaleTimeString("fr-FR")} · Annulation demandée.`);
  await saveJob(job);
  return job;
}

export async function deleteJob(id: string): Promise<boolean> {
  const job = await findJob(id);
  if (!job || ["queued", "running"].includes(job.status)) return false;
  await fs.rm(path.join(downloadRoot, id), { recursive: true, force: true });
  await removeJobRecord(id);
  return true;
}

export async function getJobFile(id: string): Promise<{ path: string; name: string } | undefined> {
  const job = await findJob(id);
  if (!job?.fileName || job.status !== "completed") return undefined;
  return { path: path.join(downloadRoot, id, job.fileName), name: job.fileName };
}
