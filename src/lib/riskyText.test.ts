import { describe, expect, it } from "vitest";
import { newRisks, riskNote, risksIn } from "./riskyText";

describe("the pause before posting edited text", () => {
  it("finds a broad mention, and never a mention of a person", () => {
    for (const t of ["Heads up @everyone", "@here please look", "cc @All", "(@everyone)"]) expect(risksIn(t), t).toEqual(["broadcast"]);
    for (const t of ["cc @Mette Lund", "mail everyone@acme.com", "@alle-hands is a person", "ask everyone here", "@channelling"]) expect(risksIn(t), t).toEqual([]);
  });

  it("finds what looks like a secret by its shape, and leaves ordinary words alone", () => {
    const secrets = ["Password: hunter2", "the token = abcd1234", "api_key: sk_live_x", "AKIAIOSFODNN7EXAMPLE", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "-----BEGIN RSA PRIVATE KEY-----", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "sk-ant-api03-abcdefghijklmnopqrstu", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4"];
    for (const t of secrets) expect(risksIn(t), t).toEqual(["secret"]);
    for (const t of ["The password reset flow is broken", "Reset the token on login", "No secret here", "Mette will update the docs"]) expect(risksIn(t), t).toEqual([]);
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
  });

  it("says what it found in the person's words", () => {
    expect(riskNote(["broadcast"])).toMatch(/^Your edit mentions everyone .*Post it anyway, or keep editing\?$/);
    expect(riskNote(["broadcast", "secret"])).toContain("and looks like a password, key or token");
  });
});
