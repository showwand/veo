import { useLayoutEffect } from "react";

// Lines the three top-right buttons up as  Favourites | Party | Account  (Account far right).
// I haven't seen PartyButton or hud.css, so this works by MEASURING the Party button where it
// naturally sits, putting Account in that spot, and sliding Party (with a CSS transform, so
// it works however Party is positioned) one button-width to the left. Favourites goes next to it.
const GAP_PX = 10;

function find(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

export function layoutTopActions() {
  const party = find(".party-button");
  const favourites = find(".favourites-button");
  const account = find(".account-button");
  if (!party || !favourites || !account) return;
  const parent = account.offsetParent;
  if (!(parent instanceof HTMLElement)) return;

  // Where Party sits WITHOUT our slide (we remember how far we slid it)
  const applied = Number(party.dataset.veodeShift ?? "0") || 0;
  const rect = party.getBoundingClientRect();
  if (rect.height === 0) return; // not visible: try again later

  const box = parent.getBoundingClientRect();
  const size = rect.height; // the new buttons are squares the same height as Party
  const top = rect.top - box.top;
  const naturalRight = box.right - (rect.right + applied); // gap from the right edge to Party's natural spot
  const shift = size + GAP_PX;

  account.style.top = `${top}px`;
  account.style.right = `${naturalRight}px`;
  account.style.width = `${size}px`;
  account.style.height = `${size}px`;

  party.style.transform = `translateX(${-shift}px)`;
  party.dataset.veodeShift = String(shift);

  favourites.style.top = `${top}px`;
  favourites.style.right = `${naturalRight + rect.width + shift + GAP_PX}px`;
  favourites.style.width = `${size}px`;
  favourites.style.height = `${size}px`;
}

export function useTopActionsLayout() {
  useLayoutEffect(() => {
    layoutTopActions();
    const frame = requestAnimationFrame(layoutTopActions); // once more after the page settles
    const timer = window.setTimeout(layoutTopActions, 400);
    window.addEventListener("resize", layoutTopActions);

    const aside = document.querySelector(".nav-aside");
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(layoutTopActions) : null;
    if (aside) observer?.observe(aside);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.removeEventListener("resize", layoutTopActions);
      observer?.disconnect();
    };
  }, []);
}