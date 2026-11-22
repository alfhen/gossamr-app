//! One JSON line per message, both directions, in the order the driver saw them.
//! Everything is redacted before it is written, so nothing unredacted rests on disk.

use crate::redact::Redactor;
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
