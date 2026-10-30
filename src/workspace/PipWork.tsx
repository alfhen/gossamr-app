import { useEffect, useState, useSyncExternalStore } from "react";
import { CRAWL_PATH, SPIRAL, SPOKES } from "../lib/pipWeb";
import { WORD_EVERY_MS, elapsedText, shuffledWords } from "../lib/pipWork";
import { PipGlyph } from "../components/PipGlyph";
import { PipAvatar } from "./PipAvatar";

const SWAP_MS = 200;
const LIFT_MS = 500;

interface Word {
  text: string;
  swapping: boolean;
}

let word: Word = { text: "Spinning", swapping: false };
let deck: string[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let swapTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const publish = (next: Word) => {
  word = next;
  listeners.forEach((l) => l());
};

function advance() {
  if (!deck.length) deck = shuffledWords(word.text);
  const next = deck.shift()!;
  publish({ ...word, swapping: true });
  swapTimer = setTimeout(() => publish({ text: next, swapping: false }), SWAP_MS);
}

// One word at a time for the whole page, so the chip and the pane say the same one; the clock runs only while one is on screen.
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    deck = shuffledWords(null);
    word = { text: deck.shift()!, swapping: false };
    timer = setInterval(advance, WORD_EVERY_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      clearTimeout(swapTimer);
    }
  };
}

const usePipWord = () => useSyncExternalStore(subscribe, () => word, () => word);

function useElapsed(since: string | undefined) {
  const [text, setText] = useState("");
  useEffect(() => {
    const parsed = since ? Date.parse(since) : NaN;
    const start = Number.isNaN(parsed) ? Date.now() : parsed;
    const tick = () => setText(elapsedText(Date.now() - start));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);
  return text;
}

function Web() {
  return (
    <div data-pip-web className="pip-web-stage" aria-hidden>
      <svg className="pip-web" viewBox="0 0 120 80">
        <g className="pip-web-g">
          <g className="pip-web-spokes">
            {SPOKES.map((p, i) => (
              <line key={i} x1="60" y1="40" x2={p.x} y2={p.y} pathLength="1" />
            ))}
          </g>
          <path className="pip-web-spiral" d={SPIRAL} />
          <circle className="pip-web-dew" cx="78" cy="28" r="1.6" />
          <circle className="pip-web-dew" cx="44" cy="54" r="1.3" />
        </g>
      </svg>
      <span className="pip-crawler" style={{ offsetPath: `path("${CRAWL_PATH}")` }}>
        <PipAvatar size={22} thinking />
      </span>
    </div>
  );
}

/** Pip spinning a web where its answer will appear: a word for the mood, and under it a plain line of what Pip is doing. */
function PipWorking({ line, leaving, since }: { line: string; leaving: boolean; since?: string }) {
  const w = usePipWord();
  const elapsed = useElapsed(since);
  return (
    <div data-pip-working data-leaving={leaving ? "" : undefined} role="status" aria-live="polite" className="pip-work">
      <Web />
      <div className="grid min-w-0 gap-0.5">
        <span aria-hidden data-pip-word className={`pip-verb ${w.swapping ? "swap" : ""}`}>
          {w.text}…
        </span>
        <span className="text-xs text-ws-ink2">
          {line}
          {elapsed && (
            <span aria-hidden className="tabular-nums">
              {" · "}
              {elapsed}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/** Shows the web while `working`, then lifts it away for half a second as the answer arrives. */
export function PipWorkSlot({ working, line, since }: { working: boolean; line: string; since?: string }) {
  const [leaving, setLeaving] = useState(false);
  const [was, setWas] = useState(working);
  // Set while rendering, not in an effect, so the web that is showing stays mounted and transitions away.
  if (was !== working) {
    setWas(working);
    setLeaving(!working);
  }
  useEffect(() => {
    if (!leaving) return;
    const id = setTimeout(() => setLeaving(false), LIFT_MS);
    return () => clearTimeout(id);
  }, [leaving]);
  if (!working && !leaving) return null;
  return <PipWorking line={line} leaving={!working} since={since} />;
}

/** Beside the launcher while the pane is closed and Pip works, so Pip is seen busy from anywhere. */
export function PipWorkChip() {
  const w = usePipWord();
  return (
    <span data-pip-chip aria-hidden className="ws-glass ws-glass-pip ws-glass-regular flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-ws-ink [box-shadow:var(--glass-inner-pip),var(--glass-depth)]">
      <PipGlyph className="text-ws-pip" />
      <span className={`pip-verb ${w.swapping ? "swap" : ""}`}>{w.text}…</span>
    </span>
  );
}
