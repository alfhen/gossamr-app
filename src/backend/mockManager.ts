import { docFromText } from "../lib/docs";
import type { Intent, ItemRef, Run, RunVerdict } from "../types";

/** The Pip-as-manager prototype's scripted world: runs that finish one by one, and what Pip says about each. Nothing here is a real model call. */

export const MANAGER_REPO = "acme/webshop";
export const MANAGER_PROJECT = "CA";

export interface ManagerSeed {
  key: string;
  name: string;
  kind: Run["spec"]["kind"];
  minutesAgo: number;
  tokens: number;
  last: string;
  trail: [string, string][];
}

const STARTED = `Started in a worktree of ${MANAGER_REPO}, read-only`;

export const MANAGER_SEEDS: ManagerSeed[] = [
  { key: "CA-271", name: "ca-271-coupon-drop-6ef8", kind: "investigate", minutesAgo: 34, tokens: 96_000, last: "Reading src/cart/recalc.ts", trail: [["start", STARTED], ["read", "Read src/cart/coupons.ts"], ["read", "Read src/cart/recalc.ts"], ["run", "Ran pnpm test src/cart (12 passed)"]] },
  { key: "CA-401", name: "ca-401-free-shipping-77d0", kind: "investigate", minutesAgo: 27, tokens: 71_000, last: "Comparing shipping config files", trail: [["start", STARTED], ["read", "Read config/shipping.ts"], ["read", "Read src/shipping/rates.ts"]] },
  { key: "CA-355", name: "ca-355-category-stale-19be", kind: "investigate", minutesAgo: 22, tokens: 52_000, last: "Checking release notes for 4.12", trail: [["start", STARTED], ["run", "Tried to reproduce on the staging data (could not)"], ["read", "Read PR #209"]] },
  { key: "CA-388", name: "ca-388-address-timeout-c3f2", kind: "investigate", minutesAgo: 19, tokens: 88_000, last: "Reading src/checkout/address.ts", trail: [["start", STARTED], ["read", "Read src/checkout/address.ts"], ["run", "Replayed 40 slow requests from the log"]] },
  { key: "CA-412", name: "ca-412-verify-coupons-9a60", kind: "verify", minutesAgo: 12, tokens: 41_000, last: "Running the coupon tests", trail: [["start", STARTED], ["run", "Ran pnpm test src/cart/coupons (percentage cases pass)"]] },
];

export interface Finish {
  result: string;
  summary: string;
  tokens: number;
  /** The part meant for Jira, as the run wrote it. */
  note: string;
}

export const FINISH = {
  "CA-271": {
    result: "Cause found. applyCoupons() runs once on cart load. Editing a line item calls recalcCart(), which rebuilds the cart from cached prices and never re-applies the coupon.\n\nFor Jira:\nThe coupon is dropped when the cart is rebuilt after an edit. Re-running applyCoupons() at the end of recalcCart() fixes it; I did not change any code.",
    summary: "Found the cause: recalcCart() drops the coupon",
    tokens: 182_000,
    note: "The coupon is dropped when the cart is rebuilt after an edit. Re-running applyCoupons() at the end of recalcCart() fixes it.",
  },
  "CA-401": {
    result: "The free-shipping threshold is 499 DKK in config/shipping.ts. config/shipping.ts is not read for Denmark: the live value is 449 DKK in src/shipping/rates.ts, and the estimate widget compares against the 499 default.\n\nFor Jira:\nThe threshold is 499 DKK in config/shipping.ts, so a 460 DKK cart should still pay shipping.",
    summary: "Found two threshold values",
    tokens: 141_000,
    note: "The threshold is 499 DKK in config/shipping.ts, so a 460 DKK cart should still pay shipping.",
  },
  "CA-355": {
    result: "Could not reproduce on staging. PR #209 (cache invalidation on product delete) was merged and shipped in 4.12. No change needed.\n\nFor Jira:\nAlready fixed in 4.12 by PR #209. Nothing to do.",
    summary: "Could not reproduce: fixed by PR #209",
    tokens: 96_000,
    note: "Already fixed in 4.12 by PR #209. Nothing to do.",
  },
  "CA-388": {
    result: "Timeouts come from the old validation endpoint under load. Two ways forward and the tests pass with either.\n\nQuestion for you: should guest checkout keep the old endpoint (slow under load, stable) or move to the new one (fast, still in beta)?",
    summary: "Stopped on a question for the person",
    tokens: 157_000,
    note: "Should guest checkout keep the old endpoint or move to the new one?",
  },
  "CA-412": {
    result: "Checked percentage coupons: the totals are right and the tests pass. Fixed-amount coupons were not checked because they need the payment sandbox.\n\nFor Jira:\nPercentage coupons verified. Fixed-amount coupons not verified.",
    summary: "Verified percentage coupons only",
    tokens: 88_000,
    note: "Percentage coupons verified. Fixed-amount coupons not verified.",
  },
  "CA-412/2": {
    result: "Fixed-amount coupons verified using test/fixtures/sandbox.ts. A 100 DKK coupon on a 3-item cart: 300.00 DKK becomes 200.00 DKK, and stays correct after a quantity edit. Tests pass.\n\nFor Jira:\nFixed-amount coupons verified, before and after a quantity edit.",
    summary: "Verified fixed-amount coupons too",
    tokens: 61_000,
    note: "Fixed-amount coupons verified, before and after a quantity edit.",
  },
  rounding: {
    result: "Rounding happens per line item in src/checkout/vat.ts. Mixed-VAT carts can drift by 0.01 DKK.\n\nFor Jira:\nRounding happens per line item in src/checkout/vat.ts, so mixed-VAT carts drift by 0.01 DKK.",
    summary: "Found where the rounding happens",
    tokens: 120_000,
    note: "Rounding happens per line item in src/checkout/vat.ts, so mixed-VAT carts drift by 0.01 DKK.",
  },
} satisfies Record<string, Finish>;

export type FinishKey = keyof typeof FINISH;

export const ROUNDING_PROMPT =
  "Find out why the checkout total is wrong when rounding is involved. Start from src/checkout and the totals shown on the order summary. Report where the rounding happens, which carts are affected and how big the difference is. Stay read-only: do not change any code.";

export const ROUNDING_QUESTION = /round/i;

export const FOLLOW_UP_MESSAGE =
  "You checked percentage coupons only. The fixed-amount case does not need the live payment sandbox: use the fixtures in test/fixtures/sandbox.ts. Check a 100 DKK coupon on a 3-item cart, before and after editing a quantity, and report the totals. Stay read-only.";

export const FOLLOW_UP_REASON = "fixed-amount coupons were not checked";

export const SECOND_PASS_TRAIL: [string, string][] = [["read", "Read test/fixtures/sandbox.ts"], ["run", "Ran pnpm test src/cart/coupons (fixed-amount cases)"]];

/** What the run's own words ask the person: a question, not a result. */
export const QUESTION_OPTIONS = ["Keep the old endpoint", "Move to the new endpoint"];

const ref = (key: string): ItemRef => ({ connectionId: "mock", externalId: key, key });

export interface NoticeFacts {
  runId: string;
  key: string | null;
  passes: number;
  max: number;
  auto: boolean;
}

/** The message the app sends Pip when a run it reviews finishes. The policy is in it because Pip has no other way to know it. */
export function noticeText(run: Pick<Run, "id" | "item" | "spec">, passes: number, settings: { maxPasses: number; autoSendBack: boolean }, note: string): string {
  return [
    `[Gossamr notice] Run ${run.id} finished.`,
    `Ticket: ${run.item?.key ?? "none"}`,
    `Kind: ${run.spec.kind} (read-only)`,
    `Passes used: ${passes} of ${settings.maxPasses}`,
    `Send back automatically: ${settings.autoSendBack ? "on" : "off"}`,
    `The run's note for Jira: ${note}`,
  ].join("\n");
}

const NOTICE = /^\[Gossamr notice\] Run (\S+) finished\./;

export function parseNotice(prompt: string): NoticeFacts | null {
  const m = NOTICE.exec(prompt);
  if (!m) return null;
  const passes = /Passes used: (\d+) of (\d+)/.exec(prompt);
  return {
    runId: m[1],
    key: /Ticket: (\S+)/.exec(prompt)?.[1]?.replace(/^none$/, "") || null,
    passes: Number(passes?.[1] ?? 0),
    max: Number(passes?.[2] ?? 2),
    auto: /Send back automatically: on/.test(prompt),
  };
}

export interface ManagerDraft {
  intent: Intent;
  label: string | null;
  revision?: { note: string; was: string };
  /** Pip may send this without asking, because the person turned that on and the run has passes left. */
  sendsItself?: boolean;
}

export interface ManagerReply {
  steps: string[];
  text: string;
  drafts: ManagerDraft[];
  verdict: RunVerdict;
}

const comment = (key: string, body: string): Intent => ({ type: "comment", item: ref(key), body: docFromText(body) });

/** What Pip does about a finished run, or null when it has nothing to say and the run just shows "Checked by Pip". */
export function managerReply(n: NoticeFacts): ManagerReply | null {
  const verdict = (kind: RunVerdict["kind"], text: string): RunVerdict => ({ kind, text });
  switch (n.key ?? "none") {
    case "CA-271":
      return {
        steps: ["Read the run", "Compared its note with its answer", "Drafted a comment and a breakdown"],
        text: "Found the cause. The coupon is dropped when the cart is rebuilt after an edit: `recalcCart()` never re-applies it. The run's note and its full answer agree. I drafted a status comment and a breakdown into two subtasks. Nothing is posted until you approve.",
        drafts: [
          { intent: comment("CA-271", "Cause found: editing a line item calls recalcCart(), which rebuilds the cart from cached prices and drops the coupon. Fix: re-run applyCoupons() at the end of recalcCart(). No code was changed in this investigation."), label: null },
          { intent: { type: "subtasks", parent: ref("CA-271"), summaries: ["Re-apply coupons at the end of recalcCart() (src/cart/recalc.ts)", "Add a regression test: change a quantity with a percentage coupon applied"] }, label: "From an agent run" },
        ],
        verdict: verdict("drafted", "Pip proposed 2 drafts"),
      };
    case "CA-401":
      return {
        steps: ["Read the run", "Compared its note with its answer", "Corrected the comment"],
        text: "The run's note says the threshold is 499 DKK in `config/shipping.ts`, but its own answer says that file is not read for Denmark: the live value is 449 DKK in `src/shipping/rates.ts`. I trusted the answer and corrected the comment before showing it to you.",
        drafts: [
          {
            intent: comment("CA-401", "A 460 DKK Danish cart should get free shipping. The live threshold is 449 DKK in src/shipping/rates.ts; config/shipping.ts is not read for DK. The estimate widget compares against the 499 DKK default instead. Fix: read the market threshold in the widget."),
            label: null,
            revision: { note: "Corrected before you saw it: the note named 499 DKK in config/shipping.ts, the run's answer shows 449 DKK in src/shipping/rates.ts.", was: FINISH["CA-401"].note },
          },
        ],
        verdict: verdict("drafted", "Pip corrected a comment"),
      };
    case "CA-355":
      return null;
    case "CA-388":
      return {
        steps: ["Read the run"],
        text: "This run stopped on a question only you can answer, so I have not guessed. It is waiting in Waiting for you with its question. Your answer goes straight back to the run.",
        drafts: [],
        verdict: verdict("asked", "Pip asked you a question"),
      };
    case "CA-412": {
      if (n.passes === 0) {
        const itself = n.auto && n.passes < n.max;
        return {
          steps: ["Read the run", "Found the sandbox fixtures it skipped", "Drafted a follow-up"],
          text: itself
            ? `The run only verified percentage coupons. This is a read-only run and sending back automatically is on, so I sent the follow-up below without waiting (pass 1 of ${n.max}). It is in the run timeline.`
            : "The run only verified percentage coupons. The sandbox fixtures it skipped are in the repo, so another pass can finish the job. I drafted the exact message to send back. Read it, then approve.",
          drafts: [
            {
              intent: { type: "followUp", run: n.runId, item: ref("CA-412"), message: FOLLOW_UP_MESSAGE, reason: FOLLOW_UP_REASON, pass: n.passes + 1, max: n.max },
              label: null,
              sendsItself: itself,
            },
          ],
          verdict: verdict("sentBack", "Pip proposed a send-back"),
        };
      }
      return {
        steps: ["Read the run", "Drafted a comment"],
        text: `That covers it. ${n.passes} of ${n.max} passes used, so no further send-back. I drafted a status comment for CA-412 with both results.`,
        drafts: [
          { intent: comment("CA-412", "Verified: percentage coupons (pass 0) and fixed-amount coupons (pass 1). A 100 DKK coupon on a 3-item cart takes 300.00 DKK to 200.00 DKK and stays correct after a quantity edit. Tests pass."), label: null },
        ],
        verdict: verdict("drafted", "Pip proposed 1 draft"),
      };
    }
    default:
      return {
        steps: ["Read the run", "Drafted a ticket"],
        text: "Found it: VAT is rounded per line item in `src/checkout/vat.ts`, so mixed-VAT carts can drift by 0.01 DKK from the order total. This run has no ticket, so I drafted one with the cause and a fix outline. You decide whether it should exist.",
        drafts: [
          {
            intent: {
              type: "create",
              container: { connectionId: "mock", externalId: MANAGER_PROJECT },
              fields: {
                title: "Checkout VAT is rounded per line, totals drift by 0.01 on mixed-VAT carts",
                body: docFromText("Cause: src/checkout/vat.ts rounds VAT per line item before summing. On carts mixing 25% and 0% VAT lines the sum can differ from the order total by 0.01 DKK.\n\nFix outline: sum unrounded VAT per rate, round once per rate. Add a test with a 3-line mixed-VAT cart."),
                kind: "bug",
                assignee: null,
                parent: null,
                priority: null,
                labels: ["checkout", "vat"],
              },
              link: null,
            },
            label: null,
          },
        ],
        verdict: verdict("drafted", "Pip proposed a ticket"),
      };
  }
}

export const QUIET_VERDICT: RunVerdict = { kind: "nothing", text: "Checked by Pip: nothing to do" };

/** What the scenario asks of the sample backend. Only the sample backend has these. */
export interface ManagerApi {
  /** The run a scripted ticket belongs to. */
  managerRun(key: string): Run | null;
  /** Ends a run with a scripted answer. */
  managerFinish(runId: string, finish: Finish): Promise<Run>;
  /** Stops a run on a question for the person. */
  managerAsk(runId: string, question: string, options: string[], finish: Finish): Promise<Run>;
  /** Moves a run on one step towards finished: queued, launching, working. */
  managerAdvance(runId: string): Promise<Run | null>;
  /** Sets what Pip decided about a run. */
  managerVerdict(runId: string, verdict: RunVerdict): Promise<Run>;
  /** Puts the scripted pass that follows a send-back on the run's timeline. */
  managerSecondPass(runId: string): Promise<void>;
}
