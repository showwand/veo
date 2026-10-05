type Props = {
  active: boolean;
  onClick: () => void;
};

// The round button in the top-right corner.
// The icon: two drivers, a dashed connection above them and a road beneath them.
export default function PartyButton({ active, onClick }: Props) {
  return (
    <button
      type="button"
      className={active ? "party-button is-active" : "party-button"}
      aria-label="Party"
      title="Party"
      aria-expanded={active}
      aria-controls="party-panel"
      onClick={onClick}
    >
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
        <path
          className="pb-link"
          d="M10.5 8 Q16 2.5 21.5 8"
          fill="none"
          strokeWidth="1.5"
          strokeDasharray="2 2"
          strokeLinecap="round"
        />
        <circle className="pb-node" cx="16" cy="5.25" r="1.4" />

        <circle className="pb-person" cx="9" cy="12.5" r="3.2" />
        <path
          className="pb-person"
          d="M3.2 26 C3.2 20.5 5.8 17.8 9 17.8 C12.2 17.8 14.8 20.5 14.8 26 Z"  
        />
        <circle className="pb-person" cx="23" cy="12.5" r="3.2" />
        <path
          className="pb-person"
          d="M17.2 26 C17.2 20.5 19.8 17.8 23 17.8 C26.2 17.8 28.8 20.5 28.8 26 Z"
        />

        <path
          className="pb-road"
          d="M4 29.5 H28"
          fill="none"
          strokeWidth="1.4"
          strokeDasharray="3 2.5"
        />
      </svg>
    </button>
  );
}