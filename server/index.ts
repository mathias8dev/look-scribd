import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { cancelJob, createJob, deleteJob, getJob, getJobFile, initializeJobs, listJobs } from "./jobs.js";

const app = express();
const port = Number(process.env.PORT || process.env.LOOK_SCRIBD_API_PORT || 3435);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_request, response) => response.json({ ok: true }));
app.get("/api/jobs", async (_request, response, next) => {
  try { response.json({ jobs: await listJobs() }); } catch (error) { next(error); }
});
app.get("/api/jobs/:id", async (request, response, next) => {
  try {
    const job = await getJob(request.params.id);
    if (!job) { response.status(404).json({ error: "Job introuvable." }); return; }
    response.json({ job });
  } catch (error) { next(error); }
});
app.post("/api/jobs", async (request, response) => {
  try {
    response.status(201).json({ job: await createJob(request.body?.url) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/jobs/:id/cancel", async (request, response, next) => {
  try {
    const job = await cancelJob(request.params.id);
    if (!job) { response.status(404).json({ error: "Job introuvable." }); return; }
    response.json({ job });
  } catch (error) { next(error); }
});
app.delete("/api/jobs/:id", async (request, response, next) => {
  try {
    const removed = await deleteJob(request.params.id);
    if (!removed) { response.status(409).json({ error: "Ce job ne peut pas encore être supprimé." }); return; }
    response.json({ ok: true });
  } catch (error) { next(error); }
});
app.get("/api/jobs/:id/file", async (request, response, next) => {
  try {
    const file = await getJobFile(request.params.id);
    if (!file) { response.status(404).json({ error: "Fichier introuvable." }); return; }
    response.download(file.path, file.name);
  } catch (error) { next(error); }
});

if (process.env.NODE_ENV === "production") {
  const dist = path.join(root, "dist");
  app.use(express.static(dist, { index: false }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) { next(); return; }
    response.sendFile(path.join(dist, "index.html"));
  });
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  void _next;
  console.error(error);
  response.status(500).json({ error: "Une erreur interne est survenue." });
});

await initializeJobs();
app.listen(port, "0.0.0.0", () => {
  console.log(`Look Scribd API listening on http://0.0.0.0:${port}`);
});
