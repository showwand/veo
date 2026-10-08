import { useLayoutEffect } from "react";

// Keep the actions in a stable row instead of deriving positions from transformed buttons.
const GAP_PX = 10;

function find(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

export function layoutTopActions() {
  const party = find(".party-button");
  const favourites = find(".favourites-button");
  const account = find(".account-button");
  if (!party || !favourites || !account) return;
  const mobile = window.innerWidth <= 700;
  const size = mobile ? 42 : 44;
  const partySize = mobile ? size : 48;
  const top = "max(16px, env(safe-area-inset-top, 0px))";
  const safeRight = mobile
    ? "max(12px, env(safe-area-inset-right, 0px))"
    : "max(16px, env(safe-area-inset-right, 0px))";
  const setButton = (button: HTMLElement, rightOffset: number, buttonSize: number) => {
    button.style.top = top;
    button.style.right = `calc(${safeRight} + ${rightOffset}px)`;
    button.style.width = `${buttonSize}px`;
    button.style.height = `${buttonSize}px`;
    button.style.removeProperty("transform");
  };

  setButton(party, 0, partySize);
  setButton(account, partySize + GAP_PX, size);
  setButton(favourites, partySize + GAP_PX + size + GAP_PX, size);
}

export function useTopActionsLayout() {
  useLayoutEffect(() => {
    layoutTopActions();
    const frame = requestAnimationFrame(layoutTopActions); // once more after the page settles
    const timer = window.setTimeout(layoutTopActions, 400);
    window.addEventListener("resize", layoutTopActions);
    const mobileQuery = window.matchMedia("(max-width: 700px)");
    mobileQuery.addEventListener("change", layoutTopActions);

    const aside = document.querySelector(".nav-aside");
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(layoutTopActions) : null;
    if (aside) observer?.observe(aside);
    const buttons = [".party-button", ".favourites-button", ".account-button"]
      .map(find)
      .filter((button): button is HTMLElement => button !== null);
    buttons.forEach((button) => observer?.observe(button));

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.removeEventListener("resize", layoutTopActions);
      mobileQuery.removeEventListener("change", layoutTopActions);
      observer?.disconnect();
    };
  }, []);
}