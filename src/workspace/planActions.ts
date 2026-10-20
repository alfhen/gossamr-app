import { useWorkView } from "./workViewStore";
import { useTabs } from "./tabsStore";

/** ⌘K "Plan my week" and the link on Start my day: Agents, with the plan open above the list and the keyboard on it. */
export function showPlanMyWeek() {
  useWorkView.getState().closeDecision();
  useWorkView.getState().setPlanOpen(true);
  useTabs.getState().setRoute("agents");
  // The card mounts on the next render, once Agents is on screen.
  let tries = 0;
  const focus = () => {
    const card = document.querySelector<HTMLElement>("[data-plan-my-week]");
    if (card) return (card.querySelector<HTMLElement>("[data-plan-pick]") ?? card).focus();
    if (++tries < 60) requestAnimationFrame(focus);
  };
  requestAnimationFrame(focus);
}
