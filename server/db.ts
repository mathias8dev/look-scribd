import fs from "node:fs/promises";
import path from "node:path";
import sqlite3 from "sqlite3";
import type { DocumentJob, JobStatus } from "./types.js";

const dataRoot = process.env.LOOK_SCRIBD_DATA_DIR || path.join(process.cwd(), "data");
const databasePath = path.join(dataRoot, "jobs.sqlite");

type JobRow = {
  id: string;
  url: string;
  kind: DocumentJob["kind"];
  source: string;
  title: string;
  format: string;
  status: JobStatus;
  progress: number;
  current_step: string;
  created_at: string;
  updated_at: string;
  logs_json: string;
  file_name: string | null;
  file_size: number | null;
  action_url: string | null;
  error: string | null;
};

let databasePromise: Promise<sqlite3.Database> | undefined;

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => error ? reject(error) : resolve());
  });
}

function all<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows: T[]) => error ? reject(error) : resolve(rows));
  });
}

function one<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row: T | undefined) => error ? reject(error) : resolve(row));
  });
}

async function openDatabase(): Promise<sqlite3.Database> {
  await fs.mkdir(dataRoot, { recursive: true });
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const instance = new sqlite3.Database(databasePath, (error) => error ? reject(error) : resolve(instance));
  });

  await run(db, "PRAGMA journal_mode = WAL");
  await run(db, "PRAGMA busy_timeout = 5000");
  await run(db, `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    format TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL NOT NULL,
    current_step TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    logs_json TEXT NOT NULL,
    file_name TEXT,
    file_size INTEGER,
    action_url TEXT,
    error TEXT
  )`);
  await run(db, "CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at DESC)");
  await run(db, `UPDATE jobs SET status = 'failed', progress = 0,
    current_step = 'Relance Playwright requise',
    error = 'Ce job a été créé avant l’intégration Playwright. Relancez-le pour produire un fichier.',
    updated_at = ?
    WHERE kind = 'scribd' AND status = 'completed' AND file_name IS NULL`, [new Date().toISOString()]);
  return db;
}

async function getDatabase(): Promise<sqlite3.Database> {
  databasePromise ??= openDatabase();
  return databasePromise;
}

function toJob(row: JobRow): DocumentJob {
  let logs: string[] = [];
  try {
    const parsed = JSON.parse(row.logs_json) as unknown;
    if (Array.isArray(parsed)) logs = parsed.filter((item): item is string => typeof item === "string");
  } catch {}

  return {
    id: row.id,
    url: row.url,
    kind: row.kind,
    source: row.source,
    title: row.title,
    format: row.format,
    status: row.status,
    progress: row.progress,
    currentStep: row.current_step,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    logs,
    fileName: row.file_name ?? undefined,
    fileSize: row.file_size ?? undefined,
    actionUrl: row.action_url ?? undefined,
    error: row.error ?? undefined,
  };
}

export async function insertJob(job: DocumentJob): Promise<void> {
  const db = await getDatabase();
  await run(db, `INSERT INTO jobs (
    id, url, kind, source, title, format, status, progress, current_step,
    created_at, updated_at, logs_json, file_name, file_size, action_url, error
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    job.id, job.url, job.kind, job.source, job.title, job.format, job.status,
    job.progress, job.currentStep, job.createdAt, job.updatedAt,
    JSON.stringify(job.logs), job.fileName ?? null, job.fileSize ?? null,
    job.actionUrl ?? null, job.error ?? null,
  ]);
}

export async function saveJob(job: DocumentJob): Promise<void> {
  const db = await getDatabase();
  await run(db, `UPDATE jobs SET
    status = ?, progress = ?, current_step = ?, updated_at = ?, logs_json = ?,
    file_name = ?, file_size = ?, action_url = ?, error = ?, title = ?, format = ?
    WHERE id = ?`, [
    job.status, job.progress, job.currentStep, job.updatedAt,
    JSON.stringify(job.logs.slice(-200)), job.fileName ?? null,
    job.fileSize ?? null, job.actionUrl ?? null, job.error ?? null,
    job.title, job.format, job.id,
  ]);
}

export async function findJob(id: string): Promise<DocumentJob | undefined> {
  const db = await getDatabase();
  const row = await one<JobRow>(db, "SELECT * FROM jobs WHERE id = ?", [id]);
  return row ? toJob(row) : undefined;
}

export async function findJobs(): Promise<DocumentJob[]> {
  const db = await getDatabase();
  return (await all<JobRow>(db, "SELECT * FROM jobs ORDER BY created_at DESC")).map(toJob);
}

export async function removeJobRecord(id: string): Promise<void> {
  const db = await getDatabase();
  await run(db, "DELETE FROM jobs WHERE id = ?", [id]);
}

export async function recoverInterruptedJobs(): Promise<string[]> {
  const db = await getDatabase();
  const timestamp = new Date().toISOString();
  await run(db, `UPDATE jobs SET status = 'failed', current_step = 'Interrompu',
    error = 'Le serveur a redémarré pendant le traitement.', updated_at = ?
    WHERE status = 'running'`, [timestamp]);
  const queued = await all<{ id: string }>(db, "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC");
  return queued.map((row) => row.id);
}
