import "./favourites.css";

type Props = { active: boolean; onClick: () => void };

// A sharp-edged star, drawn inline (no icon library)
export function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="miter">
      <path d="M12 3 L14.7 9 L21 9.7 L16.3 14 L17.6 20.4 L12 17.1 L6.4 20.4 L7.7 14 L3 9.7 L9.3 9 Z" />
    </svg>
  );
}

// Its position is set by topActions.ts (left of Party). favourites.css has a fallback.
export default function FavouritesButton({ active, onClick }: Props) {
  return (
    <button
      type="button"
      className={active ? "favourites-button is-active" : "favourites-button"}
      onClick={onClick}
      aria-label="Favourite routes"
      aria-pressed={active}
      title="Favourite routes"
    >
      <StarIcon />
    </button>
  );
}