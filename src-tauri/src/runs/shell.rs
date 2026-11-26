//! Reading and writing shell command lines: one reading of what an agent ran, split as a POSIX shell splits it, and
//! one quoting of what the app shows the person to run.

/// The commands of a line, each as its words, split as a POSIX shell splits them: quotes and backslashes as the shell
/// reads them, and a command ending at an unquoted `;`, `&`, `|` or newline. The command a shell is given with `-c`
/// (`sh -c '…'`) gives its own commands too, after them; no other quoted text is read as a command. Expansions (`$`,
/// globs) are not done: a word holds what was written.
pub fn commands(line: &str) -> Vec<Vec<String>> {
    let mut out = split_commands(line);
    let shell = |word: &str| matches!(word.rsplit('/').next(), Some("sh" | "bash" | "zsh"));
    let nested: Vec<Vec<String>> = out
        .iter()
        .filter_map(|words| (2..words.len()).find(|&at| words[at - 1] == "-c" && shell(&words[at - 2])).map(|at| words[at].clone()))
        .flat_map(|inner| commands(&inner))
        .collect();
    out.extend(nested);
    out
}

/// The words of one command, as `commands` splits it, with nothing nested read.
pub fn split(command: &str) -> Vec<String> {
    split_commands(command).into_iter().flatten().collect()
}

fn split_commands(line: &str) -> Vec<Vec<String>> {
    let (mut commands, mut words, mut word, mut quote) = (Vec::new(), Vec::new(), None::<String>, None::<char>);
    let mut chars = line.chars().peekable();
    let end_word = |words: &mut Vec<String>, word: &mut Option<String>| words.extend(word.take());
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('\''), c) => word.get_or_insert_default().push(c),
            // In double quotes a backslash escapes only what is special there; before anything else it stays.
            (Some('"'), '\\') => match chars.peek() {
                Some('\n') => drop(chars.next()),
                Some(&next @ ('$' | '`' | '"' | '\\')) => {
                    chars.next();
                    word.get_or_insert_default().push(next);
                }
                _ => word.get_or_insert_default().push('\\'),
            },
            (Some(_), c) => word.get_or_insert_default().push(c),
            (None, '\\') => match chars.next() {
                Some('\n') | None => {}
                Some(next) => word.get_or_insert_default().push(next),
            },
            (None, '\'' | '"') => {
                quote = Some(c);
                word.get_or_insert_default();
            }
            (None, ' ' | '\t') => end_word(&mut words, &mut word),
            (None, '\n' | ';' | '&' | '|') => {
                end_word(&mut words, &mut word);
                if !words.is_empty() {
                    commands.push(std::mem::take(&mut words));
                }
            }
            (None, c) => word.get_or_insert_default().push(c),
        }
    }
    end_word(&mut words, &mut word);
    if !words.is_empty() {
        commands.push(words);
    }
    commands
}

/// `text` as one word for a POSIX shell: in single quotes, each quote in it closed, escaped and opened again.
pub fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The words `/bin/sh` gives `line`, as `printf` prints its arguments one by one.
    fn as_sh_splits(line: &str) -> Vec<String> {
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(format!("printf '%s\\0' {line}")).output().unwrap();
        assert!(out.status.success(), "{line}");
        let text = String::from_utf8(out.stdout).unwrap();
        text.strip_suffix('\0').map_or_else(Vec::new, |words| words.split('\0').map(str::to_owned).collect())
    }

    #[test]
    fn a_command_splits_into_the_words_bin_sh_gives_it() {
        for line in [
            r#"git -C "/a b/repo" commit -m fix"#,
            r"git -C /a\ b/repo commit",
            r#"a"b c"d 'e f'g"#,
            r#""a\"b" 'a\b' a\\b"#,
            r#""" x '' y"#,
            r"'it'\''s'",
            r#""a\nb" "c\\d" "e\`f""#,
            r#"a\'b \"c"#,
            r#"git commit -m "Set the cart button colour""#,
        ] {
            assert_eq!(split(line), as_sh_splits(line), "{line}");
        }
    }

    #[test]
    fn a_line_splits_into_commands_on_unquoted_separators_and_a_shells_command_gives_its_own() {
        assert_eq!(commands(r#"git -C "/a & b/repo" commit -m fix"#), [vec!["git", "-C", "/a & b/repo", "commit", "-m", "fix"]]);
        assert_eq!(commands("git status; git log & echo 'x | y' | cat").len(), 4);
        assert_eq!(commands("sh -c 'cd repo && git commit -am x'")[1..], [vec!["cd", "repo"], vec!["git", "commit", "-am", "x"]]);
        assert_eq!(commands("/bin/bash -c \"git commit\"").last().unwrap(), &vec!["git", "commit"]);
        assert_eq!(commands("echo 'git commit -m x'"), [vec!["echo", "git commit -m x"]], "quoted text is not a command");
    }

    #[test]
    fn a_quoted_word_reads_back_as_itself_in_the_shell() {
        assert_eq!(quote("/Users/O'Neil/repo"), "'/Users/O'\\''Neil/repo'");
        assert_eq!(quote("/plain/path"), "'/plain/path'");
        for text in ["/a b/O'Neil's", "a\"b", "back\\slash", "dollar $HOME"] {
            assert_eq!(as_sh_splits(&quote(text)), [text], "{text}");
        }
    }
}
