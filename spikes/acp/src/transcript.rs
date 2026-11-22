//! One JSON line per message, both directions, in the order the driver saw them.
//! Everything is redacted before it is written, so nothing unredacted rests on disk.

use regex::Regex;
use serde_json::{Value, json};
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone, Copy, Debug)]
pub enum Dir {
    /// Driver to agent (the agent's stdin).
    ToAgent,
    /// Agent to driver (the agent's stdout).
    FromAgent,
    Stderr,
    /// What the driver itself did or noticed.
    Driver,
}

impl Dir {
    fn name(self) -> &'static str {
        match self {
            Dir::ToAgent => "to_agent",
            Dir::FromAgent => "from_agent",
            Dir::Stderr => "stderr",
            Dir::Driver => "driver",
        }
    }
}

pub struct Redactor {
    literals: Vec<(String, String)>,
    patterns: Vec<(Regex, &'static str)>,
    keys: Regex,
}

impl Redactor {
    /// `env_names` are variables whose values are secrets for this run (the MCP token).
    pub fn new(env_names: &[String]) -> Self {
        let mut literals = Vec::new();
        for name in env_names {
            if let Ok(v) = std::env::var(name)
                && v.len() >= 8
            {
                literals.push((v, format!("<redacted:{name}>")));
            }
        }
        // Secret-looking values in the driver's own environment, whatever their name.
        for (k, v) in std::env::vars() {
            let k_up = k.to_uppercase();
            if v.len() >= 8
                && [
                    "TOKEN", "SECRET", "KEY", "UUID", "EMAIL", "PASSWORD", "AUTH",
                ]
                .iter()
                .any(|w| k_up.contains(w))
            {
                literals.push((v, format!("<redacted:{k}>")));
            }
        }
        // The scratch root and the home folder carry the user name; the scratch root first, it is longer.
        if let Ok(s) = std::env::var("SPIKE_SCRATCH") {
            if let Ok(real) = std::fs::canonicalize(&s) {
                literals.push((real.to_string_lossy().into_owned(), "$SCRATCH".into()));
            }
            literals.push((s, "$SCRATCH".into()));
        }
        if let Ok(h) = std::env::var("HOME") {
            literals.push((h, "$HOME".into()));
        }
        // Words the person wants masked (an employer, a client), comma-separated; never committed.
        for w in std::env::var("SPIKE_REDACT_WORDS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|w| w.len() >= 3)
        {
            literals.push((w.to_string(), "<masked>".into()));
            literals.push((w.to_lowercase(), "<masked>".into()));
        }
        // The host name often carries the person's name.
        if let Ok(o) = std::process::Command::new("hostname").output() {
            let h = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if h.len() >= 3 {
                literals.push((h.trim_end_matches(".local").to_string(), "<host>".into()));
            }
        }
        if let Ok(u) = std::env::var("USER")
            && u.len() >= 3
        {
            literals.push((u, "<user>".into()));
        }
        let patterns = vec![
            (
                Regex::new(r"sk-ant-[A-Za-z0-9_\-]{8,}").unwrap(),
                "<redacted:sk-ant>",
            ),
            (
                Regex::new(r"\bsk-[A-Za-z0-9_\-]{20,}").unwrap(),
                "<redacted:sk>",
            ),
            (
                Regex::new(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+").unwrap(),
                "<redacted:jwt>",
            ),
            (
                Regex::new(r"ya29\.[A-Za-z0-9_\-\.]+").unwrap(),
                "<redacted:google>",
            ),
            (
                Regex::new(r"1//[A-Za-z0-9_\-]{20,}").unwrap(),
                "<redacted:google-refresh>",
            ),
            (Regex::new(r"gsr_[0-9a-f]{48}").unwrap(), "<redacted:gsr>"),
            (Regex::new(r"spk_[0-9a-f]{16,}").unwrap(), "<redacted:spk>"),
            (
                Regex::new(r"(?i)bearer\s+[A-Za-z0-9._\-]{8,}").unwrap(),
                "Bearer <redacted>",
            ),
            (
                Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").unwrap(),
                "<email>",
            ),
        ];
        let keys = Regex::new(r"(?i)^(email|e_mail|emailaddress|account_?uuid|account_?id|chatgpt_?account_?id|installation_?id|org(anization)?(_?(id|uuid|name))?|user_?id|access_?token|refresh_?token|id_?token|api_?key)$").unwrap();
        Redactor {
            literals,
            patterns,
            keys,
        }
    }

    pub fn text(&self, s: &str) -> String {
        let mut out = s.to_string();
        for (lit, rep) in &self.literals {
            out = out.replace(lit.as_str(), rep);
        }
        for (re, rep) in &self.patterns {
            out = re.replace_all(&out, *rep).into_owned();
        }
        out
    }

    pub fn value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.text(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.value(x)).collect()),
            Value::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, x)| {
                        let masked = self.keys.is_match(k)
                            && !matches!(
                                x,
                                Value::Null | Value::Bool(_) | Value::Object(_) | Value::Array(_)
                            );
                        (
                            self.text(k),
                            if masked {
                                Value::String("<redacted>".into())
                            } else {
                                self.value(x)
                            },
                        )
                    })
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}

pub struct Inner {
    file: File,
    seq: u64,
    start: Instant,
    redactor: Redactor,
}

#[derive(Clone)]
pub struct Transcript(Arc<Mutex<Inner>>);

impl Transcript {
    pub fn create(path: &Path, redact_env: &[String]) -> std::io::Result<Self> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)?;
        }
        let file = File::create(path)?;
        Ok(Transcript(Arc::new(Mutex::new(Inner {
            file,
            seq: 0,
            start: Instant::now(),
            redactor: Redactor::new(redact_env),
        }))))
    }

    pub fn ms(&self) -> u128 {
        self.0.lock().unwrap().start.elapsed().as_millis()
    }

    /// A raw line: kept as JSON when it parses, as a string otherwise.
    pub fn line(&self, dir: Dir, raw: &str) {
        let data =
            serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
        self.record(dir, &data);
    }

    pub fn record(&self, dir: Dir, data: &Value) {
        let mut g = self.0.lock().unwrap();
        g.seq += 1;
        let data = g.redactor.value(data);
        let line = json!({ "seq": g.seq, "ms": g.start.elapsed().as_millis() as u64, "dir": dir.name(), "data": data });
        let _ = writeln!(g.file, "{line}");
        let _ = g.file.flush();
    }

    pub fn note(&self, what: &str, detail: Value) {
        self.record(Dir::Driver, &json!({ "note": what, "detail": detail }));
    }

    pub fn redact(&self, s: &str) -> String {
        self.0.lock().unwrap().redactor.text(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_shape_an_email_and_a_secret_key_are_masked() {
        let r = Redactor::new(&[]);
        let v = json!({"a": "Bearer abcdefgh12345", "email": "x@y.io", "t": "sk-ant-oat01-abcdefghijk", "note": "mail me at a.b@c.com"});
        let out = r.value(&v).to_string();
        assert!(
            !out.contains("abcdefgh12345")
                && !out.contains("x@y.io")
                && !out.contains("oat01")
                && !out.contains("a.b@c.com"),
            "{out}"
        );
    }
}
