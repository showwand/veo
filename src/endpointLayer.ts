import type { GeoJSONSource, Map } from "maplibre-gl";

const SOURCE_ID = "endpoints";
const LAYER_ID = "endpoint-pins";
const ICON_START = "veode-pin-start";
const ICON_END = "veode-pin-end";

const EMPTY = { type: "FeatureCollection" as const, features: [] };

// Anything with a latitude and longitude (your SearchResult fits this)
export type EndpointPlace = { lat: number; lon: number };

type PinKind = "start" | "end";

// An original map pin with a letter inside. The tip of the pin is at the bottom
// centre of the image, which is the point MapLibre places on the exact coordinate.
// start = dark pin, accent outline, accent "A"   (like the outlined A badge)
// end   = accent pin, dark "B"                   (like the solid B badge)
function pinSvg(kind: PinKind, accent: string, dark: string): string {
  const body = "M32 79 C32 79 8 50 8 29 A24 24 0 0 1 56 29 C56 50 32 79 32 79 Z";
  const isStart = kind === "start";

  const fill = isStart ? dark : accent;
  const stroke = isStart ? accent : dark;
  const letterColor = isStart ? accent : dark;

  // Letters are drawn as lines (not text), so they never depend on a font
  const letter = isStart
    ? "M23 41 L32 17 L41 41 M26.5 33 H37.5" // A
    : "M25 17 V41 H33 Q41 41 41 35 Q41 29.5 33 29.5 H25 M25 17 H32 Q39 17 39 23 Q39 29.5 32 29.5"; // B

  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="80" viewBox="0 0 64 80">
  <defs><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.4"/></filter></defs>
  <path d="${body}" fill="none" stroke="${accent}" stroke-width="4" opacity="0.8" filter="url(#glow)"/>
  <path d="${body}" fill="${fill}" stroke="${stroke}" stroke-width="3" stroke-linejoin="round"/>
  <path d="${letter}" fill="none" stroke="${letterColor}" stroke-width="4.5" stroke-linejoin="miter" stroke-linecap="butt"/>
</svg>`;
}

// Turns an SVG string into a MapLibre image
async function addSvgIcon(map: Map, name: string, svg: string) {
  const image = new Image(64, 80);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  // pixelRatio 2: the 64px drawing is shown 32px wide, so it stays sharp on retina screens
  if (!map.hasImage(name)) map.addImage(name, image, { pixelRatio: 2 });
}

export type EndpointLayer = {
  setEndpoints: (start: EndpointPlace | null, end: EndpointPlace | null) => void;
};

// Adds the start/destination source + layer. Call once, after the map style has loaded,
// and AFTER the route and camera layers so the pins draw on top of them.
export async function createEndpointLayer(map: Map): Promise<EndpointLayer> {
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#c6ff00";
  const dark = css.getPropertyValue("--bg-0").trim() || "#07080c";

  await addSvgIcon(map, ICON_START, pinSvg("start", accent, dark));
  await addSvgIcon(map, ICON_END, pinSvg("end", accent, dark));

  map.addSource(SOURCE_ID, { type: "geojson", data: EMPTY });
  map.addLayer({
    id: LAYER_ID,
    type: "symbol",
    source: SOURCE_ID,
    layout: {
      "icon-image": ["match", ["get", "kind"], "start", ICON_START, ICON_END],
      // The pin's tip (bottom centre) sits on the exact coordinate
      "icon-anchor": "bottom",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.7, 13, 0.9, 17, 1.1],
      // Never hide a pin because another label or icon is nearby
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });

  return {
    // Pass null to remove a pin. Calling this again moves the pins.
    setEndpoints(start, end) {
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;

      const places = [
        { kind: "start" as const, place: start },
        { kind: "end" as const, place: end },
      ];

      source.setData({
        type: "FeatureCollection",
        features: places.flatMap(({ kind, place }) =>
          place
            ? [
                {
                  type: "Feature" as const,
                  properties: { kind },
                  geometry: {
                    type: "Point" as const,
                    coordinates: [place.lon, place.lat],
                  },
                },
              ]
            : []
        ),
      });
    },
  };
}