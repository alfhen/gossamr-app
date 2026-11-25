//! The part of JSON Schema the harness checks a session's `result` against. A schema that uses anything else is refused
//! when the session opens, so a result is never taken against a rule the harness skipped.
//!
//! Checked: `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`, or a list of them),
//! `properties`, `required`, `additionalProperties` (a boolean or a schema), `items` (one schema), `enum`, `const`,
//! `minLength`, `maxLength` (in Unicode code points), `minimum`, `maximum`, `minItems`, `maxItems`. Read as notes and not
//! checked: `title`, `description`, `default`, `examples`, `$schema`, `$comment`. Numbers in `enum` and `const` match by
//! value (`1` is `1.0`), and whole numbers in `minimum` and `maximum` compare exactly. Some forms JSON Schema allows are
//! refused, which is the safe way: a bound written `2.0`, a schema that is `true` or `false`, a top-level `type` given as
//! a list. A schema whose keys repeat is read as its last one, as it was parsed.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Number, Value};

const TYPES: &[&str] = &["object", "array", "string", "number", "integer", "boolean", "null"];
const NOTES: &[&str] = &["title", "description", "default", "examples", "$schema", "$comment"];
/// The most misfits a reason names.
pub const MOST_MISFITS: usize = 10;

/// Why `schema` cannot be a result schema: a top level that is not an object schema, a keyword outside the subset, or
/// a keyword with a value of the wrong shape. The reason names the keyword and where it is.
pub fn check(schema: &Value) -> Result<(), String> {
    if schema.get("type") != Some(&Value::from("object")) {
        return Err("a result schema is an object schema: its top level has \"type\": \"object\"".into());
    }
    check_at(schema, "")
}

fn check_at(schema: &Value, at: &str) -> Result<(), String> {
    let Value::Object(schema) = schema else { return Err(format!("at {}: a schema is a JSON object", place(at))) };
    for (keyword, value) in schema {
        let bad = |what: &str| Err(format!("at {}: `{keyword}` {what}", place(at)));
        let count = || value.as_u64().is_some();
        match keyword.as_str() {
            "type" => {
                let names: Vec<&Value> = match value {
                    Value::Array(names) if !names.is_empty() => names.iter().collect(),
                    Value::String(_) => vec![value],
                    _ => return bad("is a type name or a list of them"),
                };
                if !names.iter().all(|name| name.as_str().is_some_and(|name| TYPES.contains(&name))) {
                    return bad(&format!("names one of {}", TYPES.join(", ")));
                }
            }
            "properties" => {
                let Value::Object(properties) = value else { return bad("is an object of schemas") };
                for (name, property) in properties {
                    check_at(property, &format!("{at}/properties/{name}"))?;
                }
            }
            "required" if !value.as_array().is_some_and(|names| names.iter().all(Value::is_string)) => return bad("is a list of names"),
            "additionalProperties" if !value.is_boolean() => check_at(value, &format!("{at}/additionalProperties"))?,
            "items" => check_at(value, &format!("{at}/items"))?,
            "enum" if !value.is_array() => return bad("is a list"),
            "minLength" | "maxLength" | "minItems" | "maxItems" if !count() => return bad("is a whole number of at least 0"),
            "minimum" | "maximum" if !value.is_number() => return bad("is a number"),
            "required" | "additionalProperties" | "enum" | "const" | "minLength" | "maxLength" | "minItems" | "maxItems" | "minimum" | "maximum" => {}
            note if NOTES.contains(&note) => {}
            _ => return bad("is not one the harness checks, so it is refused"),
        }
    }
    Ok(())
}

/// Where `value` does not fit `schema`, at most `MOST_MISFITS`, each with its JSON path. Empty when it fits. `schema`
/// has passed `check`. The work is linear in the value's size: each `enum` is read once into a set.
pub fn misfits(schema: &Value, value: &Value) -> Vec<String> {
    let mut walk = Walk::default();
    walk.walk(schema, value, "");
    walk.found.truncate(MOST_MISFITS);
    walk.found
}

#[derive(Default)]
struct Walk {
    found: Vec<String>,
    /// Each `enum` seen, by where it is in the schema, as the canonical text of its values.
    sets: HashMap<*const Vec<Value>, HashSet<String>>,
}

impl Walk {
    fn note(&mut self, at: &str, why: String) {
        self.found.push(format!("at {}: {why}", place(at)));
    }

    fn walk(&mut self, schema: &Value, value: &Value, at: &str) {
        let Value::Object(schema) = schema else { return };
        if self.found.len() >= MOST_MISFITS {
            return;
        }
        if let Some(types) = schema.get("type") {
            let names: Vec<&str> = match types {
                Value::Array(names) => names.iter().filter_map(Value::as_str).collect(),
                other => other.as_str().into_iter().collect(),
            };
            if !names.iter().any(|name| is(name, value)) {
                self.note(at, format!("expected {}, got {}", names.join(" or "), kind(value)));
                return;
            }
        }
        if let Some(Value::Array(allowed)) = schema.get("enum") {
            let set = self.sets.entry(std::ptr::from_ref(allowed)).or_insert_with(|| allowed.iter().map(canon).collect());
            if !set.contains(&canon(value)) {
                self.note(at, "is not one of the values the schema lists".into());
            }
        }
        if let Some(want) = schema.get("const")
            && canon(want) != canon(value)
        {
            self.note(at, "is not the value the schema fixes".into());
        }
        let count = |keyword: &str| schema.get(keyword).and_then(Value::as_u64);
        match value {
            Value::String(text) => {
                let length = text.chars().count() as u64;
                if let Some(least) = count("minLength").filter(|least| length < *least) {
                    self.note(at, format!("is shorter than {least} characters"));
                }
                if let Some(most) = count("maxLength").filter(|most| length > *most) {
                    self.note(at, format!("is longer than {most} characters"));
                }
            }
            Value::Number(number) => {
                if let Some(least) = schema.get("minimum").and_then(Value::as_number).filter(|least| less(number, least)) {
                    self.note(at, format!("is below the minimum {least}"));
                }
                if let Some(most) = schema.get("maximum").and_then(Value::as_number).filter(|most| less(most, number)) {
                    self.note(at, format!("is above the maximum {most}"));
                }
            }
            Value::Array(items) => {
                let length = items.len() as u64;
                if let Some(least) = count("minItems").filter(|least| length < *least) {
                    self.note(at, format!("has fewer than {least} items"));
                }
                if let Some(most) = count("maxItems").filter(|most| length > *most) {
                    self.note(at, format!("has more than {most} items"));
                }
                if let Some(item) = schema.get("items") {
                    for (n, value) in items.iter().enumerate() {
                        if self.found.len() >= MOST_MISFITS {
                            break;
                        }
                        self.walk(item, value, &format!("{at}/{n}"));
                    }
                }
            }
            Value::Object(fields) => self.object(schema, fields, at),
            _ => {}
        }
    }

    fn object(&mut self, schema: &Map<String, Value>, fields: &Map<String, Value>, at: &str) {
        for name in schema.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !fields.contains_key(name) {
                self.note(at, format!("`{name}` is required"));
            }
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        for (name, value) in fields {
            let path = format!("{at}/{name}");
            match (properties.and_then(|properties| properties.get(name)), schema.get("additionalProperties")) {
                (Some(property), _) => self.walk(property, value, &path),
                (None, Some(Value::Bool(false))) => self.note(&path, "is not a property the schema allows".into()),
                (None, Some(extra @ Value::Object(_))) => self.walk(extra, value, &path),
                (None, _) => {}
            }
        }
    }
}

/// `a` is below `b`. Whole numbers compare exactly, so a bound past 2^53 is not lost to rounding.
fn less(a: &Number, b: &Number) -> bool {
    let whole = |n: &Number| n.as_i64().map(i128::from).or_else(|| n.as_u64().map(i128::from));
    match (whole(a), whole(b)) {
        (Some(a), Some(b)) => a < b,
        _ => a.as_f64().unwrap_or(f64::NAN) < b.as_f64().unwrap_or(f64::NAN),
    }
}

/// A value's text with equal numbers written alike (`1` and `1.0`) and an object's keys in order, so `enum` and
/// `const` match by value as JSON Schema says.
fn canon(value: &Value) -> String {
    match value {
        Value::Number(number) => match (number.as_i64(), number.as_u64(), number.as_f64()) {
            (Some(n), _, _) => n.to_string(),
            (_, Some(n), _) => n.to_string(),
            // Below 2^53 a whole f64 is exact as an integer.
            (_, _, Some(n)) if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 => (n as i64).to_string(),
            (_, _, n) => format!("{:?}", n.unwrap_or(f64::NAN)),
        },
        Value::Array(items) => format!("[{}]", items.iter().map(canon).collect::<Vec<_>>().join(",")),
        Value::Object(fields) => {
            let mut pairs: Vec<String> = fields.iter().map(|(key, value)| format!("{}:{}", Value::String(key.clone()), canon(value))).collect();
            pairs.sort();
            format!("{{{}}}", pairs.join(","))
        }
        other => other.to_string(),
    }
}

fn is(name: &str, value: &Value) -> bool {
    match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_number().is_some_and(|n| n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|n| n.fract() == 0.0)),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Object(_) => "an object",
        Value::Array(_) => "an array",
        Value::String(_) => "a string",
        Value::Number(_) => "a number",
        Value::Bool(_) => "a boolean",
        Value::Null => "null",
    }
}

/// A JSON path for a reason: `/` for the top.
fn place(at: &str) -> &str {
    if at.is_empty() { "/" } else { at }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn verdict() -> Value {
        json!({
            "type": "object",
            "title": "A review's verdict",
            "properties": {
                "verdict": { "type": "string", "enum": ["pass", "fail"] },
                "score": { "type": "integer", "minimum": 0, "maximum": 10 },
                "notes": { "type": "array", "items": { "type": "string", "maxLength": 5 }, "maxItems": 2 },
                "by": { "const": "review" },
                "extra": { "type": ["string", "null"], "minLength": 2 }
            },
            "required": ["verdict"],
            "additionalProperties": false
        })
    }

    #[test]
    fn tools_endpoint_result_schema_a_result_that_fits_has_no_misfit() {
        assert!(check(&verdict()).is_ok());
        let fits = json!({ "verdict": "pass", "score": 7, "notes": ["ok"], "by": "review", "extra": null });
        assert_eq!(misfits(&verdict(), &fits), Vec::<String>::new());
        assert_eq!(misfits(&json!({"type": "object"}), &json!({"anything": [1, {}]})), Vec::<String>::new());
    }

    #[test]
    fn tools_endpoint_result_schema_each_keyword_names_its_misfit_by_path() {
        let cases = [
            (json!({}), "at /: `verdict` is required"),
            (json!({ "verdict": "maybe" }), "at /verdict: is not one of the values the schema lists"),
            (json!({ "verdict": 3 }), "at /verdict: expected string, got a number"),
            (json!({ "verdict": "pass", "score": 11 }), "at /score: is above the maximum 10"),
            (json!({ "verdict": "pass", "score": -1 }), "at /score: is below the minimum 0"),
            (json!({ "verdict": "pass", "score": 1.5 }), "at /score: expected integer, got a number"),
            (json!({ "verdict": "pass", "notes": ["toolong"] }), "at /notes/0: is longer than 5 characters"),
            (json!({ "verdict": "pass", "notes": ["a", "b", "c"] }), "at /notes: has more than 2 items"),
            (json!({ "verdict": "pass", "by": "me" }), "at /by: is not the value the schema fixes"),
            (json!({ "verdict": "pass", "extra": "x" }), "at /extra: is shorter than 2 characters"),
            (json!({ "verdict": "pass", "other": 1 }), "at /other: is not a property the schema allows"),
            (json!([]), "at /: expected object, got an array"),
        ];
        for (value, reason) in cases {
            assert_eq!(misfits(&verdict(), &value), [reason], "{value}");
        }
        let open = json!({"type": "object", "additionalProperties": {"type": "number"}, "properties": {"a": {"minItems": 1}}});
        assert_eq!(misfits(&open, &json!({ "a": [], "b": "x" })), ["at /a: has fewer than 1 items", "at /b: expected number, got a string"]);
    }

    #[test]
    fn tools_endpoint_result_schema_numbers_match_by_value_and_whole_bounds_compare_exactly() {
        let one = |keyword: &str, want: Value| json!({"type": "object", "properties": {"n": {keyword: want}}});
        for (schema, value) in [(one("enum", json!([1])), json!(1.0)), (one("const", json!(1.0)), json!(1)), (one("enum", json!([{"a": 2.0, "b": [1]}])), json!({"b": [1.0], "a": 2}))] {
            assert_eq!(misfits(&schema, &json!({ "n": value })), Vec::<String>::new(), "{schema} takes {value}");
        }
        assert_eq!(misfits(&one("enum", json!([1])), &json!({"n": 1.5})), ["at /n: is not one of the values the schema lists"]);
        let big = one("maximum", json!(9_007_199_254_740_992_u64));
        assert_eq!(misfits(&big, &json!({"n": 9_007_199_254_740_993_u64})), ["at /n: is above the maximum 9007199254740992"], "no rounding past 2^53");
        assert_eq!(misfits(&big, &json!({"n": 9_007_199_254_740_992_u64})), Vec::<String>::new());
        assert_eq!(misfits(&one("minimum", json!(-3)), &json!({"n": -3.5})), ["at /n: is below the minimum -3"]);
    }

    #[test]
    fn tools_endpoint_result_schema_a_long_enum_on_many_items_is_checked_in_linear_time() {
        let entries: Vec<u64> = (0..11_000).collect();
        let schema = json!({"type": "object", "properties": {"a": {"type": "array", "items": {"enum": entries}}}});
        let value = json!({ "a": vec![10_999; 200_000] });
        let started = std::time::Instant::now();
        assert_eq!(misfits(&schema, &value), Vec::<String>::new());
        // Comparing each item with each entry is 2.2 billion steps; a set makes it 200,000 lookups.
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    #[test]
    fn tools_endpoint_result_schema_names_at_most_ten_misfits() {
        let schema = json!({"type": "object", "additionalProperties": false});
        let many: Map<String, Value> = (0..20).map(|n| (format!("k{n:02}"), json!(n))).collect();
        assert_eq!(misfits(&schema, &Value::Object(many)).len(), MOST_MISFITS);
    }

    #[test]
    fn tools_endpoint_result_schema_refused_outside_the_checked_subset() {
        let refused = [
            (json!({"type": "array"}), "top level"),
            (json!({"properties": {}}), "top level"),
            (json!({"type": "object", "pattern": "^a"}), "`pattern`"),
            (json!({"type": "object", "properties": {"a": {"oneOf": []}}}), "/properties/a: `oneOf`"),
            (json!({"type": "object", "$ref": "#/x"}), "`$ref`"),
            (json!({"type": "object", "items": {"format": "email"}}), "/items: `format`"),
            (json!({"type": "object", "additionalProperties": {"if": {}}}), "/additionalProperties: `if`"),
            (json!({"type": "object", "required": "a"}), "`required` is a list"),
            (json!({"type": "object", "properties": {"a": {"type": "date"}}}), "`type` names one of"),
            (json!({"type": "object", "properties": {"a": {"maxLength": -1}}}), "`maxLength` is a whole number"),
            (json!({"type": "object", "properties": {"a": {"minimum": "1"}}}), "`minimum` is a number"),
            (json!({"type": "object", "properties": {"a": 3}}), "a schema is a JSON object"),
            (json!({"type": "object", "enum": {}}), "`enum` is a list"),
        ];
        for (schema, said) in refused {
            let reason = check(&schema).expect_err(&schema.to_string());
            assert!(reason.contains(said), "{schema}: {reason}");
        }
    }
}
