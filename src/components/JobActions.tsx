import { ArrowDownToLine, ExternalLink, RotateCcw, Trash2, X } from "lucide-react";
import type { DocumentJob, ExtractorMode } from "../types";

type Props = {
  job: DocumentJob;
  compact?: boolean;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry?: (url: string, extractor: ExtractorMode) => void;
};

export function JobActions({ job, compact, onCancel, onRemove, onRetry }: Props) {
  const active = job.status === "queued" || job.status === "running";
  return (
    <div className={`job-actions ${compact ? "job-actions-compact" : ""}`}>
      {active && (
        <button type="button" className="job-action danger" onClick={() => onCancel(job.id)}>
          <X size={14} /> Annuler
        </button>
      )}
      {job.status === "completed" && job.fileName && (
        <a className="job-action primary" href={`/api/jobs/${job.id}/file`} download>
          <ArrowDownToLine size={14} /> Télécharger
        </a>
      )}
      {job.status === "completed" && job.actionUrl && !job.fileName && (
        <a className="job-action primary" href={job.actionUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> Ouvrir
        </a>
      )}
      {!active && onRetry && (
        <button type="button" className="job-action" onClick={() => onRetry(job.url, job.extractor)}>
          <RotateCcw size={14} /> Relancer
        </button>
      )}
      {!active && (
        <button type="button" className="job-action icon-only" onClick={() => onRemove(job.id)} aria-label="Supprimer le job">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}
