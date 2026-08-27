export type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type DocumentJob = {
  id: string;
  url: string;
  kind: "scribd" | "direct";
  source: string;
  title: string;
  format: string;
  status: JobStatus;
  progress: number;
  currentStep: string;
  createdAt: string;
  updatedAt: string;
  logs: string[];
  fileName?: string;
  fileSize?: number;
  actionUrl?: string;
  error?: string;
};
