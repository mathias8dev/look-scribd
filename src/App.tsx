import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  Clipboard,
  Database,
  HardDrive,
  Layers3,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Menu,
  ServerCog,
  ShieldCheck,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { cancelJob, fetchJobs, removeJob, submitJob } from "./api";
import { ActiveJob } from "./components/ActiveJob";
import { JobsDrawer } from "./components/JobsDrawer";
import { Logo } from "./components/Logo";
import type { DocumentJob, ExtractorMode } from "./types";

const faqs = [
  {
    question: "Quels liens puis-je utiliser ?",
    answer: "Les liens Scribd de type document, doc et présentation sont reconnus. Les URL directes vers des fichiers PDF, DOCX, PPTX, TXT ou EPUB sont téléchargées et conservées par votre instance.",
  },
  {
    question: "Où sont stockés les téléchargements ?",
    answer: "Les fichiers sont écrits dans le volume downloads et l’historique dans une base SQLite. Les deux emplacements sont persistants en Docker et restent sous votre contrôle.",
  },
  {
    question: "Que se passe-t-il après un redémarrage ?",
    answer: "L’historique reste disponible. Les jobs encore en attente repartent dans la file et un traitement interrompu est clairement indiqué dans son journal.",
  },
  {
    question: "Quel extracteur choisir ?",
    answer: "Auto essaie d’abord l’extraction rapide des images, puis utilise le rendu Playwright si nécessaire. Rapide et Navigateur permettent de forcer une seule méthode.",
  },
];

const steps = [
  { number: "01", title: "Collez le lien", text: "Ajoutez l’adresse du document. Le format et la source sont validés côté serveur.", icon: Link2 },
  { number: "02", title: "Suivez le job", text: "Le worker traite la demande en arrière-plan et publie sa progression en temps réel.", icon: Activity },
  { number: "03", title: "Récupérez le fichier", text: "Téléchargez le fichier prêt, puis retrouvez-le à tout moment dans l’historique.", icon: ArrowDownToLine },
];

const extractorOptions: Array<{ value: ExtractorMode; label: string; detail: string }> = [
  { value: "auto", label: "Auto", detail: "Rapide, puis navigateur" },
  { value: "fast", label: "Rapide", detail: "Images directes" },
  { value: "browser", label: "Navigateur", detail: "Rendu Playwright" },
];

function FaqRow({ item, initiallyOpen }: { item: (typeof faqs)[number]; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="faq-row">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{item.question}</span><span className={open ? "faq-chevron open" : "faq-chevron"}><ChevronDown size={15} /></span>
      </button>
      <AnimatePresence initial={false}>
        {open && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="faq-answer"><p>{item.answer}</p></motion.div>}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  const [url, setUrl] = useState("");
  const [jobs, setJobs] = useState<DocumentJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extractor, setExtractor] = useState<ExtractorMode>("auto");

  const refresh = useCallback(async (quiet = false) => {
    try {
      setJobs(await fetchJobs());
      if (!quiet) setError(null);
    } catch (cause) {
      if (!quiet) setError(cause instanceof Error ? cause.message : "Impossible de charger les jobs.");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(true), 1_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const selectedJob = useMemo(() => {
    const selected = jobs.find((job) => job.id === selectedId);
    return selected || jobs.find((job) => job.status === "running" || job.status === "queued") || jobs[0];
  }, [jobs, selectedId]);
  const activeCount = jobs.filter((job) => job.status === "running" || job.status === "queued").length;

  async function enqueue(value: string) {
    if (!value.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const job = await submitJob(value.trim(), extractor);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setSelectedId(job.id);
      setUrl("");
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Impossible de créer le téléchargement.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void enqueue(url);
  }

  async function handlePaste() {
    try {
      setUrl(await navigator.clipboard.readText());
      setError(null);
    } catch {
      setError("Le presse-papiers n’est pas accessible. Collez le lien manuellement.");
    }
  }

  async function handleCancel(id: string) {
    try { await cancelJob(id); await refresh(true); } catch (cause) { setError(cause instanceof Error ? cause.message : "Annulation impossible."); }
  }

  async function handleRemove(id: string) {
    try {
      await removeJob(id);
      if (selectedId === id) setSelectedId(null);
      await refresh(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Suppression impossible."); }
  }

  function handleRetry(retryUrl: string, retryExtractor: ExtractorMode) {
    setDrawerOpen(false);
    setUrl(retryUrl);
    setExtractor(retryExtractor);
    setError(null);
    document.querySelector("#outil")?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <main id="top">
      <nav className="navbar">
        <Logo />
        <div className="nav-links"><a href="#fonctionnement">Fonctionnement</a><a href="#infrastructure">Infrastructure</a><a href="#faq">FAQ</a></div>
        <button type="button" className="activity-button" onClick={() => setDrawerOpen(true)}>
          <Activity size={16} /> <span>Activité</span>
          {(activeCount > 0 || jobs.length > 0) && <small className={activeCount > 0 ? "live" : ""}>{activeCount || jobs.length}</small>}
        </button>
        <button type="button" className="mobile-menu" onClick={() => setMenuOpen((value) => !value)} aria-label="Ouvrir le menu">{menuOpen ? <X size={19} /> : <Menu size={19} />}</button>
        <AnimatePresence>
          {menuOpen && <motion.div className="mobile-nav" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <button type="button" onClick={() => { setDrawerOpen(true); setMenuOpen(false); }}><Activity size={15} /> Activité ({jobs.length})</button>
            <a href="#fonctionnement" onClick={() => setMenuOpen(false)}>Fonctionnement</a>
            <a href="#infrastructure" onClick={() => setMenuOpen(false)}>Infrastructure</a>
            <a href="#faq" onClick={() => setMenuOpen(false)}>FAQ</a>
          </motion.div>}
        </AnimatePresence>
      </nav>

      <section className="hero-section">
        <div className="hero-glow" aria-hidden="true" />
        <motion.div className="hero-copy" initial={false} animate={{ opacity: 1, y: 0 }}>
          <div className="eyebrow"><span /> File asynchrone & historique persistant</div>
          <h1>Vos documents,<em>sans perdre le fil.</em></h1>
          <p>Collez un lien, laissez le worker s’en charger et suivez chaque étape. Vos jobs et vos fichiers restent disponibles sur votre propre instance.</p>
        </motion.div>

        <motion.div id="outil" className="tool-wrap" initial={false} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: 0.1 }}>
          <div className="tool-card">
            <div className="tool-heading">
              <div><p>Nouveau téléchargement</p><span>Scribd, PDF, DOCX, PPTX, TXT ou EPUB</span></div>
              <div className="worker-state"><i /><span>Extracteurs prêts</span></div>
            </div>
            <form onSubmit={handleSubmit}>
              <div className={`input-shell ${error ? "input-error" : ""}`}>
                <Link2 size={19} />
                <input value={url} onChange={(event) => { setUrl(event.target.value); setError(null); }} placeholder="https://www.scribd.com/document/..." aria-label="Lien du document" disabled={submitting} />
                {!url && <button type="button" className="paste-button" onClick={handlePaste}><Clipboard size={14} /> Coller</button>}
                {url && !submitting && <button type="button" className="clear-button" onClick={() => setUrl("")} aria-label="Effacer"><X size={15} /></button>}
                <button className="primary-button" type="submit" disabled={!url.trim() || submitting}>
                  {submitting ? <><LoaderCircle className="spin" size={17} /> Ajout…</> : <>Lancer le job <ArrowRight size={17} /></>}
                </button>
              </div>
              <fieldset className="extractor-picker" disabled={submitting}>
                <legend>Extracteur</legend>
                <div>
                  {extractorOptions.map((option) => (
                    <button type="button" key={option.value} className={extractor === option.value ? "active" : ""} aria-pressed={extractor === option.value} onClick={() => setExtractor(option.value)}>
                      <strong>{option.label}</strong>
                      <span>{option.detail}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
              {error && <motion.p className="form-error" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>{error}</motion.p>}
            </form>

            <AnimatePresence mode="wait">
              {selectedJob && <ActiveJob key={selectedJob.id} job={selectedJob} onCancel={(id) => void handleCancel(id)} onRemove={(id) => void handleRemove(id)} onRetry={handleRetry} />}
            </AnimatePresence>

            <div className="tool-foot">
              <span><Database size={13} /> Historique SQLite</span><span><Layers3 size={13} /> {activeCount} job{activeCount > 1 ? "s" : ""} actif{activeCount > 1 ? "s" : ""}</span>
              <button type="button" onClick={() => setDrawerOpen(true)}>Voir toute l’activité <ArrowRight size={13} /></button>
            </div>
          </div>
        </motion.div>

        <div className="trust-row"><span><Check size={13} /> Extraction directe</span><span><Check size={13} /> Repli Playwright</span><span><Check size={13} /> Compatible Docker</span></div>
      </section>

      <section id="fonctionnement" className="steps-section">
        <div className="section-inner">
          <div className="section-heading"><div><span className="section-label">Un flux limpide</span><h2>Du lien au fichier,<em> sans attendre.</em></h2></div><p>Le traitement continue même si vous fermez le panneau. Chaque étape, erreur et résultat reste consultable dans le centre d’activité.</p></div>
          <div className="steps-grid">
            {steps.map((step, index) => { const Icon = step.icon; return <motion.article key={step.number} initial={false} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.3 }} transition={{ delay: index * 0.08 }}><header><span>{step.number}</span><i><Icon size={19} /></i></header><h3>{step.title}</h3><p>{step.text}</p></motion.article>; })}
          </div>
        </div>
      </section>

      <section id="infrastructure" className="infra-section">
        <div className="infra-card">
          <div className="infra-copy">
            <span className="infra-icon"><ServerCog size={23} /></span>
            <p className="section-label light">Pensé pour l’auto-hébergement</p>
            <h2>Une petite pile,<br />des jobs <em>fiables.</em></h2>
            <p>React et Vite servent une interface vive. Express orchestre la file, SQLite garde l’historique, et les volumes Docker préservent données et téléchargements.</p>
          </div>
          <div className="stack-visual">
            <div className="stack-card"><span><Database size={18} /></span><div><strong>jobs.sqlite</strong><small>État, progression et journaux</small></div><i>persistant</i></div>
            <div className="stack-line"><span /><span /><span /></div>
            <div className="stack-card"><span><HardDrive size={18} /></span><div><strong>/downloads</strong><small>Fichiers prêts à récupérer</small></div><i>volume</i></div>
            <div className="stack-badges"><span><ShieldCheck size={14} /> Isolation réseau</span><span><LockKeyhole size={14} /> Auto-hébergé</span></div>
          </div>
        </div>
      </section>

      <section id="faq" className="faq-section">
        <div className="faq-intro"><span className="section-label">Besoin d’aide ?</span><h2>Questions fréquentes.</h2><p>Les détails utiles pour lancer et administrer votre instance.</p></div>
        <div className="faq-list">{faqs.map((item, index) => <FaqRow key={item.question} item={item} initiallyOpen={index === 0} />)}</div>
      </section>

      <footer><Logo /><p>Look Scribd n’est pas affilié à Scribd. Utilisez uniquement des documents que vous êtes autorisé à télécharger.</p><button type="button" onClick={() => setDrawerOpen(true)}><Activity size={14} /> Historique</button></footer>

      <JobsDrawer open={drawerOpen} jobs={jobs} onClose={() => setDrawerOpen(false)} onCancel={(id) => void handleCancel(id)} onRemove={(id) => void handleRemove(id)} onRetry={handleRetry} />
    </main>
  );
}
