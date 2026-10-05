import { Popup, type GeoJSONSource, type Map } from "maplibre-gl";
import "./cameras.css";
import type { RouteCamera } from "./osmCameras";
import { speedLimitLabel, speedUnitWasAssumed } from "./osmTags";

const SOURCE_ID = "cameras";
const LAYER_ID = "camera-icons";
const ICON_SPEED = "veode-camera-speed";
const ICON_OTHER = "veode-camera-other";

const EMPTY = { type: "FeatureCollection" as const, features: [] };

// An original surveillance-camera icon: a chamfered dark badge with a glowing
// outline, and a wall-mounted camera (mount plate, arm, body, lens hood, lens).
// The colour is a parameter, so one drawing gives both states.
function cameraSvg(color: string): string {
  const dark = "#0b0d12";
  const badge = "14,5 50,5 59,14 59,50 50,59 14,59 5,50 5,14";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <defs><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>
  <polygon points="${badge}" fill="none" stroke="${color}" stroke-width="3" opacity="0.75" filter="url(#glow)"/>
  <polygon points="${badge}" fill="${dark}" stroke="${color}" stroke-width="2.5"/>
  <rect x="11" y="16" width="4" height="30" rx="1.5" fill="${color}"/>
  <path d="M13 43 L27 36" stroke="${color}" stroke-width="3" stroke-linecap="round"/>
  <rect x="16" y="21" width="27" height="15" rx="3" fill="${color}"/>
  <path d="M43 23 L52 19 L52 38 L43 34 Z" fill="${color}"/>
  <circle cx="47.5" cy="28.5" r="2.6" fill="${dark}"/>
  <rect x="21" y="25" width="10" height="3" rx="1.5" fill="${dark}" opacity="0.55"/>
</svg>`;
}

// Turns an SVG string into a MapLibre image
async function addSvgIcon(map: Map, name: string, svg: string) {
  const image = new Image(64, 64);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  // pixelRatio 2: the 64px drawing is shown 32px wide, so it stays sharp on retina screens
  if (!map.hasImage(name)) map.addImage(name, image, { pixelRatio: 2 });
}

function addLine(parent: HTMLElement, className: string, text: string) {
  const line = document.createElement("div");
  line.className = className;
  line.textContent = text; // textContent (not innerHTML): OSM text can never inject HTML
  parent.appendChild(line);
}

function buildPopup(properties: Record<string, unknown>): HTMLElement {
  const kind = String(properties.kind ?? "other");
  const speed = String(properties.speed ?? "");
  const direction = String(properties.direction ?? "");
  const detail = String(properties.detail ?? "");

  const root = document.createElement("div");
  root.className = kind === "speed" ? "cam-popup" : "cam-popup is-other";

  addLine(root, "cam-title", String(properties.title ?? "Camera"));
  if (speed) addLine(root, "cam-speed", speed);
  else if (kind === "speed") addLine(root, "cam-speed is-unknown", "Speed limit unknown");
  if (properties.unitAssumed === "yes") {
    addLine(root, "cam-line", "Unit not stated in OSM (assumed km/h)");
  }
  if (direction) addLine(root, "cam-line", `Direction (as mapped): ${direction}`);
  if (detail) addLine(root, "cam-line", detail);
  addLine(root, "cam-line", "Mapped camera, not confirmed as active");
  addLine(root, "cam-source", "Source: OpenStreetMap");
  return root;
}

// TEMPORARY DIAGNOSTICS: counts distinct camera ids in a list of map features
function countIds(features: { properties: Record<string, unknown> | null }[]): number {
  const ids = new Set<string>();
  for (const feature of features) {
    const props: Record<string, unknown> = feature.properties ?? {};
    ids.add(String(props.id));
  }
  return ids.size;
}

export type CameraLayer = {
  setCameras: (cameras: RouteCamera[]) => void;
  destroy: () => void;
};

// Adds the camera source + layer + click popup. Call once, after the map style has loaded.
export async function createCameraLayer(map: Map): Promise<CameraLayer> {
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#c6ff00";
  const warn = css.getPropertyValue("--warn").trim() || "#ffb020";

  await addSvgIcon(map, ICON_SPEED, cameraSvg(accent));
  await addSvgIcon(map, ICON_OTHER, cameraSvg(warn));

  map.addSource(SOURCE_ID, { type: "geojson", data: EMPTY });
  map.addLayer({
    id: LAYER_ID,
    type: "symbol",
    source: SOURCE_ID,
    layout: {
      "icon-image": ["match", ["get", "kind"], "speed", ICON_SPEED, ICON_OTHER],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.55, 13, 0.8, 17, 1.1],
      // Never hide a camera because another label or icon is nearby
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });

  const popup = new Popup({ className: "veode-popup", offset: 18, maxWidth: "280px" });

  map.on("click", LAYER_ID, (event) => {
    const feature = event.features?.[0];
    if (!feature || feature.geometry.type !== "Point") return;
    const lng = feature.geometry.coordinates[0];
    const lat = feature.geometry.coordinates[1];
    if (lng === undefined || lat === undefined) return;

    popup.setLngLat([lng, lat]).setDOMContent(buildPopup(feature.properties ?? {})).addTo(map);
  });
  map.on("mouseenter", LAYER_ID, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", LAYER_ID, () => {
    map.getCanvas().style.cursor = "";
  });

  return {
    setCameras(cameras) {
      popup.remove(); // a popup for a camera that is about to disappear must go too
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) {
        console.warn("Veode cameras: setCameras was called but the camera source is missing");
        return;
      }

      console.log(`Veode cameras: setCameras received=${cameras.length}`);

      source.setData({
        type: "FeatureCollection",
        features: cameras.map((camera) => ({
          type: "Feature" as const,
          // Plain strings only (empty = unknown), which survive GeoJSON cleanly
          properties: {
            id: camera.osmId,
            kind: camera.kind,
            title: camera.title,
            speed: speedLimitLabel(camera.maxspeed) ?? "",
            unitAssumed: speedUnitWasAssumed(camera.maxspeed) ? "yes" : "",
            direction: camera.direction ?? "",
            detail: camera.enforcement ? `Enforcement: ${camera.enforcement}` : "",
          },
          geometry: { type: "Point" as const, coordinates: [camera.lon, camera.lat] },
        })),
      });

      // TEMPORARY DIAGNOSTICS: once the map has settled, check what it actually holds.
      // "renderedInView" only counts cameras inside the current screen.
      if (cameras.length > 0) {
        map.once("idle", () => {
          const hasLayer = Boolean(map.getLayer(LAYER_ID));
          const inSource = countIds(map.querySourceFeatures(SOURCE_ID));
          const renderedInView = hasLayer
            ? countIds(map.queryRenderedFeatures({ layers: [LAYER_ID] }))
            : 0;
          console.log(
            `Veode cameras: layer check received=${cameras.length} inSource=${inSource} ` +
              `renderedInView=${renderedInView} layerExists=${hasLayer} ` +
              `iconsLoaded=${map.hasImage(ICON_SPEED) && map.hasImage(ICON_OTHER)}`
          );
        });
      }
    },
    destroy() {
      popup.remove();
    },
  };
}