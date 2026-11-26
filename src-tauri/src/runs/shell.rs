//! Reading and writing shell command lines: one quote-aware split of what an agent ran, and one quoting of what the
//! app shows the person to run.

/// The words of a command, a quoted run of text one word with its quotes taken off; a quoted word that is itself a git
/// command (`sh -c '…'`) gives its own words too, after them.
pub fn words(command: &str) -> Vec<String> {
    let (mut words, mut word, mut quote) = (Vec::new(), String::new(), None::<char>);
    for c in command.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '"' | '\'') => quote = Some(c),
            (None, c) if c.is_whitespace() => words.extend((!word.is_empty()).then(|| std::mem::take(&mut word))),
            (None, c) => word.push(c),
        }
    }
    words.extend((!word.is_empty()).then_some(word));
    let inner: Vec<String> = words.iter().filter(|word| word.contains(' ') && word.contains("git")).flat_map(|word| self::words(word)).collect();
    words.extend(inner);
    words
}

/// `text` as one word for a POSIX shell: in single quotes, each quote in it closed, escaped and opened again.
pub fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quoted_run_is_one_word_and_a_quoted_command_gives_its_own_words_too() {
        assert_eq!(words("git -C \"/a b/repo\" commit -m fix"), ["git", "-C", "/a b/repo", "commit", "-m", "fix"]);
        assert_eq!(words("sh -c 'git commit -am x'"), ["sh", "-c", "git commit -am x", "git", "commit", "-am", "x"]);
    }

    #[test]
    fn a_quoted_word_reads_back_as_itself_in_the_shell() {
        assert_eq!(quote("/Users/O'Neil/repo"), "'/Users/O'\\''Neil/repo'");
        assert_eq!(quote("/plain/path"), "'/plain/path'");
        let shell = std::process::Command::new("/bin/sh").arg("-c").arg(format!("printf %s {}", quote("/a b/O'Neil's"))).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&shell.stdout), "/a b/O'Neil's");
    }
}
