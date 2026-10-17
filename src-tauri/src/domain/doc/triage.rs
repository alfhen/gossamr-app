//! The `Triage` section of a description: where a Triage run's note and the questions it left open live on the ticket,
//! found again by its heading so a re-triage replaces it and later agents can be shown it. It sits after the person's
//! own description and before the `Gossamr Plan` section, when the ticket has one.

use super::{Block, Doc, Inline};

pub const TRIAGE_HEADING: &str = "Triage";
const NEW_LEVEL: u8 = 2;
/// What stands over the list of open questions inside the section.
pub const QUESTIONS_LEAD: &str = "Open questions:";

fn is_marker(block: &Block) -> Option<u8> {
    let Block::Heading { level, content } = block else { return None };
    let text: String = content
        .iter()
        .map(|i| match i {
            Inline::Text { text, .. } | Inline::Link { text, .. } => text.as_str(),
            _ => "",
        })
        .collect();
    text.trim().trim_end_matches(':').trim().eq_ignore_ascii_case(TRIAGE_HEADING).then_some(*level)
}

impl Doc {
    /// The first `Triage` heading, and where its section ends: at the next heading of the same or a higher level, or at the plan's expand.
    fn triage_range(&self) -> Option<(usize, usize, u8)> {
        let at = self.blocks.iter().position(|b| is_marker(b).is_some())?;
        let level = is_marker(&self.blocks[at])?;
        let ends = |b: &Block| matches!(b, Block::Heading { level: l, .. } if *l <= level) || super::plan::is_plan_expand(b);
        let end = self.blocks[at + 1..].iter().position(ends).map_or(self.blocks.len(), |n| at + 1 + n);
        Some((at, end, level))
    }

    /// What stands under the `Triage` heading, without the heading.
    pub fn triage_section(&self) -> Option<Doc> {
        let (at, end, _) = self.triage_range()?;
        Some(Doc { blocks: self.blocks[at + 1..end].to_vec() })
    }

    /// The document without its `Triage` section, heading included.
    pub fn without_triage_section(&self) -> Doc {
        match self.triage_range() {
            Some((at, end, _)) => Doc { blocks: self.blocks[..at].iter().chain(&self.blocks[end..]).cloned().collect() },
            None => self.clone(),
        }
    }

    /// This document with `note` and, when there are any, `questions` as its `Triage` section: replacing the one it has,
    /// in place and at its heading level, or added after the description and before the `Gossamr Plan` section. The
    /// note is Markdown whose headings become plain paragraphs, so that none can end the section.
    pub fn with_triage_section(&self, note: &str, questions: &[String]) -> Doc {
        let (before, after, level) = match self.triage_range() {
            Some((at, end, level)) => (self.blocks[..at].to_vec(), self.blocks[end..].to_vec(), level),
            None => {
                let at = self.plan_range().map_or(self.blocks.len(), |(at, _)| at);
                (self.blocks[..at].to_vec(), self.blocks[at..].to_vec(), NEW_LEVEL)
            }
        };
        let mut text = note.trim().to_string();
        if !questions.is_empty() {
            let list: Vec<String> = questions.iter().map(|q| format!("- {}", q.trim())).collect();
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(&format!("{QUESTIONS_LEAD}\n\n{}", list.join("\n")));
        }
        let own = Doc::from_markdown(&text, &[]).blocks.into_iter().map(|b| match b {
            Block::Heading { content, .. } => Block::Paragraph { content },
            other => other,
        });
        let mut blocks = before;
        blocks.push(Block::Heading { level, content: vec![Inline::Text { text: TRIAGE_HEADING.into(), marks: vec![] }] });
        blocks.extend(own);
        blocks.extend(after);
        Doc { blocks }
    }

    /// The questions listed under `Open questions:` in the `Triage` section, one per bullet.
    pub fn triage_questions(&self) -> Vec<String> {
        let Some(section) = self.triage_section() else { return Vec::new() };
        let at = section.blocks.iter().position(|b| matches!(b, Block::Paragraph { .. }) && Doc { blocks: vec![b.clone()] }.plain_text().trim() == QUESTIONS_LEAD);
        let Some(at) = at else { return Vec::new() };
        match section.blocks.get(at + 1) {
            Some(Block::List { ordered: false, items }) => items.iter().map(|item| Doc { blocks: item.clone() }.plain_text().trim().to_string()).filter(|q| !q.is_empty()).collect(),
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(text: &str) -> Doc {
        Doc::from_markdown(text, &[])
    }

    const EXPAND: &str = "<details>\n<summary>Gossamr Plan</summary>\n\nintro\n\nThe plan.\n\n</details>";

    fn questions() -> Vec<String> {
        vec!["What does done look like?".into(), "Who is waiting on it?".into()]
    }

    #[test]
    fn a_triage_section_is_added_after_the_description_with_its_note_and_its_open_questions_as_a_list() {
        let doc = md("Fix it.");
        let with = doc.with_triage_section("The ticket cannot be sized yet.", &questions());
        assert_eq!(with.to_markdown(), "Fix it.\n\n## Triage\n\nThe ticket cannot be sized yet.\n\nOpen questions:\n\n- What does done look like?\n- Who is waiting on it?");
        assert_eq!(with.triage_section().unwrap().to_markdown(), "The ticket cannot be sized yet.\n\nOpen questions:\n\n- What does done look like?\n- Who is waiting on it?");
        assert_eq!(with.triage_questions(), questions());
        assert_eq!(with.without_triage_section(), doc);
    }

    #[test]
    fn it_stands_before_the_plan_section_whether_it_is_added_before_or_after_the_plan() {
        let planned = md("Fix it.\n\n## Gossamr Plan\n\nintro\n\nThe plan.");
        let with = planned.with_triage_section("Size: 3 points.", &[]);
        assert_eq!(with.to_markdown(), "Fix it.\n\n## Triage\n\nSize: 3 points.\n\n## Gossamr Plan\n\nintro\n\nThe plan.");
        assert_eq!(with.plan_section(), planned.plan_section(), "the plan is untouched");
        // The same with the plan in its expand: the triage section stands before it and does not take it in.
        let expand = md("Fix it.").with_plan_section("intro", &md("The plan."));
        let with = expand.with_triage_section("Size: 3 points.", &[]);
        assert_eq!(with.to_markdown(), format!("Fix it.\n\n## Triage\n\nSize: 3 points.\n\n{EXPAND}"));
        assert_eq!(with.triage_section().unwrap().to_markdown(), "Size: 3 points.");
        assert_eq!(with.plan_section(), expand.plan_section(), "the plan is untouched");
        // A plan added to a description that has a Triage section goes after it, at the end.
        let other = md("Fix it.").with_triage_section("Size: 3 points.", &[]).with_plan_section("intro", &md("The plan."));
        assert_eq!(other.to_markdown(), format!("Fix it.\n\n## Triage\n\nSize: 3 points.\n\n{EXPAND}"));
    }

    #[test]
    fn a_re_triage_replaces_the_section_where_it_stands_and_never_stacks_one() {
        let first = md("Fix it.").with_triage_section("Cannot be sized yet.", &questions());
        let planned = first.with_plan_section("intro", &md("The plan."));
        let second = planned.with_triage_section("Size: 3 points. The answers in the ticket's comments were used.", &[]);
        assert_eq!(second.to_markdown(), format!("Fix it.\n\n## Triage\n\nSize: 3 points. The answers in the ticket's comments were used.\n\n{EXPAND}"));
        assert_eq!(second.blocks.iter().filter(|b| is_marker(b).is_some()).count(), 1);
        assert!(second.triage_questions().is_empty(), "a ready triage leaves no open question in it");
    }

    #[test]
    fn a_section_with_no_questions_has_no_list_and_a_note_with_headings_cannot_end_it() {
        let with = md("Fix it.\n\n## Notes\n\nKeep me.").with_triage_section("# Size\n\nAbout a day.", &[]);
        assert_eq!(with.to_markdown(), "Fix it.\n\n## Notes\n\nKeep me.\n\n## Triage\n\nSize\n\nAbout a day.");
        assert!(!with.to_markdown().contains(QUESTIONS_LEAD));
        assert_eq!(with.triage_section().unwrap().to_markdown(), "Size\n\nAbout a day.");
    }

    #[test]
    fn the_heading_is_found_whatever_its_case_and_a_document_without_one_is_unchanged_by_taking_it_out() {
        let doc = md("Text.\n\n### triage:\n\nin\n\n#### Inner\n\nalso in\n\n### Next\n\nout");
        assert_eq!(doc.triage_section().unwrap().to_markdown(), "in\n\n#### Inner\n\nalso in");
        assert_eq!(doc.without_triage_section().to_markdown(), "Text.\n\n### Next\n\nout");
        let plain = md("Just text.");
        assert_eq!((plain.triage_section(), plain.without_triage_section()), (None, plain.clone()));
        assert!(md("A paragraph about a Triage.").triage_section().is_none());
    }
}
