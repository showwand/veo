import type { Point, Route } from "./routing";
import { decodePolyline, isRecord, makeProviderRoute } from "./routeProviderUtils";

const DEFAULT_VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";
const CONFIGURED_VALHALLA_URL: unknown = import.meta.env.VITE_VALHALLA_URL;

type ValhallaLeg = {
  shape?: unknown;
  summary?: { length?: unknown; time?: unknown };
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function fetchWalkingRoute(
  start: Point,
  end: Point,
  signal: AbortSignal
): Promise<Route[]> {
  const endpoint =
    typeof CONFIGURED_VALHALLA_URL === "string" && CONFIGURED_VALHALLA_URL.trim()
      ? CONFIGURED_VALHALLA_URL.trim()
      : DEFAULT_VALHALLA_URL;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: [
        { lat: start.lat, lon: start.lon },
        { lat: end.lat, lon: end.lon },
      ],
      costing: "pedestrian",
      units: "kilometers",
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Walking route request failed (${response.status}).`);

  const payload: unknown = await response.json();
  const trip = isRecord(payload) && isRecord(payload.trip) ? payload.trip : null;
  const legs = trip && Array.isArray(trip.legs) ? (trip.legs as ValhallaLeg[]) : [];
  const leg = legs[0];
  if (!leg || typeof leg.shape !== "string") {
    const message =
      isRecord(payload) && typeof payload.status_message === "string"
        ? payload.status_message
        : "No walkable route was returned.";
    throw new Error(message);
  }

  const coordinates = decodePolyline(leg.shape, 6);
  const summary =
    leg.summary && isRecord(leg.summary)
      ? leg.summary
      : trip && isRecord(trip.summary)
        ? trip.summary
        : null;
  const lengthKm = finite(summary?.length);
  const durationSeconds = finite(summary?.time);
  if (durationSeconds === null) {
    throw new Error("The walking route did not include a travel time.");
  }

  return [
    makeProviderRoute(
      "walking",
      "Walking route",
      "walking",
      coordinates,
      lengthKm === null ? null : lengthKm * 1000,
      durationSeconds,
      "OpenStreetMap via Valhalla"
    ),
  ];
}
