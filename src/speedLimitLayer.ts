import type { GeoJSONSource, Map } from "maplibre-gl";
import type { SpeedLimitSign } from "./speedLimitSections";

const SOURCE_ID = "speed-limit-signs";
const LAYER_ID = "speed-limit-icons";

const EMPTY = { type: "FeatureCollection" as const, features: [] };

function iconName(mph: number): string {
  return `veode-speed-${mph}`;
}

// A UK-style speed limit sign: red ring, white centre, black number.
// Drawn at 48 px and shown at 24 px (pixelRatio 2), smaller than the camera icons.
function signSvg(mph: number): string {
  const text = String(mph);
  const fontSize = text.length >= 3 ? 19 : 24;
  const baseline = 24 + fontSize * 0.35; // puts the digits in the visual middle
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <circle cx="24" cy="24" r="23.5" fill="#000000" opacity="0.45"/>
  <circle cx="24" cy="24" r="22" fill="#d6191f"/>
  <circle cx="24" cy="24" r="15.5" fill="#ffffff"/>
  <text x="24" y="${baseline}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${fontSize}" fill="#111111">${text}</text>
</svg>`;
}

// Makes the image for one speed the first time it is needed
async function ensureIcon(map: Map, mph: number) {
  const name = iconName(mph);
  if (map.hasImage(name)) return;

  const image = new Image(48, 48);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(signSvg(mph))}`;
  await image.decode();
  if (!map.hasImage(name)) map.addImage(name, image, { pixelRatio: 2 });
}

export type SpeedLimitLayer = {
  setSigns: (signs: SpeedLimitSign[]) => Promise<void>;
  destroy: () => void;
};

// Adds the speed-limit source + layer. Call once, after the map style has loaded.
// Call it BEFORE the camera layer so the signs draw underneath the cameras.
export function createSpeedLimitLayer(map: Map): SpeedLimitLayer {
  map.addSource(SOURCE_ID, { type: "geojson", data: EMPTY });
  map.addLayer({
    id: LAYER_ID,
    type: "symbol",
    source: SOURCE_ID,
    layout: {
      "icon-image": ["get", "icon"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.7, 13, 0.85, 17, 1],
      // Signs that would sit on top of each other are thinned out when zoomed out
      "icon-allow-overlap": false,
      "icon-padding": 6,
      // ...but signs never push away other icons or labels
      "icon-ignore-placement": true,
    },
  });

  // Every call gets a number. If a newer call arrives while an older one is still
  // making images, the older one gives up, so a previous route's signs can't reappear.
  let version = 0;
  let destroyed = false;

  return {
    async setSigns(signs) {
      const mine = ++version;
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;

      // Clearing is immediate: no waiting, no stale signs
      if (signs.length === 0) {
        source.setData(EMPTY);
        return;
      }

      try {
        const speeds = [...new Set(signs.map((sign) => sign.mph))];
        await Promise.all(speeds.map((mph) => ensureIcon(map, mph)));
      } catch (error) {
        console.warn("Veode: speed-limit sign images could not be created", error);
        return;
      }
      if (destroyed || mine !== version) return;

      source.setData({
        type: "FeatureCollection",
        features: signs.map((sign) => ({
          type: "Feature" as const,
          properties: {
            icon: iconName(sign.mph),
            mph: sign.mph,
            raw: sign.raw ?? "",
            atMeters: Math.round(sign.atMeters),
          },
          geometry: { type: "Point" as const, coordinates: [sign.lon, sign.lat] },
        })),
      });
    },
    destroy() {
      destroyed = true;
      version++;
    },
  };
}