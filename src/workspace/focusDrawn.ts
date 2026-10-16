/** Puts the keyboard on the element `find` returns once the page has drawn it, trying again for a few frames while focus is not on it (a button re-rendered in place may not be there yet, or may lose the focus to its section). */
export function focusWhenDrawn(find: () => Pick<HTMLElement, "focus"> | null, active: () => unknown, frame: (run: () => void) => unknown = requestAnimationFrame, tries = 3) {
  frame(() => {
    const el = find();
    el?.focus();
    if (tries > 1 && (!el || active() !== el)) focusWhenDrawn(find, active, frame, tries - 1);
  });
}

/** `focusWhenDrawn` for the offers' refocus, which also run where there is no page (the stores' tests). */
const onPage = (find: () => HTMLElement | null) => {
  if (typeof document !== "undefined" && typeof requestAnimationFrame !== "undefined") focusWhenDrawn(find, () => document.activeElement);
};

/** Puts the keyboard on workstream `id`'s row in Pip home's list once it is drawn: where it goes after Reopen, or an Undo that brought the workstream back. */
export const focusWorkstreamRow = (id: string) =>
  onPage(() => document.querySelector<HTMLElement>(`[data-workstream-row="${CSS.escape(id)}"]`));

/** Puts the keyboard back on "Bring them here" of workstream `id`'s notice, which an Undo of the adoption restored. */
export const focusAdoptButton = (id: string) =>
  onPage(() => document.querySelector<HTMLElement>(`[data-adopt-notice="${CSS.escape(id)}"] [data-adopt]`));

/** Puts the keyboard on the timeline once the runs and drafts brought into a workstream are in it: "Bring them here" went away with the click. */
export const focusAdopted = () => onPage(() => document.querySelector<HTMLElement>("[data-pip-home] [data-timeline]"));
