/**
 * What makes the person pause before posting words they edited: a broad mention (@everyone, @here, Jira's @all) or text that looks
 * like a secret. A mention of one person is never a reason. It is a confirm step the person can pass, not a block.
 */
export type Risk = "broadcast" | "secret";

const BROADCAST = /(^|[^\w@.])@(everyone|here|channel|all)(?![\w-])/i;

/** Credentials by their shape: a private key block, a cloud or API key, a token, a JWT, a "password: …" line. */
const SECRETS: RegExp[] = [
  // The key's body too, to its END line, or as much of it as was pasted: the header alone would leave the key itself showing.
  // Without an END line only base64-looking runs count (a digit, + / =, or a capital after the first letter), so the prose after stays.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|(?:\s+(?=[A-Za-z0-9+/=]*(?:[0-9+/=]|[A-Za-z][A-Z]))[A-Za-z0-9+/=]+)*)/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bATATT[A-Za-z0-9_=-]{20,}/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  // A credential inside a URL: scheme://user:pass@host. The userinfo ends at the authority boundary (/, ? or #), so "?next=a:b@c" is a query.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:[^\s@/?#]+@/i,
  /\b(?:password(?:et)?|passwd|pwd|passphrase|adgangskode(?:n|t)?|kodeord(?:et)?|secret|token|api[ _-]?key|access[ _-]?key|client[ _-]?secret)\s*(?:(?:is|er)\s*)?[:=]\s*["']?[^\s"']{4,}/i,
  // Without a colon ("password is hunter22", "kodeord Hunter2xyz"): only a value that looks like a credential, so "password reset flow" passes.
  /\b(?:password(?:et)?|passwd|pwd|passphrase|pass|adgangskode(?:n|t)?|kodeord(?:et)?)\s+(?:(?:is|er)\s+)?["']?(?=[^\s"']*\d)(?=[^\s"']*[A-Za-z])[^\s"']{6,}/i,
];

/** The risks `text` carries. */
export function risksIn(text: string): Risk[] {
  const found: Risk[] = [];
  if (BROADCAST.test(text)) found.push("broadcast");
  if (SECRETS.some((re) => re.test(text))) found.push("secret");
  return found;
}

/** One piece of text that carries a risk: as written, and where it starts. */
interface Found {
  risk: Risk;
  text: string;
  at: number;
}

/** Every broad mention and every secret-shaped run in `text`, as written, in the order they appear. */
function occurrences(text: string): Found[] {
  const all = (re: RegExp) => [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))];
  // A broad mention's match takes the character before the @ too; the mention itself is from the @ on, in any case.
  const mentions = all(BROADCAST).map((m) => ({ risk: "broadcast" as const, text: m[0].trim().slice(m[0].trim().indexOf("@")), at: m.index + m[0].indexOf("@") }));
  const secrets = SECRETS.flatMap(all).map((m) => ({ risk: "secret" as const, text: m[0].trim(), at: m.index }));
  return [...mentions, ...secrets].sort((a, b) => a.at - b.at);
}

/** The text in `text` that carries each risk. A secret keeps its case: a password that differs only in case is another password. */
function matchesIn(text: string): Record<Risk, Set<string>> {
  const found = occurrences(text);
  const of = (risk: Risk) => new Set(found.filter((f) => f.risk === risk).map((f) => (risk === "broadcast" ? f.text.toLowerCase() : f.text)));
  return { broadcast: of("broadcast"), secret: of("secret") };
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

/** The part of a secret-shaped match that is the secret: the token after "Bearer ", the value after "password:" or "kodeord ", the password of a URL, else the whole run. */
const secretPart = (match: string): string =>
  (/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(match) ? match : null) ??
  /^[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:([^\s@/?#]+)@$/i.exec(match)?.[1] ??
  /^Bearer\s+(.+)$/i.exec(match)?.[1] ??
  /^[A-Za-z][A-Za-z _-]*?\s*(?:(?:is|er)\s*)?[:=]\s*["']?(.+)$/i.exec(match)?.[1] ??
  /^(?:password(?:et)?|passwd|pwd|passphrase|pass|adgangskode(?:n|t)?|kodeord(?:et)?)\s+(?:(?:is|er)\s+)?["']?(.+)$/i.exec(match)?.[1] ??
  match;

/** A secret for the note: its first two characters and an ellipsis, never the rest. */
export const maskSecret = (secret: string): string => `${[...secret].slice(0, 2).join("")}…`;

/** `text` with each secret-shaped run's secret part masked (see `maskSecret`) and the rest kept; text without one comes back as it was. */
export function maskSecrets(text: string): string {
  let out = "";
  let from = 0;
  // Overlapping shapes ("token=ghp_…") are one run: the first, longest one is masked.
  for (const f of occurrences(text).filter((o) => o.risk === "secret").sort((a, b) => a.at - b.at || b.text.length - a.text.length)) {
    if (f.at < from) continue;
    const secret = secretPart(f.text);
    const start = f.at + f.text.lastIndexOf(secret);
    out += text.slice(from, start) + maskSecret(secret);
    from = start + secret.length;
  }
  return out + text.slice(from);
}

/** Between a quote and the line it stands on, in a quote of a draft of several lines: `hu…\t4` is "hu…" on line 4. */
const AT_LINE = "\t";

/** What the pause quotes for each new risk, in the order they stand in the text: a broad mention as written ("@everyone"), a secret masked ("hu…") or named by its kind ("a private key"), each with its line when the text has several. */
export type RiskQuotes = Partial<Record<Risk, string[]>>;

/**
 * Every piece of text, by where it stands in `edited`, that makes the edit risky for each risk (see `newRisks`), as the
 * pause quotes it: each distinct mention as written, each distinct secret by its first two characters (a private key as
 * "a private key", its first two characters being only dashes), and in a text of several lines the line each stands on. Empty when the edit adds none.
 */
export function newRiskQuote(original: string, edited: string): RiskQuotes {
  const had = matchesIn(original);
  const quotes: RiskQuotes = {};
  const seen = new Set<string>();
  // Two shapes can match the same run ("token=ghp_…" is a token line and a GitHub token): the first, longest one is the quote.
  let covered = -1;
  for (const f of occurrences(edited).sort((a, b) => a.at - b.at || b.text.length - a.text.length)) {
    if (f.risk === "secret" && f.at < covered) continue;
    if (f.risk === "secret") covered = f.at + f.text.length;
    const same = f.risk === "broadcast" ? f.text.toLowerCase() : f.text;
    if (had[f.risk].has(same) || seen.has(`${f.risk}:${same}`)) continue;
    seen.add(`${f.risk}:${same}`);
    const said = f.risk === "broadcast" ? f.text : f.text.startsWith("-----BEGIN") ? "a private key" : maskSecret(secretPart(f.text));
    // Where it stands, so the culprit can be found in a long draft: only for text of several lines, where it is of use.
    const line = edited.includes("\n") ? `${AT_LINE}${edited.slice(0, f.at).split("\n").length}` : "";
    (quotes[f.risk] ??= []).push(said + line);
  }
  return quotes;
}

/** How many quotes the pause lists before it says how many more there are. */
const QUOTES_SHOWN = 3;

/** “a”, “b” and “c” (each with “(line 4)” when it has one); past `QUOTES_SHOWN`, “a”, “b”, “c” and 2 more. */
function quoted(quotes: readonly string[]): string {
  const shown = quotes.slice(0, QUOTES_SHOWN).map((q) => {
    const [text, line] = q.split(AT_LINE);
    return `“${text}”${line ? ` (line ${line})` : ""}`;
  });
  const more = quotes.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
}

/** What the pause says, in the person's words: one sentence for each risk it found (with the text that tripped it, when `quotes` has it), then who would see it. The buttons carry the choice. */
export function riskNote(risks: readonly Risk[], quotes: RiskQuotes = {}, where = "the ticket", subject = "This draft"): string {
  const sentence = (r: Risk, i: number) => {
    const at = quotes[r]?.length ? quoted(quotes[r]!) : null;
    if (r === "broadcast") return `${i ? "It also mentions" : `${subject} mentions`} everyone ${at ? `at ${at}` : "(@everyone, @here or @all), not a person"}.`;
    return `${i ? "It also looks" : `${subject} looks`} like a password, key or token${at ? ` at ${at}` : ""}.`;
  };
  return `${risks.map(sentence).join(" ")} Everyone on ${where} would see it once it is posted.`;
}
