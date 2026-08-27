import { AnimatePresence, motion } from "framer-motion";
import { Activity, CheckCircle2, ChevronDown, Clock3, FileText, LoaderCircle, XCircle } from "lucide-react";
import { useState } from "react";
import type { DocumentJob, JobStatus } from "../types";
import { JobActions } from "./JobActions";

const statusLabels: Record<JobStatus, string> = {
  queued: "En attente",
  running: "En cours",
  completed: "Terminé",
  failed: "Échec",
  canceled: "Annulé",
};

const statusIcons = {
  queued: Clock3,
  running: LoaderCircle,
  completed: CheckCircle2,
  failed: XCircle,
  canceled: XCircle,
};

function formatSize(size?: number) {
  if (!size) return null;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} Ko`;
  return `${(size / 1024 / 1024).toFixed(1)} Mo`;
}

type Props = {
  open: boolean;
  jobs: DocumentJob[];
  onClose: () => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry: (url: string) => void;
};

export function JobsDrawer({ open, jobs, onClose, onCancel, onRemove, onRetry }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const active = jobs.filter((job) => job.status === "queued" || job.status === "running").length;
  const completed = jobs.filter((job) => job.status === "completed").length;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button className="drawer-backdrop" onClick={onClose} aria-label="Fermer l’activité" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.aside className="jobs-drawer" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", damping: 30, stiffness: 280 }} aria-label="Historique des téléchargements">
            <header className="drawer-header">
              <div>
                <p className="drawer-kicker"><Activity size={13} /> Centre d’activité</p>
                <h2>Vos téléchargements</h2>
              </div>
              <button type="button" onClick={onClose} className="round-button" aria-label="Fermer"><XCircle size={19} /></button>
            </header>

            <div className="drawer-stats">
              <div><span className="stat-dot active" /><strong>{active}</strong><small>actif{active > 1 ? "s" : ""}</small></div>
              <div><span className="stat-dot done" /><strong>{completed}</strong><small>terminé{completed > 1 ? "s" : ""}</small></div>
              <div><span className="stat-dot total" /><strong>{jobs.length}</strong><small>au total</small></div>
            </div>

            <div className="drawer-list">
              {jobs.length === 0 ? (
                <div className="empty-jobs">
                  <span><FileText size={23} /></span>
                  <h3>Aucun téléchargement</h3>
                  <p>Vos jobs apparaîtront ici et resteront disponibles après un redémarrage.</p>
                </div>
              ) : jobs.map((job) => {
                const Icon = statusIcons[job.status];
                const isOpen = expanded === job.id;
                return (
                  <article className={`drawer-job status-${job.status}`} key={job.id}>
                    <button type="button" className="drawer-job-main" onClick={() => setExpanded(isOpen ? null : job.id)}>
                      <span className="drawer-job-icon"><Icon className={job.status === "running" ? "spin" : ""} size={17} /></span>
                      <span className="drawer-job-copy">
                        <span className="drawer-job-title">{job.title}</span>
                        <span className="drawer-job-meta">{job.format} · {job.source} {formatSize(job.fileSize) ? `· ${formatSize(job.fileSize)}` : ""}</span>
                      </span>
                      <span className="drawer-job-state">{statusLabels[job.status]}</span>
                      <ChevronDown className={isOpen ? "rotated" : ""} size={15} />
                    </button>
                    {(job.status === "running" || job.status === "queued") && (
                      <div className="mini-progress"><motion.span animate={{ width: `${job.progress}%` }} /></div>
                    )}
                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <motion.div className="drawer-job-details" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                          <div className="details-inner">
                            <p className="current-step">{job.currentStep}{job.error ? ` — ${job.error}` : ""}</p>
                            {job.logs.length > 0 && <div className="job-logs">{job.logs.slice(-5).map((log, index) => <p key={`${job.id}-${index}`}>{log}</p>)}</div>}
                            <JobActions job={job} compact onCancel={onCancel} onRemove={onRemove} onRetry={onRetry} />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </article>
                );
              })}
            </div>
            <footer className="drawer-footer">Historique stocké dans SQLite sur cette instance.</footer>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
