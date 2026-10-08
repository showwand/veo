import { useEffect, useRef, useState, type RefObject } from "react";
import type { Map } from "maplibre-gl";
import { getHeadingInfo } from "./heading";
import { MAX_USABLE_ACCURACY_M, getLocationState, subscribeLocation } from "./userLocation";

const FOLLOW_ZOOM = 16; // used only if the map is zoomed far out when following begins
const MIN_FOLLOW_ZOOM = 14.5;
const DEADBAND_PX = 12; // GPS wobble smaller than this never moves the camera
const FIRST_MOVE_MS = 1400; // the "travel back to the vehicle" move
const STEADY_MOVE_MS = 1000; // roughly one GPS reading apart, so motion looks continuous
// A jump bigger than this many screens is a teleport (a GPS jump or a simulated location),
// not driving: the camera jumps instead of gliding across the map
const TELEPORT_SCREENS = 2.5;

const linear = (t: number) => t;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

type Options = {
  mapRef: RefObject<Map | null>;
  mapReady: boolean;
  active: boolean; // navigation is running
  routeBearingDeg: number | null;
  // How much of the screen the black panels cover, so the car sits in the visible middle
  getInsets: (map: Map) => { top: number; bottom: number };
};

// The camera follows the car only while followUser is true.
// Dragging the map switches it off; the Follow button switches it back on.
// GPS keeps updating either way: this hook only controls the CAMERA.
export function useMapFollow({ mapRef, mapReady, active, routeBearingDeg, getInsets }: Options) {
  const [released, setReleased] = useState(false);
  const routeBearingRef = useRef(routeBearingDeg);
  const followUser = active && !released;

  useEffect(() => {
    routeBearingRef.current = routeBearingDeg;
  }, [routeBearingDeg]);

  // A real drag by the user releases the camera. Camera moves made by this hook
  // have no `originalEvent`, so they can never trigger this (no feedback loop).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onDragStart = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) setReleased(true);
    };
    map.on("dragstart", onDragStart);
    return () => {
      map.off("dragstart", onDragStart);
    };
  }, [mapRef, mapReady]);

  // While following: move the camera whenever the position changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !followUser) return;
    const m: Map = map;

    let first = true; // the first move after following (re)starts is the slow, smooth one

    function follow() {
      // No usable position = do nothing. We never move towards an invented location.
      const fix = getLocationState().fix;
      if (!fix || fix.accuracyM > MAX_USABLE_ACCURACY_M) return;

      const target: [number, number] = [fix.lon, fix.lat];
      const { clientWidth, clientHeight } = m.getContainer();
      const inset = getInsets(m);
      // Keep the vehicle around 72% down the viewport while leaving room above
      // the lower navigation panel. Insets remain a guard for unusually short screens.
      const targetY = Math.min(
        clientHeight * 0.74,
        clientHeight - inset.bottom - 36
      );
      const offset: [number, number] = [0, targetY - clientHeight / 2];

      const wanted = { x: clientWidth / 2 + offset[0], y: clientHeight / 2 + offset[1] };
      const now = m.project(target);
      const away = Math.hypot(now.x - wanted.x, now.y - wanted.y);

      const heading = getHeadingInfo();
      const travelBearing =
        heading.source === "gps" || heading.source === "movement" ? heading.degrees : null;
      const cameraBearing = travelBearing ?? routeBearingRef.current;

      if (!first && away < DEADBAND_PX) {
        if (cameraBearing !== null) {
          // Keep the heading-up view aligned even when the user is almost stationary.
          m.easeTo({
            bearing: cameraBearing,
            duration: STEADY_MOVE_MS,
            easing: linear,
            essential: true,
          });
        }
        return;
      }
      const teleport = !first && away > TELEPORT_SCREENS * Math.max(clientWidth, clientHeight);

      // The user's own zoom is respected; only a far-out map is brought in.
      const zoomIn = first && m.getZoom() < MIN_FOLLOW_ZOOM;
      m.easeTo({
        center: target,
        offset,
        ...(cameraBearing !== null ? { bearing: cameraBearing } : {}),
        ...(zoomIn ? { zoom: FOLLOW_ZOOM } : {}),
        duration: teleport ? 0 : first ? FIRST_MOVE_MS : STEADY_MOVE_MS,
        easing: first ? easeInOut : linear,
        essential: true,
      });
      first = false;
    }

    const unsubscribe = subscribeLocation(follow);
    follow(); // pressing Follow animates straight away
    return unsubscribe;
  }, [mapRef, mapReady, followUser, getInsets]);

  return { followUser, enableFollow: () => setReleased(false) };
}