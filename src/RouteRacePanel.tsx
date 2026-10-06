import Avatar from "./Avatar";
import type { PartyRacer } from "./routePartyApi";
import { formatRemaining } from "./useRouteParty";
import "./routeRace.css";

type Props = {
  racers: PartyRacer[];
  error: string | null;
  userId: string | null;
};

export default function RouteRacePanel({ racers, error, userId }: Props) {
  return (
    <aside className="route-race" aria-label="Route party standings">
      <header className="rr-header">
        <span className="rr-live-dot" />
        <div>
          <span className="rr-kicker">ROUTE PARTY</span>
          <strong>LIVE STANDINGS</strong>
        </div>
        <span className="rr-count">{String(racers.length).padStart(2, "0")}</span>
      </header>

      {error && <div className="rr-error" role="status">{error}</div>}

      <ol className="rr-list">
        {racers.map((racer, index) => {
          const own = racer.userId === userId;
          const hasProgress =
            racer.remainingSeconds !== null &&
            racer.progressMeters !== null &&
            racer.updatedAt !== null;
          const stale = !hasProgress && racer.updatedAt !== null;

          return (
            <li className={own ? "rr-racer is-own" : "rr-racer"} key={racer.userId}>
              <span className="rr-position">{String(index + 1).padStart(2, "0")}</span>
              <Avatar id={racer.avatarId} size={38} className="rr-avatar" />
              <span className="rr-copy">
                <strong>{own ? `${racer.username} (YOU)` : racer.username}</strong>
                <span className={stale ? "rr-eta is-stale" : "rr-eta"}>
                  {hasProgress && !stale
                    ? formatRemaining(racer.remainingSeconds ?? 0)
                    : !racer.locationShared
                      ? "LOCATION OFF"
                      : stale
                        ? "SIGNAL DELAYED"
                        : "WAITING FOR GPS"}
                </span>
              </span>
              {hasProgress && !stale && (
                <span className="rr-progress">
                  {Math.floor((racer.progressMeters ?? 0) / 1000)} km
                </span>
              )}
            </li>
          );
        })}
        {racers.length === 0 && (
          <li className="rr-empty">Waiting for route party members…</li>
        )}
      </ol>

      <footer className="rr-footer">
        <span className="rr-footer-sweep" />
        <span>PACE YOUR OWN RACE</span>
      </footer>
    </aside>
  );
}
