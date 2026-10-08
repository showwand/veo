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

function createUserMarker(map: Map) {
  const root = document.createElement("div");
  root.className = "user-marker";
  const cone = document.createElement("div");
  cone.className = "user-cone";
  const dot = document.createElement("div");
  dot.className = "user-dot";
  const vehicle = document.createElement("div");
  vehicle.className = "user-vehicle";
  vehicle.innerHTML =
    '<svg viewBox="0 0 40 52" aria-hidden="true"><path d="M11 5 20 1l9 4 6 13v26l-6 6H11l-6-6V18L11 5Zm1 7-3 9h22l-3-9-5-3h-6l-5 3Zm-2 14v9h6v-9h-6Zm14 0v9h6v-9h-6Z" fill="currentColor" stroke="#080a0d" stroke-width="2" stroke-linejoin="round"/><path d="M15 5h10" stroke="#080a0d" stroke-width="2"/></svg>';
  root.append(cone, dot, vehicle);

  const marker = new Marker({ element: root, anchor: "center" });
  let added = false;
  let shown: number | null = null;
  let displayed: [number, number] | null = null;
  let target: [number, number] | null = null;
  let animationFrame: number | null = null;

  return {
    update(
      state: LocationState,
      heading: HeadingInfo,
      navigating: boolean,
      routeBearingDeg: number | null
    ) {
      const fix = state.fix;
      if (!fix) {
        if (added) marker.remove();
        added = false;
        displayed = null;
        target = null;
        if (animationFrame !== null) cancelAnimationFrame(animationFrame);
        animationFrame = null;
        return;
      }

      const next: [number, number] = [fix.lon, fix.lat];
      if (!added) {
        marker.setLngLat(next);
        displayed = next;
        target = next;
        marker.addTo(map);
        added = true;
      } else if (!target || target[0] !== next[0] || target[1] !== next[1]) {
        if (animationFrame !== null) cancelAnimationFrame(animationFrame);
        const from = displayed ?? next;
        const startedAt = performance.now();
        const duration = 220;
        target = next;
        const animate = (now: number) => {
          const progress = Math.min(1, (now - startedAt) / duration);
          const eased = 1 - Math.pow(1 - progress, 3);
          const position: [number, number] = [
            from[0] + (next[0] - from[0]) * eased,
            from[1] + (next[1] - from[1]) * eased,
          ];
          marker.setLngLat(position);
          displayed = position;
          if (progress < 1) animationFrame = requestAnimationFrame(animate);
          else animationFrame = null;
        };
        animationFrame = requestAnimationFrame(animate);
      }

      root.classList.toggle("is-navigating", navigating);
      root.classList.toggle("is-stale", state.status === "lost");
      root.classList.toggle("is-poor", fix.accuracyM > 100);

      if (navigating) {
        cone.style.opacity = "0";
        const direction =
          heading.source === "gps" || heading.source === "movement"
            ? heading.degrees
            : routeBearingDeg;
        if (direction !== null) {
          const relative = ((direction - map.getBearing()) % 360 + 360) % 360;
          shown =
            shown === null
              ? relative
              : shown + ((((relative - shown) % 360) + 540) % 360 - 180);
          vehicle.style.transform = `rotate(${shown}deg)`;
        }
        return;
      }

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
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
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

export function useUserMarker(
  mapRef: RefObject<Map | null>,
  mapReady: boolean,
  navigating: boolean,
  routeBearingDeg: number | null
) {
  const pendingCenter = useRef(false);
  const navigatingRef = useRef(navigating);
  const routeBearingRef = useRef(routeBearingDeg);
  const watching = useLocationWatching();

  useEffect(() => {
    navigatingRef.current = navigating;
    routeBearingRef.current = routeBearingDeg;
  }, [navigating, routeBearingDeg]);

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
      marker.update(state, getHeadingInfo(), navigatingRef.current, routeBearingRef.current);
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
    map.on("rotate", refresh);
    refresh();

    return () => {
      offLocation();
      offHeading();
      map.off("rotate", refresh);
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