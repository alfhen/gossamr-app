/** The scopes Gossamr's Jira client needs. A token's scopes can't change, so a new one is needed if this list grows. */
export const JIRA_SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user"] as const;

export const TOKEN_PAGE_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** Atlassian's token page with the app, scopes and the longest expiry the organisation allows already filled in. */
export const CREATE_TOKEN_URL = `${TOKEN_PAGE_URL}?autofillToken&expiryDays=max&appId=jira&selectedScopes=${encodeURIComponent(JSON.stringify(JIRA_SCOPES))}`;

/** Days before the expiry that Gossamr starts saying so (`EXPIRY_WARNING_DAYS` in `src-tauri/src/auth/mod.rs`). */
export const EXPIRY_WARNING_DAYS = 14;

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` in the local calendar, which is the day the Rust side compares against. */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Atlassian doesn't report a token's expiry, so the sheet starts at the longest a token lasts: a year from today. */
export function defaultExpiry(now: Date = new Date()): string {
  return isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 365));
}
