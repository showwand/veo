import "./routeOptions.css";
import type { Route, TravelMode } from "./routing";
import type { RouteStatus } from "./useRouteOptions";

type Props = {
  routes: Route[];
  selectedId: string | null; // which route is currently chosen
  status: RouteStatus;
  mode: TravelMode;
  error: string | null;
  onSelect: (routeId: string) => void;
};

// Splits seconds into hours and minutes so we can show them as big numbers
function splitDuration(seconds: number) {
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

export default function RouteOptions({
  routes,
  selectedId,
  status,
  mode,
  error,
  onSelect,
}: Props) {
  if (status === "idle") return null;

  if (status === "loading") {
    return (
      <section className="route-hud is-status">
        <div className="hud-label">Calculating routes</div>
        <div className="hud-scan" />
      </section>
    );
  }

  if (status === "error" || routes.length === 0) {
    return (
      <section className="route-hud is-status is-error">
        <div className="hud-label">No route</div>
        <div className="hud-message">
          {error ??
            `There may be no ${mode === "car" ? "driving" : mode === "walking" ? "walking" : "public transport"} route between these places.`}
        </div>
      </section>
    );
  }

  return (
    <section className="route-options" aria-label="Route options">
      <div className="route-options-title">
        {mode === "car"
          ? `${routes.length} ${routes.length === 1 ? "car route" : "car routes"}`
          : mode === "walking"
            ? "Walking route"
            : `${routes.length} ${routes.length === 1 ? "journey" : "journeys"}`}
      </div>

      {routes.map((route) => {
        const { hours, minutes } = splitDuration(route.durationSeconds);
        const km = route.distanceMeters === null ? null : route.distanceMeters / 1000;
        const miles = km === null ? null : km * 0.621371;
        const isSelected = route.id === selectedId;

        return (
          <button
            key={route.id}
            type="button"
            className={isSelected ? "route-option is-selected" : "route-option"}
            aria-pressed={isSelected}
            onClick={() => onSelect(route.id)}
          >
            <span className="option-info">
              <span className="hud-label">{route.name}</span>
              <span className="option-time">
                {hours > 0 && (
                  <>
                    <span className="hud-num">{hours}</span>
                    <span className="hud-unit">h</span>
                  </>
                )}
                {(minutes > 0 || hours === 0) && (
                  <>
                    <span className="hud-num">{minutes}</span>
                    <span className="hud-unit">min</span>
                  </>
                )}
              </span>
            </span>

            <span className="option-side">
              {route.details ? (
                <>
                  <span className="hud-label">
                    {mode === "public-transport" ? "Transport" : "Route source"}
                  </span>
                  <span className="option-details">{route.details}</span>
                </>
              ) : km !== null && miles !== null ? (
                <>
                  <span className="hud-label">Distance</span>
                  <span className="option-distance">
                    <span className="hud-num">{km.toFixed(1)}</span>
                    <span className="hud-unit">km</span>
                  </span>
                  <span className="hud-sub">{miles.toFixed(1)} mi</span>
                </>
              ) : null}
              {km !== null && miles !== null && route.details && (
                <span className="hud-sub">
                  {km.toFixed(1)} km · {miles.toFixed(1)} mi
                </span>
              )}
            </span>
          </button>
        );
      })}
    </section>
  );
}