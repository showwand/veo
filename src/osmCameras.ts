import type { OsmNode, OsmTags } from "./osm";
import { cleanTag, parseMaxspeed, type SpeedLimit } from "./osmTags";

// "speed"  = OSM says this enforces speed (highway=speed_camera, enforcement=maxspeed
//            or average_speed)
// "other"  = it has enforcement=* but not a speed value we recognise
//            (traffic_signals, bus_lane, or something we don't understand).
//            We keep the raw value and do not claim what it is.
export type CameraKind = "speed" | "other";

export type OsmCamera = {
  osmId: number;
  lat: number;
  lon: number;
  kind: CameraKind;
  title: string; // factual wording for the popup
  maxspeed: SpeedLimit | null;
  direction: string | null; // as a readable string, or null if OSM doesn't say
  enforcement: string | null; // the raw enforcement=* value
  cameraType: string | null; // the raw camera:type=* value
  tags: OsmTags; // everything OSM said, preserved
};

// A camera found near the selected route
export type RouteCamera = OsmCamera & {
  distanceAlongRoute: number; // metres from the start of the route
  distanceFromRoute: number; // metres sideways from the route line
};

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// "90" -> "90° (E)"; words such as "forward" are kept as OSM wrote them
function describeDirection(raw: string | null): string | null {
  if (!raw) return null;
  if (/^\d{1,3}(\.\d+)?$/.test(raw)) {
    const degrees = Number(raw) % 360;
    const point = COMPASS[Math.round(degrees / 45) % 8] ?? "";
    return `${Math.round(degrees)}° (${point})`;
  }
  return raw;
}

// TEMPORARY DIAGNOSTICS: why parseCamera would say no. Null means "it IS a camera".
export function cameraRejectionReason(node: OsmNode): string | null {
  const { tags } = node;
  if (tags.highway === "speed_camera") return null;
  if (cleanTag(tags.enforcement)) return null;
  if (tags.enforcement !== undefined) return "enforcement tag is empty";
  return "no highway=speed_camera and no enforcement tag";
}

// Turns an OSM node into a camera, or null if it isn't a camera/enforcement object
export function parseCamera(node: OsmNode): OsmCamera | null {
  const { tags } = node;
  const isSpeedCameraNode = tags.highway === "speed_camera";
  const enforcement = cleanTag(tags.enforcement);

  if (!isSpeedCameraNode && !enforcement) return null; // e.g. an ordinary traffic light

  const enforcementValues = (enforcement ?? "").split(";").map((v) => v.trim());
  const isAverage = enforcementValues.includes("average_speed");
  const isSpeed = isSpeedCameraNode || isAverage || enforcementValues.includes("maxspeed");

  let title: string;
  if (isAverage) title = "Average speed camera";
  else if (isSpeed) title = "Speed camera";
  else if (enforcementValues.includes("traffic_signals")) title = "Traffic signal enforcement";
  else title = "Other enforcement";

  return {
    osmId: node.id,
    lat: node.lat,
    lon: node.lon,
    kind: isSpeed ? "speed" : "other",
    title,
    maxspeed: parseMaxspeed(tags.maxspeed),
    direction: describeDirection(cleanTag(tags.direction) ?? cleanTag(tags["camera:direction"])),
    enforcement,
    cameraType: cleanTag(tags["camera:type"]),
    tags,
  };
}