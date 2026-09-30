export const GITHUB_HOST = "github.com";

/** Where a person creates a classic token with the scopes Gossamr reads with already ticked. */
export const CLASSIC_TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo,read:org,notifications&description=Gossamr";
export const FINE_GRAINED_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/**
 * The address when it is safe to hand to the system browser: https, no credentials, no port, and a GitHub host. Other
 * schemes, such as `javascript:` or `file:`, and look-alike hosts come back null.
 */
export function safeGithubUrl(raw: string, extraHosts: readonly string[] = []): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const hosts = [GITHUB_HOST, ...extraHosts].map((h) => h.toLowerCase());
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return hosts.includes(url.hostname.toLowerCase()) ? url.href : null;
}

export interface PullRef {
  /** `owner/name`. */
  repo: string;
  number: number;
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const NAME = "[A-Za-z0-9._-]{1,100}";
const SHORT = new RegExp(`^(${OWNER})/(${NAME})#(\\d{1,7})$`);
const PATH = new RegExp(`^/(${OWNER})/(${NAME})/pull/(\\d{1,7})(?:/.*)?$`);

/** A pull request named as `owner/name#123` or by the address of its page. */
export function parsePullRef(text: string, extraHosts: readonly string[] = []): PullRef | null {
  const t = text.trim();
  const short = SHORT.exec(t);
  if (short) return { repo: `${short[1]}/${short[2]}`, number: Number(short[3]) };
  const safe = safeGithubUrl(/^github\.com\//i.test(t) ? `https://${t}` : t, extraHosts);
  const hit = safe && PATH.exec(new URL(safe).pathname);
  return hit ? { repo: `${hit[1]}/${hit[2]}`, number: Number(hit[3]) } : null;
}

export const pullLabel = (ref: PullRef) => `${ref.repo}#${ref.number}`;
