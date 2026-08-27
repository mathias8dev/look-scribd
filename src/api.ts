import type { DocumentJob } from "./types";

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "La requête a échoué.");
  return payload;
}

export async function fetchJobs(): Promise<DocumentJob[]> {
  return (await request<{ jobs: DocumentJob[] }>("/api/jobs")).jobs;
}

export async function submitJob(url: string): Promise<DocumentJob> {
  return (await request<{ job: DocumentJob }>("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  })).job;
}

export async function cancelJob(id: string): Promise<DocumentJob> {
  return (await request<{ job: DocumentJob }>(`/api/jobs/${id}/cancel`, { method: "POST" })).job;
}

export async function removeJob(id: string): Promise<void> {
  await request(`/api/jobs/${id}`, { method: "DELETE" });
}
