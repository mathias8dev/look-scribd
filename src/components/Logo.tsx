import { FileText } from "lucide-react";

export function Logo() {
  return (
    <a href="#top" className="logo group" aria-label="Look Scribd — Accueil">
      <span className="logo-mark">
        <FileText size={18} strokeWidth={2.2} />
        <span />
      </span>
      <span className="logo-word">look<i>scribd</i></span>
    </a>
  );
}
