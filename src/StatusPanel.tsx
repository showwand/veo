import type { NavigationSnapshot } from "./navigationTypes";
import TargetIcon from "./TargetIcon";

type Props = {
  open: boolean;
  snapshot: NavigationSnapshot | null;
  followUser: boolean;
  onFollow: () => void;
  onEnd: () => void;
};

export default function StatusPanel({ open, snapshot, followUser, onFollow, onEnd }: Props) {
  const limit = snapshot?.speedLimitMph ?? null;
  const limitNote =
    limit === null
      ? "Unknown"
      : snapshot?.speedLimitSource === "route-start"
        ? "mph · at route start"
        : "mph";

  // The car's own GPS speed. Completely separate from the OSM limit above.
  const speed = snapshot?.currentSpeedMph ?? null;
  const routeDistanceMeters = snapshot?.route.distanceMeters ?? null;
  const routeDistance =
    routeDistanceMeters === null
      ? null
      : `${(routeDistanceMeters / 1000).toFixed(1)} km · ${(routeDistanceMeters / 1609.344).toFixed(1)} mi`;

  return (
    <section
      className={open ? "nav-panel nav-bottom is-open" : "nav-panel nav-bottom"}
      aria-label="Journey information"
    >
      <div className="nav-route-summary">
        <strong className="nav-route-name">{snapshot?.route.name ?? "Route"}</strong>
        <span className="nav-route-meta">
          {snapshot ? `${snapshot.remainingMinutes} min left` : ""}
          {snapshot && routeDistance ? " · " : ""}
          {routeDistance ?? ""}
        </span>
      </div>

      <div className="nav-limit">
        <div className={limit === null ? "limit-sign is-unknown" : "limit-sign"}>
          {limit === null ? "--" : limit}
        </div>
        <div className="nav-limit-text">
          <div className="nav-label">Speed limit</div>
          <div className="nav-limit-note">{limitNote}</div>
        </div>
      </div>

      <div className="nav-center">
        <div className="nav-speed" title="Your current GPS speed">
          <span className={speed === null ? "nav-speed-value is-unknown" : "nav-speed-value"}>
            {speed === null ? "--" : Math.round(speed)}
          </span>
          <span className="nav-label">mph now</span>
        </div>

        <div className="nav-actions">
          {/* Always mounted; it grows in when the camera stops following the car */}
          <button
            type="button"
            className={followUser ? "nav-follow" : "nav-follow is-visible"}
            onClick={onFollow}
            tabIndex={followUser ? -1 : 0}
            aria-hidden={followUser}
            aria-label="Follow my position"
          >
            <TargetIcon />
            <span className="nav-follow-text">Follow</span>
          </button>

          <button type="button" className="nav-end" onClick={onEnd} aria-label="End navigation">
            End
          </button>
        </div>
      </div>

      <div className="nav-times">
        <div className="nav-eta">
          <span className="nav-label">ETA</span>
          <span className="nav-eta-time">{snapshot?.etaLabel ?? "--"}</span>
        </div>
        <div className="nav-remaining">
          {snapshot ? `${snapshot.remainingMinutes} min` : "--"}
        </div>
      </div>
    </section>
  );
}