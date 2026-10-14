import { usePipHome } from "./pipHomeStore";
import { useTabs } from "./tabsStore";

/** ⌘K "Plan my week" and the link on Start my day: Pip home, with the plan open above the timeline and the keyboard on it. */
export function showPlanMyWeek() {
  usePipHome.getState().closeDecision();
  usePipHome.getState().setPlanOpen(true);
  useTabs.getState().setRoute("pip");
  // The card mounts on the next render, once Pip home is on screen.
  let tries = 0;
  const focus = () => {
    const card = document.querySelector<HTMLElement>("[data-plan-my-week]");
    if (card) return (card.querySelector<HTMLElement>("[data-plan-pick]") ?? card).focus();
    if (++tries < 60) requestAnimationFrame(focus);
  };
  requestAnimationFrame(focus);
}
