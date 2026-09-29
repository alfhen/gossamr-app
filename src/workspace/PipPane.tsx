/** Docked to the right of the canvas; the assistant's conversation and drafts arrive here. */
export function PipPane({ onClose }: { onClose(): void }) {
  return (
    <aside aria-label="Pip" className="flex min-h-0 flex-col border-l border-ws-sep bg-ws-bar">
      <header data-tauri-drag-region className="flex items-center gap-2 border-b border-ws-sep px-4 pt-[14px] pb-2.5">
        <span className="size-2 rounded-full bg-ws-pip" aria-hidden />
        <h2 className="m-0 text-base font-semibold">Pip</h2>
        <button type="button" aria-label="Close Pip" onClick={onClose} className="ml-auto rounded px-1.5 text-lg leading-none text-ws-ink3 hover:bg-ws-hover">
          ×
        </button>
      </header>
      <p className="m-0 p-4 text-ws-ink3">Pip will answer here about what is on screen, and keep its drafts in reach.</p>
    </aside>
  );
}
