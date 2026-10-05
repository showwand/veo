import type { SearchResult } from "./SearchBox";

type Props = {
  start: SearchResult | null;
  destination: SearchResult | null;
  // True once a route exists. This starts the "draw itself" animation.
  active: boolean;
  // Changes when the user picks another route, so the animation plays again
  routeId: string | null;
};

// "Buckingham Palace, The Mall, London, ..." -> "Buckingham Palace"
function shortName(result: SearchResult) {
  return result.name.split(", ")[0] ?? result.name;
}

export default function RouteGraphic({
  start,
  destination,
  active,
  routeId,
}: Props) {
  if (!start || !destination) return null;

  return (
    // The key makes React rebuild this when the route changes, restarting the animation
    <div
      key={routeId ?? "pending"}
      className={active ? "route-graphic is-active" : "route-graphic"}
    >
      <div className="rg-labels">
        <div className="rg-label-block">
          <span className="rg-tag">Start</span>
          <span className="rg-place">{shortName(start)}</span>
        </div>
        <div className="rg-label-block is-end">
          <span className="rg-tag">Destination</span>
          <span className="rg-place">{shortName(destination)}</span>
        </div>
      </div>

      <div className="rg-track" aria-hidden="true">
        {/* START: a ring with a centre dot and a pointer on the right */}
        <svg className="rg-marker" viewBox="0 0 24 24">
          <circle
            cx="12"
            cy="12"
            r="8.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="12" cy="12" r="3.5" fill="currentColor" />
          <path d="M22.5 12 L18.5 9.2 V14.8 Z" fill="currentColor" />
        </svg>

        <span className="rg-seg" />
        <svg className="rg-peak" viewBox="0 0 28 14">
          <polyline
            points="1,12 8,12 14,2 20,12 27,12"
            pathLength={1}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="miter"
          />
        </svg>
        <span className="rg-seg is-second" />

        {/* DESTINATION: a diamond with a solid core */}
        <svg className="rg-marker is-end" viewBox="0 0 24 24">
          <path
            d="M12 2 L22 12 L12 22 L2 12 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path d="M12 8 L16 12 L12 16 L8 12 Z" fill="currentColor" />
        </svg>
      </div>
    </div>
  );
}