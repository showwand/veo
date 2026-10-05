import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Marker, type Map } from "maplibre-gl";
import {
  MAX_USABLE_ACCURACY_M,
  getLocationState,
  releaseLocation,
  requestLocation,
  subscribeLocation,
  useLocationWatching,
  type LocationState,
} from "./userLocation";
import {
  requestOrientationPermission,
  startOrientation,
  stopOrientation,
} from "./deviceOrientation";
import { getHeadingInfo, subscribeHeading, type HeadingInfo } from "./heading";

const CENTER_ZOOM = 14.5;

// Draws the location dot and the direction cone. The marker sits at EXACTLY the reported
// coordinate: no smoothing, no snapping. The map itself is never rotated.
function createUserMarker(map: Map) {
  const root = document.createElement("div");
  root.className = "user-marker";
  const cone = document.createElement("div");
  cone.className = "user-cone";
  const dot = document.createElement("div");
  dot.className = "user-dot";
  root.append(cone, dot);

  const marker = new Marker({ element: root, anchor: "center" });
  let added = false;
  // The angle we are showing. It is allowed to go past 360 (e.g. 365), so a turn
  // from 359 to 1 degree is drawn as a 2 degree turn, not a 358 degree spin back.
  let shown: number | null = null;

  return {
    update(state: LocationState, heading: HeadingInfo) {
      const fix = state.fix;
      if (!fix) {
        if (added) marker.remove();
        added = false;
        return;
      }

      marker.setLngLat([fix.lon, fix.lat]);
      if (!added) {
        marker.addTo(map);
        added = true;
      }

      root.classList.toggle("is-stale", state.status === "lost");
      root.classList.toggle("is-poor", fix.accuracyM > 100);

      if (heading.degrees === null) {
        cone.style.opacity = "0";
        return;
      }
      shown =
        shown === null
          ? heading.degrees
          : shown + ((((heading.degrees - shown) % 360) + 540) % 360 - 180);
      // Travel directions get a narrow wedge, the compass a wide one
      cone.classList.toggle("is-movement", heading.source === "gps" || heading.source === "movement");
      cone.style.opacity = "1";
      cone.style.transform = `rotate(${shown}deg)`;
    },
    remove() {
      marker.remove();
      added = false;
    },
  };
}

// Moves the map to the user's last known position
function centerOnUser(map: Map): boolean {
  const fix = getLocationState().fix;
  if (!fix) return false;
  map.easeTo({
    center: [fix.lon, fix.lat],
    zoom: Math.max(map.getZoom(), CENTER_ZOOM),
    duration: 1000,
    essential: true,
  });
  return true;
}

export function useUserMarker(mapRef: RefObject<Map | null>, mapReady: boolean) {
  const pendingCenter = useRef(false);
  const watching = useLocationWatching();

  // If the user already allowed location for this site, start showing it straight away
  useEffect(() => {
    if (!("permissions" in navigator)) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: "geolocation" })
      .then((status) => {
        if (!cancelled && status.state === "granted") requestLocation("view");
      })
      .catch(() => {
        // Some browsers can't answer this question. The Locate button still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Stop the GPS watcher when the map screen goes away
  useEffect(() => {
    return () => {
      releaseLocation("view");
      releaseLocation("navigation");
    };
  }, []);

  // The compass only listens while GPS is on
  useEffect(() => {
    if (!watching) return;
    startOrientation();
    return () => stopOrientation();
  }, [watching]);

  // The marker follows the location and heading stores directly
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const marker = createUserMarker(map);
    const refresh = () => {
      const state = getLocationState();
      marker.update(state, getHeadingInfo());
      if (
        pendingCenter.current &&
        state.fix &&
        state.fix.accuracyM <= MAX_USABLE_ACCURACY_M * 5 &&
        centerOnUser(map)
      ) {
        pendingCenter.current = false;
      }
    };

    const offLocation = subscribeLocation(refresh);
    const offHeading = subscribeHeading(refresh);
    refresh();

    return () => {
      offLocation();
      offHeading();
      marker.remove();
    };
  }, [mapRef, mapReady]);

  // The Locate button. Called from a click, which is what iOS needs for the compass prompt.
  const locate = useCallback(() => {
    requestLocation("view");
    void requestOrientationPermission();
    const map = mapRef.current;
    if (map && centerOnUser(map)) return;
    pendingCenter.current = true; // centre as soon as the first position arrives
  }, [mapRef]);

  return { locate };
}