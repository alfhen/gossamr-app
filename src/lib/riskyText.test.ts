import { describe, expect, it } from "vitest";
import { maskSecret, newRiskQuote, newRisks, riskNote, risksIn } from "./riskyText";

describe("the pause before posting edited text", () => {
  it("finds a broad mention, and never a mention of a person", () => {
    for (const t of ["Heads up @everyone", "@here please look", "cc @All", "(@everyone)"]) expect(risksIn(t), t).toEqual(["broadcast"]);
    for (const t of ["cc @Mette Lund", "mail everyone@acme.com", "@alle-hands is a person", "ask everyone here", "@channelling"]) expect(risksIn(t), t).toEqual([]);
  });

  it("finds what looks like a secret by its shape, and leaves ordinary words alone", () => {
    const secrets = ["Password: hunter2", "the token = abcd1234", "api_key: sk_live_x", "AKIAIOSFODNN7EXAMPLE", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "-----BEGIN RSA PRIVATE KEY-----", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "sk-ant-api03-abcdefghijklmnopqrstu", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", "adgangskode: x1y2z3", "password is hunter22", "kodeord Hunter2xyz", "adgangskode Hunter2xyz", "the pass is hunter22", "my password hunter22", "postgres://admin:secret@db/prod", "Adgangskoden er solsikke99", "mit password er: Kaffe123", "kodeordet er: Hunter2xyz", "Kodeordet Hunter2xyz"];
    for (const t of secrets) expect(risksIn(t), t).toEqual(["secret"]);
    for (const t of ["The password reset flow is broken", "Reset the token on login", "No secret here", "the token expired", "password reset flow", "kodeord er ikke sat", "https://example.com/path", "see https://acme.atlassian.net/browse/CA-1", "mail me at user@host.com", "adgangskoden er ikke sat", "Mette will update the docs"]) expect(risksIn(t), t).toEqual([]);
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

  it("says what it found in the person's words, one sentence for each risk", () => {
    expect(riskNote(["broadcast"])).toBe("Your edit mentions everyone (@everyone, @here or @all), not a person. Everyone on the ticket would see it once it is posted.");
    expect(riskNote(["broadcast", "secret"])).toBe("Your edit mentions everyone (@everyone, @here or @all), not a person. It also looks like a password, key or token. Everyone on the ticket would see it once it is posted.");
    expect(riskNote(["broadcast", "secret"])).not.toMatch(/keep editing|and looks like/i);
  });

  it("quotes the first new match of each risk: a broad mention as written, a secret masked to its first two characters", () => {
    expect(newRiskQuote("Looks good", "Looks good, cc @Everyone")).toEqual({ broadcast: ["@Everyone"] });
    expect(newRiskQuote("Looks good", "Password: hunter2")).toEqual({ secret: ["hu…"] });
    expect(newRiskQuote("Looks good", "kodeord Hunter2xyz")).toEqual({ secret: ["Hu…"] });
    // A bearer token is quoted by the token, not by the word in front of it; a URL by its password.
    expect(newRiskQuote("Looks good", "Bearer abcdefghijklmnopqrstuvwxyz")).toEqual({ secret: ["ab…"] });
    expect(newRiskQuote("Looks good", "token=ghp_abcdefghijklmnopqrstuvwxyz0123")).toEqual({ secret: ["gh…"] });
    expect(newRiskQuote("Looks good", "x AKIAIOSFODNN7EXAMPLE")).toEqual({ secret: ["AK…"] });
    expect(newRiskQuote("x", "postgres://admin:secret@db/prod")).toEqual({ secret: ["se…"] });
    expect(newRiskQuote("x", "postgres://admin:pw@db/prod")).toEqual({ secret: ["pw…"] });
    expect(newRiskQuote("x", "Adgangskoden er solsikke99")).toEqual({ secret: ["so…"] });
    expect(newRiskQuote("x", "mit password er: Kaffe123")).toEqual({ secret: ["Ka…"] });
    // Both risks are quoted, and only what is new.
    expect(newRiskQuote("cc @everyone", "cc @everyone\nPassword: hunter2 and @here")).toEqual({ secret: ["hu…"], broadcast: ["@here"] });
    expect(newRiskQuote("x", "@here, then Password: hunter2")).toEqual({ broadcast: ["@here"], secret: ["hu…"] });
    expect(newRiskQuote("cc @everyone", "cc @everyone, thanks")).toEqual({});
    expect(newRiskQuote("x", "cc @Mette")).toEqual({});
  });

  it("quotes each secret, not only the first, each by its first two characters, and each broad mention once (G26)", () => {
    const edited = "Password: hunter2\nand token=ghp_abcdefghijklmnopqrstuvwxyz0123\ncc @here @everyone @HERE";
    expect(newRiskQuote("x", edited)).toEqual({ secret: ["hu…", "gh…"], broadcast: ["@here", "@everyone"] });
    const note = riskNote(["broadcast", "secret"], newRiskQuote("x", edited));
    expect(note).toBe("Your edit mentions everyone at “@here” and “@everyone”. It also looks like a password, key or token at “hu…” and “gh…”. Everyone on the ticket would see it once it is posted.");
    for (const rest of ["nter2", "abcdefghij"]) expect(note).not.toContain(rest);
    // A secret that was already in the draft is not quoted again; a long list says how many more.
    expect(newRiskQuote("Password: hunter2", edited).secret).toEqual(["gh…"]);
    const many = riskNote(["secret"], { secret: ["aa…", "bb…", "cc…", "dd…", "ee…"] });
    expect(many).toBe("Your edit looks like a password, key or token at “aa…”, “bb…”, “cc…” and 2 more. Everyone on the ticket would see it once it is posted.");
  });

  it("stops a URL's userinfo at the authority boundary, so a query or path with a colon and an @ is not a credential", () => {
    expect(risksIn("postgres://admin:pw@db/prod")).toEqual(["secret"]);
    for (const t of ["https://example.com?next=abc:secret@host", "https://example.com/a:b@c", "https://example.com#a:b@c"]) {
      expect(risksIn(t), t).toEqual([]);
      expect(newRiskQuote("x", t), t).toEqual({});
    }
  });

  it("never lets the rest of a secret into the note", () => {
    for (const secret of ["hunter2", "ghp_abcdefghijklmnopqrstuvwxyz0123", "s3cr3tvalue"]) {
      expect(maskSecret(secret)).toBe(`${secret.slice(0, 2)}…`);
      expect(newRiskQuote("x", `Password: ${secret}`).secret?.join(" ") ?? "").not.toContain(secret.slice(2));
    }
    expect(maskSecret("é")).toBe("é…");
  });

  it("puts the quote in the note", () => {
    expect(riskNote(["broadcast"], { broadcast: ["@everyone"] })).toBe("Your edit mentions everyone at “@everyone”. Everyone on the ticket would see it once it is posted.");
    expect(riskNote(["secret"], { secret: ["hu…"] })).toBe("Your edit looks like a password, key or token at “hu…”. Everyone on the ticket would see it once it is posted.");
    expect(riskNote(["broadcast", "secret"], { broadcast: ["@here"], secret: ["hu…"] })).toBe("Your edit mentions everyone at “@here”. It also looks like a password, key or token at “hu…”. Everyone on the ticket would see it once it is posted.");
    expect(riskNote(["secret"])).not.toContain("“");
  });
});
