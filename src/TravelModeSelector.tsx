import type { TravelMode } from "./routing";
import "./travelMode.css";

type Props = {
  value: TravelMode;
  onChange: (mode: TravelMode) => void;
  disabled?: boolean;
};

const MODES: { id: TravelMode; label: string }[] = [
  { id: "car", label: "Car" },
  { id: "public-transport", label: "Transit" },
  { id: "walking", label: "Walk" },
];

function ModeIcon({ mode }: { mode: TravelMode }) {
  if (mode === "car") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m5 11 1.6-4.1A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.4L19 11" />
        <path d="M4 11h16a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 20 18H4a1.5 1.5 0 0 1-1.5-1.5v-4A1.5 1.5 0 0 1 4 11Z" />
        <path d="M5 18v1.5M19 18v1.5M3 14h3m12 0h3" />
        <circle cx="6.5" cy="15.5" r=".8" />
        <circle cx="17.5" cy="15.5" r=".8" />
      </svg>
    );
  }

  if (mode === "public-transport") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="5" y="3" width="14" height="15" rx="3" />
        <path d="M5 11h14M8 21l2-3m6 3-2-3M8.5 15h.01m7-.01h.01M8 7h8" />
        <path d="M4 6h1m14 0h1" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="14" cy="4.5" r="2" />
      <path d="m11.5 9 3.8 1.1 2.4 3.4m-6.2-4.5-2.1 4.3-4.2 2.2m6.3-6.5-1.6 5 3.8 2.2-1.2 4.3m-2.6-6.5-3.8 6.5" />
    </svg>
  );
}

export default function TravelModeSelector({ value, onChange, disabled = false }: Props) {
  return (
    <div className="travel-mode" role="group" aria-label="Travel mode">
      {MODES.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className={value === id ? "travel-mode-option is-selected" : "travel-mode-option"}
          aria-pressed={value === id}
          aria-label={id === "public-transport" ? "Public transport" : label}
          title={id === "public-transport" ? "Public transport routing" : `${label} routing`}
          disabled={disabled}
          onClick={() => onChange(id)}
        >
          <ModeIcon mode={id} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
