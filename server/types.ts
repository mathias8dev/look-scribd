export type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type JobKind = "scribd" | "direct";

export type DocumentJob = {
  id: string;
  url: string;
  kind: JobKind;
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

export type ParsedDocument = Pick<DocumentJob, "url" | "kind" | "source" | "title" | "format"> & {
  actionUrl?: string;
};
