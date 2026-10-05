// A small "locate" target, drawn inline (no icon library)
export default function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
      <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" strokeLinecap="round" />
    </svg>
  );
}