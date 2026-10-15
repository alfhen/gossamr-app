/**
 * What makes the person pause before posting words they edited: a broad mention (@everyone, @here, Jira's @all) or text that looks
 * like a secret. A mention of one person is never a reason. It is a confirm step the person can pass, not a block.
 */
export type Risk = "broadcast" | "secret";

const BROADCAST = /(^|[^\w@.])@(everyone|here|channel|all)(?![\w-])/i;

/** Credentials by their shape: a private key block, a cloud or API key, a token, a JWT, a "password: …" line. */
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bATATT[A-Za-z0-9_=-]{20,}/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /\b(?:password|passwd|pwd|passphrase|adgangskode|kodeord|secret|token|api[ _-]?key|access[ _-]?key|client[ _-]?secret)\s*(?:is\s*)?[:=]\s*["']?[^\s"']{4,}/i,
  // Without a colon ("password is hunter22", "kodeord Hunter2xyz"): only a value that looks like a credential, so "password reset flow" passes.
  /\b(?:password|passwd|pwd|passphrase|pass|adgangskode|kodeord)\s+(?:(?:is|er)\s+)?["']?(?=[^\s"']*\d)(?=[^\s"']*[A-Za-z])[^\s"']{6,}/i,
];

/** The risks `text` carries. */
export function risksIn(text: string): Risk[] {
  const found: Risk[] = [];
  if (BROADCAST.test(text)) found.push("broadcast");
  if (SECRETS.some((re) => re.test(text))) found.push("secret");
  return found;
}

/** The text in `text` that carries each risk: every broad mention and every secret-shaped run, as written. */
function matchesIn(text: string): Record<Risk, Set<string>> {
  const all = (re: RegExp) => [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))].map((m) => m[0].trim());
  // A broad mention's match takes the character before the @ too; the mention itself is from the @ on, in any case. A secret
  // keeps its case: a password that differs only in case is another password.
  return { broadcast: new Set(all(BROADCAST).map((m) => m.slice(m.indexOf("@")).toLowerCase())), secret: new Set(SECRETS.flatMap(all)) };
}

/**
 * The risks an edit adds: those of `edited` carried by text that `original` (what the draft said) did not hold. A risk the
 * draft already had counts again when the edit brings new text for it, so a placeholder replaced by a real password pauses.
 */
export const newRisks = (original: string, edited: string): Risk[] => {
  const had = matchesIn(original);
  const now = matchesIn(edited);
  return (["broadcast", "secret"] as const).filter((r) => [...now[r]].some((m) => !had[r].has(m)));
};

/** What the pause says, in the person's words: what it found, then that nothing is lost by stopping. */
export function riskNote(risks: readonly Risk[]): string {
  const what = risks.map((r) => (r === "broadcast" ? "mentions everyone (@everyone, @here or @all), not a person" : "looks like a password, key or token")).join(" and ");
  return `Your edit ${what}. Everyone on the ticket would see it once it is posted. Post anyway, or keep editing?`;
}
