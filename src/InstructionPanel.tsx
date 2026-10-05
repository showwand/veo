import type { Maneuver, ManeuverKind } from "./navigationTypes";
import type { LocationStatus } from "./userLocation";

type Props = {
  open: boolean;
  maneuver: Maneuver | null;
  destinationName: string | null;
  arrived: boolean;
  offRoute: boolean;
  positionOnRoute: boolean | null;
  distanceFromRouteM: number | null;
  gpsStatus: LocationStatus;
  gpsAccuracyM: number | null;
  hasTurnData: boolean;
};

// 300 -> "300 m", 1240 -> "1.2 km"
function formatManeuverDistance(meters: number): string {
  if (meters < 1000) return `${Math.max(0, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

// Plain arrows drawn with SVG, so there is no icon library
function ManeuverIcon({ kind }: { kind: ManeuverKind | null }) {
  const arrow = (degrees: number) => (
    <g transform={`rotate(${degrees} 24 24)`}>
      <path d="M24 6 L38 22 H29 V42 H19 V22 H10 Z" fill="currentColor" />
    </g>
  );

  let shape;
  switch (kind) {
    case "left":
      shape = arrow(-90);
      break;
    case "right":
      shape = arrow(90);
      break;
    case "slight-left":
      shape = arrow(-45);
      break;
    case "slight-right":
      shape = arrow(45);
      break;
    case "u-turn":
      shape = (
        <>
          <path d="M32 42 V18 A9 9 0 0 0 14 18 V30" fill="none" stroke="currentColor" strokeWidth="6" />
          <path d="M6 28 H22 L14 40 Z" fill="currentColor" />
        </>
      );
      break;
    case "roundabout":
      shape = (
        <>
          <circle cx="24" cy="30" r="9" fill="none" stroke="currentColor" strokeWidth="5" />
          <path d="M24 4 L33 14 H15 Z" fill="currentColor" />
          <path d="M24 13 V19" stroke="currentColor" strokeWidth="5" />
        </>
      );
      break;
    case "arrive":
      shape = (
        <>
          <circle cx="24" cy="24" r="12" fill="none" stroke="currentColor" strokeWidth="6" />
          <circle cx="24" cy="24" r="4" fill="currentColor" />
        </>
      );
      break;
    default:
      shape = arrow(0); // "straight", or no maneuver yet (shown dimmed)
  }

  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      {shape}
    </svg>
  );
}

// A short note about the GPS, or null when everything is fine
function gpsNotice(status: LocationStatus, accuracyM: number | null): string | null {
  switch (status) {
    case "denied":
      return "Location access is blocked. Allow it in your browser settings.";
    case "unsupported":
      return "Location is not available on this device";
    case "idle":
    case "acquiring":
      return "Waiting for GPS…";
    case "unavailable":
      return "GPS unavailable right now, retrying…";
    case "delayed":
      return "Waiting for the next GPS reading…";
    case "lost":
      return "GPS signal lost, using your last known position";
    case "active":
      return accuracyM !== null && accuracyM > 100 ? `GPS accuracy ±${Math.round(accuracyM)} m` : null;
  }
}

type View = {
  icon: ManeuverKind | null;
  distance: string | null;
  text: string;
  sub: string | null;
  placeholder: boolean;
  warning: boolean;
};

function buildView(props: Props): View {
  const {
    maneuver,
    destinationName,
    arrived,
    offRoute,
    positionOnRoute,
    distanceFromRouteM,
    gpsStatus,
    gpsAccuracyM,
    hasTurnData,
  } = props;
  const notice = gpsNotice(gpsStatus, gpsAccuracyM);
  const heading = destinationName ? `Heading to ${destinationName}` : null;

  if (arrived) {
    return { icon: "arrive", distance: null, text: "You have arrived", sub: destinationName, placeholder: false, warning: false };
  }
  if (offRoute) {
    return {
      icon: null,
      distance: null,
      text: "You are off the route",
      sub: "Automatic rerouting isn't available yet",
      placeholder: true,
      warning: true,
    };
  }
  // The latest readings don't fit the route, but it isn't declared "off route" yet.
  // Don't keep showing a distance we can't vouch for.
  if (positionOnRoute === false) {
    return {
      icon: null,
      distance: null,
      text: "Checking your position on the route…",
      sub:
        distanceFromRouteM !== null ? `${Math.round(distanceFromRouteM)} m from the route` : null,
      placeholder: true,
      warning: true,
    };
  }
  if (maneuver) {
    return {
      icon: maneuver.kind,
      distance: formatManeuverDistance(maneuver.distanceMeters),
      text: maneuver.instruction,
      sub: notice,
      placeholder: false,
      warning: notice !== null,
    };
  }
  // No instruction to show, and we say honestly why
  if (notice) {
    return { icon: null, distance: null, text: notice, sub: heading, placeholder: true, warning: false };
  }
  return {
    icon: null,
    distance: null,
    text: hasTurnData ? "Locating you on the route…" : "No turn-by-turn data for this route",
    sub: heading,
    placeholder: true,
    warning: false,
  };
}

export default function InstructionPanel(props: Props) {
  const view = buildView(props);

  return (
    <section
      className={props.open ? "nav-panel nav-top is-open" : "nav-panel nav-top"}
      aria-label="Next instruction"
    >
      <div className={view.placeholder ? "nav-icon is-placeholder" : "nav-icon"}>
        <ManeuverIcon kind={view.icon} />
      </div>

      <div className="nav-instruction" aria-live="polite">
        {view.distance && <div className="nav-distance">{view.distance}</div>}
        <div className={view.placeholder ? "nav-text is-placeholder" : "nav-text"}>{view.text}</div>
        {view.sub && <div className={view.warning ? "nav-sub is-warning" : "nav-sub"}>{view.sub}</div>}
      </div>
    </section>
  );
}