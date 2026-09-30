const target = new EventTarget();

/** Tells the app the person signed out, so it can drop the account's state and show sign-in. */
export const announceSignedOut = () => target.dispatchEvent(new Event("signed-out"));

export function onSignedOut(listener: () => void): () => void {
  target.addEventListener("signed-out", listener);
  return () => target.removeEventListener("signed-out", listener);
}
