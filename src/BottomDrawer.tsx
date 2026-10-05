import { useCallback, useEffect, useRef, useState } from "react";

const EDGE_ZONE_PX = 60; // how close to the bottom edge the mouse must be
const HOVER_DELAY_MS = 200; // how long it must stay there before the drawer opens

type Mode = "map" | "friends";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// Custom graphic for MAP: a faint street grid, a route and a heading arrow
function MapArt() {
  return (
    <svg className="mode-art" viewBox="0 0 64 48" fill="none" aria-hidden="true">
      <path className="art-grid" d="M2 14 H62 M2 34 H62 M20 2 V46 M44 2 V46" />
      <path className="art-route" d="M6 42 H20 L28 26 H42 L50 14" />
      <path className="art-flow" d="M6 42 H20 L28 26 H42 L50 14" />
      <path className="art-fill" d="M55 6.5 L54 16.8 L45.8 11.3 Z" />
    </svg>
  );
}

// Custom graphic for FRIENDS: three linked nodes with a scanning ring
function FriendsArt() {
  return (
    <svg className="mode-art" viewBox="0 0 64 48" fill="none" aria-hidden="true">
      <path className="art-link" d="M12 36 L32 14 L52 36 Z" />
      <circle className="art-ring" cx="32" cy="14" r="10" />
      <circle className="art-node" cx="32" cy="14" r="5" />
      <circle className="art-fill" cx="32" cy="14" r="1.8" />
      <circle className="art-node" cx="12" cy="36" r="5" />
      <circle className="art-fill" cx="12" cy="36" r="1.8" />
      <circle className="art-node" cx="52" cy="36" r="5" />
      <circle className="art-fill" cx="52" cy="36" r="1.8" />
    </svg>
  );
}

export default function BottomDrawer({ open, onOpenChange }: Props) {
  const [mode, setMode] = useState<Mode>("map");

  // After the drawer is closed, the mouse must leave the bottom zone once
  // before it can open the drawer again (otherwise it would instantly re-open).
  const armedRef = useRef(true);

  const close = useCallback(() => {
    armedRef.current = false;
    onOpenChange(false);
  }, [onOpenChange]);

  // Open the drawer when the mouse rests near the bottom edge
  useEffect(() => {
    let timer: number | null = null;

    function clearTimer() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }

    function handlePointerMove(event: PointerEvent) {
      if (event.pointerType !== "mouse") return;

      const inZone = event.clientY >= window.innerHeight - EDGE_ZONE_PX;
      if (!inZone) {
        armedRef.current = true;
        clearTimer();
        return;
      }

      // Ignore if already open, not re-armed, dragging the map, or already waiting
      if (open || !armedRef.current || event.buttons !== 0 || timer !== null) {
        return;
      }

      timer = window.setTimeout(() => {
        timer = null;
        onOpenChange(true);
      }, HOVER_DELAY_MS);
    }

    window.addEventListener("pointermove", handlePointerMove);
    document.documentElement.addEventListener("mouseleave", clearTimer);
    return () => {
      clearTimer();
      window.removeEventListener("pointermove", handlePointerMove);
      document.documentElement.removeEventListener("mouseleave", clearTimer);
    };
  }, [open, onOpenChange]);

  // Pressing Escape closes the drawer
  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, close]);

  return (
    <div className={open ? "drawer is-open" : "drawer"}>
      <button
        type="button"
        className="drawer-handle"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="drawer-panel"
        onClick={() => (open ? close() : onOpenChange(true))}
      >
        <svg
          className="drawer-chevron"
          viewBox="0 0 24 12"
          width="22"
          height="11"
          aria-hidden="true"
        >
          <path
            d="M3 2 L12 10 L21 2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="square"
          />
        </svg>
      </button>

      <div id="drawer-panel" className="drawer-panel" aria-hidden={!open}>
        <div className="drawer-title">Modes</div>

        <div className="drawer-tiles">
          <button
            type="button"
            className={mode === "map" ? "mode-tile is-active" : "mode-tile"}
            aria-pressed={mode === "map"}
            onClick={() => {
              setMode("map");
              close();
            }}
          >
            <MapArt />
            <span className="mode-text">
              <span className="mode-name">Map</span>
              <span className="mode-sub">Navigation</span>
            </span>
          </button>

          <button
            type="button"
            className={mode === "friends" ? "mode-tile is-active" : "mode-tile"}
            aria-pressed={mode === "friends"}
            onClick={() => setMode("friends")}
          >
            <FriendsArt />
            <span className="mode-text">
              <span className="mode-name">Friends</span>
              <span className="mode-sub">Social</span>
            </span>
          </button>
        </div>

        <div
          className={
            mode === "friends" ? "drawer-status is-soon" : "drawer-status is-ok"
          }
          role="status"
        >
          {mode === "friends" ? (
            <>
              <span className="drawer-status-tag">Coming soon</span>
              <span>Live friend locations and group drives are on the way.</span>
            </>
          ) : (
            <>
              <span className="drawer-status-tag">Active</span>
              <span>Map mode</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}