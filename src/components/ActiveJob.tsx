import { motion } from "framer-motion";
import { CheckCircle2, Clock3, FileText, LoaderCircle, XCircle } from "lucide-react";
import type { DocumentJob } from "../types";
import { JobActions } from "./JobActions";

type Props = {
  job: DocumentJob;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry: (url: string) => void;
};

export function ActiveJob({ job, onCancel, onRemove, onRetry }: Props) {
  const active = job.status === "queued" || job.status === "running";
  const Icon = job.status === "running" ? LoaderCircle : job.status === "queued" ? Clock3 : job.status === "completed" ? CheckCircle2 : XCircle;
  return (
    <motion.article className={`active-job status-${job.status}`} initial={false} animate={{ opacity: 1, y: 0 }}>
      <div className="active-job-top">
        <span className="active-document-icon"><FileText size={22} /><small>{job.format.slice(0, 4)}</small></span>
        <div className="active-job-copy">
          <span className="active-job-status"><Icon className={job.status === "running" ? "spin" : ""} size={14} /> {job.currentStep}</span>
          <h3>{job.title}</h3>
          <p>{job.source} · créé à {new Date(job.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</p>
        </div>
        <JobActions job={job} onCancel={onCancel} onRemove={onRemove} onRetry={onRetry} />
      </div>
      {active && (
        <div className="active-progress">
          <div><span>{job.currentStep}</span><strong>{Math.round(job.progress)}%</strong></div>
          <div className="progress-track"><motion.span animate={{ width: `${job.progress}%` }} transition={{ ease: "easeOut" }} /></div>
        </div>
      )}
      {job.error && <p className="active-error">{job.error}</p>}
      {job.status === "completed" && !job.fileName && <p className="active-note">Aucun fichier n’a été produit par le worker.</p>}
    </motion.article>
  );
}
