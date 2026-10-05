import { cardinal, useHeadingInfo } from "./heading";
import { useLocationStatus } from "./userLocation";

// A small readout of which way Veode thinks you are facing, and WHERE that comes from.
// It says "No heading" instead of pretending when there is nothing real to show.
export default function HeadingBadge() {
  const heading = useHeadingInfo();
  const status = useLocationStatus();

  if (status === "idle" || status === "denied" || status === "unsupported") return null;

  const known = heading.degrees !== null;
  return (
    <div
      className={known ? "heading-badge" : "heading-badge is-none"}
      title={`Heading source: ${heading.label}`}
    >
      <span className="heading-value">
        {heading.degrees === null
          ? "No heading"
          : `${cardinal(heading.degrees)} ${Math.round(heading.degrees)}°`}
      </span>
      <span className="heading-source">{heading.label}</span>
    </div>
  );
}