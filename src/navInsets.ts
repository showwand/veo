import type { Map } from "maplibre-gl";

// How much of the map the black panels (and the route card) cover at the top and bottom.
// Measured from the real page, so the car is centred in the VISIBLE gap on any screen.
// offsetHeight ignores CSS transforms, so the numbers are right even mid-animation.
export function getNavInsets(map: Map): { top: number; bottom: number } {
  const height = map.getContainer().clientHeight;
  const topPanel = document.querySelector<HTMLElement>(".nav-top")?.offsetHeight;
  const bottomPanel = document.querySelector<HTMLElement>(".nav-bottom")?.offsetHeight;
  const card =
    document.querySelector<HTMLElement>(".left-stack .route-option.is-selected")?.offsetHeight ?? 0;

  // If the panels can't be found, fall back to shares of the screen height
  if (topPanel === undefined || bottomPanel === undefined) {
    return { top: Math.round(height * 0.2), bottom: Math.round(height * 0.42) };
  }

  const top = topPanel;
  const bottom = bottomPanel + 12 + card; // the card sits 12 px above the bottom panel
  // Never let the two cover more than 80% of the map
  const limit = height * 0.8;
  const total = top + bottom;
  if (total <= limit) return { top, bottom };
  const scale = limit / total;
  return { top: Math.round(top * scale), bottom: Math.round(bottom * scale) };
}