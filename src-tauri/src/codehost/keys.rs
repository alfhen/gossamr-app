//! Finds work item keys in branch names, titles, descriptions and commit messages.
//!
//! The matcher is built from the project keys the trackers actually have, not from a generic `LETTERS-digits`
//! pattern, so `UTF-8`, `SHA-256` and `ISO-8601` are only keys in a workspace that has a project with that key.

use std::collections::BTreeSet;

/// Longest number that can follow the hyphen; beyond it the text is something else (a timestamp, an id).
const MAX_DIGITS: usize = 9;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyMatcher {
    prefixes: Vec<Vec<char>>,
}

/// A project key is a letter followed by letters, digits or underscores, two characters at least.
fn valid_prefix(p: &str) -> bool {
    let mut chars = p.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && p.len() >= 2 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl KeyMatcher {
    pub fn new<S: AsRef<str>>(prefixes: impl IntoIterator<Item = S>) -> Self {
        let set: BTreeSet<String> = prefixes.into_iter().map(|p| p.as_ref().trim().to_ascii_uppercase()).filter(|p| valid_prefix(p)).collect();
        Self { prefixes: set.into_iter().map(|p| p.chars().collect()).collect() }
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.prefixes.is_empty()
    }

    /// Every key in `text`, upper-cased, once each, in the order they first appear.
    pub fn find(&self, text: &str) -> Vec<String> {
        let chars: Vec<char> = text.chars().map(|c| c.to_ascii_uppercase()).collect();
        let mut found: Vec<String> = Vec::new();
        for start in 0..chars.len() {
            if start > 0 && (chars[start - 1].is_alphanumeric()) {
                continue;
            }
            for prefix in &self.prefixes {
                if let Some(key) = self.key_at(&chars, start, prefix) {
                    if !found.contains(&key) {
                        found.push(key);
                    }
                    break;
                }
            }
        }
        found
    }

    fn key_at(&self, chars: &[char], start: usize, prefix: &[char]) -> Option<String> {
        let after = start + prefix.len();
        if chars.get(start..after)? != prefix || chars.get(after) != Some(&'-') {
            return None;
        }
        let digits: String = chars[after + 1..].iter().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() || digits.len() > MAX_DIGITS || digits.starts_with('0') {
            return None;
        }
        if chars.get(after + 1 + digits.len()).is_some_and(|c| c.is_alphabetic()) {
            return None;
        }
        Some(format!("{}-{digits}", prefix.iter().collect::<String>()))
    }

    /// The project key of `key`, as in `CA` for `CA-208`.
    pub fn prefix_of(key: &str) -> Option<&str> {
        key.rsplit_once('-').map(|(p, _)| p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m() -> KeyMatcher {
        KeyMatcher::new(["CA", "DEVOPS", "CE", "SRE", "ABC"])
    }

    fn found(text: &str) -> Vec<String> {
        m().find(text)
    }

    #[test]
    fn branch_names_in_the_usual_shapes() {
        for branch in ["CA-208", "ca-208", "ca-208-gateway", "feature/CA-208_gateway", "feature/ca-208/gateway", "fix/CA-208", "CA-208.hotfix", "users/ann/ca-208-x"] {
            assert_eq!(found(branch), ["CA-208"], "{branch}");
        }
    }

    #[test]
    fn the_hyphen_is_required() {
        for text in ["fix/ca208", "CA_208", "CA 208", "CA208-gateway", "CA--208", "CA-"] {
            assert!(found(text).is_empty(), "{text}");
        }
    }

    #[test]
    fn a_key_inside_a_longer_word_or_number_is_not_that_key() {
        assert!(found("ABCA-208").is_empty(), "letters before");
        assert!(found("xCA-208").is_empty());
        assert!(found("9CA-208").is_empty(), "digit before");
        assert_eq!(found("CA-2081"), ["CA-2081"], "digits after belong to the number");
        assert!(found("CA-208x").is_empty(), "letters after");
        assert!(found("CA-208ab12").is_empty());
        assert_eq!(found("CA-208_x"), ["CA-208"], "an underscore ends the key");
        assert_eq!(found("ÅCA-208"), Vec::<String>::new(), "a non-ASCII letter before");
    }

    #[test]
    fn punctuation_around_a_key_is_fine() {
        for text in ["[CA-208] Fix gateway", "(CA-208)", "Fixes: CA-208.", "CA-208: gateway", "see \"CA-208\"", "\nCA-208\n", "#CA-208", "ca-208,"] {
            assert_eq!(found(text), ["CA-208"], "{text}");
        }
    }

    #[test]
    fn several_keys_in_one_string_come_out_once_each_in_order() {
        assert_eq!(found("DEVOPS-471 and CA-208, also ca-208 and SRE-9"), ["DEVOPS-471", "CA-208", "SRE-9"]);
        assert_eq!(found("CA-1/CA-2/CA-3"), ["CA-1", "CA-2", "CA-3"]);
    }

    #[test]
    fn only_real_project_keys_match() {
        for text in ["Upgrade UTF-8 handling", "use SHA-256", "ISO-8601 dates", "x-ray", "COVID-19", "CVE-2024-1234", "PR-12"] {
            assert!(found(text).is_empty(), "{text}");
        }
        assert_eq!(KeyMatcher::new(["ISO"]).find("ISO-8601 dates"), ["ISO-8601"]);
        assert_eq!(KeyMatcher::new(["UTF"]).find("UTF-8"), ["UTF-8"], "a workspace with that project does get the match");
        assert_eq!(KeyMatcher::new(["SHA"]).find("SHA-256"), ["SHA-256"]);
    }

    #[test]
    fn keys_in_a_url_still_match() {
        assert_eq!(found("https://acme.atlassian.net/browse/CA-208"), ["CA-208"]);
    }

    #[test]
    fn numbers_with_a_leading_zero_or_too_many_digits_are_not_keys() {
        assert!(found("CA-0").is_empty());
        assert!(found("CA-007").is_empty());
        assert!(found("CA-1234567890").is_empty());
        assert_eq!(found("CA-123456789"), ["CA-123456789"]);
    }

    #[test]
    fn a_longer_project_key_wins_over_a_shorter_one_it_contains() {
        let m = KeyMatcher::new(["CA", "CAT"]);
        assert_eq!(m.find("CAT-5"), ["CAT-5"]);
        assert_eq!(m.find("CA-5"), ["CA-5"]);
    }

    #[test]
    fn prefixes_are_normalised_and_junk_is_dropped() {
        let m = KeyMatcher::new([" ca ", "CA", "9X", "A", "", "with space", "OK_1"]);
        assert_eq!(m, KeyMatcher::new(["CA", "OK_1"]));
        assert!(KeyMatcher::new(Vec::<String>::new()).find("CA-1").is_empty());
        assert!(KeyMatcher::new(Vec::<String>::new()).is_empty());
    }

    #[test]
    fn empty_and_unicode_text() {
        assert!(found("").is_empty());
        assert_eq!(found("Fix café CA-208 naïve"), ["CA-208"]);
    }

    #[test]
    fn the_project_key_comes_off_a_key() {
        assert_eq!(KeyMatcher::prefix_of("DEVOPS-471"), Some("DEVOPS"));
        assert_eq!(KeyMatcher::prefix_of("nokey"), None);
    }
}
