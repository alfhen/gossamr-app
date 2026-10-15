import { describe, expect, it } from "vitest";
import { maskSecret, newRiskQuote, newRisks, riskNote, risksIn } from "./riskyText";

describe("the pause before posting edited text", () => {
  it("finds a broad mention, and never a mention of a person", () => {
    for (const t of ["Heads up @everyone", "@here please look", "cc @All", "(@everyone)"]) expect(risksIn(t), t).toEqual(["broadcast"]);
    for (const t of ["cc @Mette Lund", "mail everyone@acme.com", "@alle-hands is a person", "ask everyone here", "@channelling"]) expect(risksIn(t), t).toEqual([]);
  });

  it("finds what looks like a secret by its shape, and leaves ordinary words alone", () => {
    const secrets = ["Password: hunter2", "the token = abcd1234", "api_key: sk_live_x", "AKIAIOSFODNN7EXAMPLE", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "-----BEGIN RSA PRIVATE KEY-----", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "sk-ant-api03-abcdefghijklmnopqrstu", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", "adgangskode: x1y2z3", "password is hunter22", "kodeord Hunter2xyz", "adgangskode Hunter2xyz", "the pass is hunter22", "my password hunter22"];
    for (const t of secrets) expect(risksIn(t), t).toEqual(["secret"]);
    for (const t of ["The password reset flow is broken", "Reset the token on login", "No secret here", "the token expired", "password reset flow", "kodeord er ikke sat", "Mette will update the docs"]) expect(risksIn(t), t).toEqual([]);
  });

  it("asks only about what an edit adds, so a draft that already said it is not stopped again", () => {
    expect(newRisks("Looks good", "Looks good @everyone\nPassword: hunter2")).toEqual(["broadcast", "secret"]);
    expect(newRisks("cc @everyone", "cc @everyone, thanks")).toEqual([]);
    expect(newRisks("cc @everyone", "cc @everyone\nPassword: hunter2")).toEqual(["secret"]);
    expect(newRisks("x", "cc @Mette")).toEqual([]);
  });

  it("pauses when the edit brings new text for a risk the draft already had, and not when that text is only moved", () => {
    expect(newRisks("Password: redacted", "Password: hunter22")).toEqual(["secret"]);
    expect(newRisks("token=ghp_aaaaaaaaaaaaaaaaaaaaaaaa", "token=ghp_bbbbbbbbbbbbbbbbbbbbbbbb")).toEqual(["secret"]);
    expect(newRisks("cc @here", "cc @here and @everyone")).toEqual(["broadcast"]);
    expect(newRisks("Password: hunter22\nThanks", "Thanks.\nPassword: hunter22")).toEqual([]);
    expect(newRisks("(@everyone) see below", "See below, @everyone")).toEqual([]);
    expect(newRisks("Password: Abcd1234", "Password: abcd1234")).toEqual(["secret"]);
    expect(newRisks("cc @Here", "cc @here")).toEqual([]);
  });

  it("says what it found in the person's words", () => {
    expect(riskNote(["broadcast"])).toMatch(/^Your edit mentions everyone .*Post anyway, or keep editing\?$/);
    expect(riskNote(["broadcast", "secret"])).toContain("and looks like a password, key or token");
  });

  it("quotes the first new match: a broad mention as written, a secret masked to its first two characters", () => {
    expect(newRiskQuote("Looks good", "Looks good, cc @Everyone")).toBe("@Everyone");
    expect(newRiskQuote("Looks good", "Password: hunter2")).toBe("hu…");
    expect(newRiskQuote("Looks good", "kodeord Hunter2xyz")).toBe("Hu…");
    expect(newRiskQuote("Looks good", "token=ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("gh…");
    expect(newRiskQuote("Looks good", "x AKIAIOSFODNN7EXAMPLE")).toBe("AK…");
    // The first by where it stands in the edit, and only what is new.
    expect(newRiskQuote("cc @everyone", "cc @everyone\nPassword: hunter2 and @here")).toBe("hu…");
    expect(newRiskQuote("x", "@here, then Password: hunter2")).toBe("@here");
    expect(newRiskQuote("cc @everyone", "cc @everyone, thanks")).toBeNull();
    expect(newRiskQuote("x", "cc @Mette")).toBeNull();
  });

  it("never lets the rest of a secret into the note", () => {
    for (const secret of ["hunter2", "ghp_abcdefghijklmnopqrstuvwxyz0123", "s3cr3tvalue"]) {
      expect(maskSecret(secret)).toBe(`${secret.slice(0, 2)}…`);
      expect(newRiskQuote("x", `Password: ${secret}`) ?? "").not.toContain(secret.slice(2));
    }
    expect(maskSecret("é")).toBe("é…");
  });

  it("puts the quote in the note", () => {
    expect(riskNote(["broadcast"], "@everyone")).toBe("Your edit mentions everyone (@everyone, @here or @all), not a person, at “@everyone”. Everyone on the ticket would see it once it is posted. Post anyway, or keep editing?");
    expect(riskNote(["secret"], "hu…")).toContain("looks like a password, key or token, at “hu…”.");
    expect(riskNote(["secret"])).not.toContain("“");
  });
});
