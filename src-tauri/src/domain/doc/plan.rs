//! The `Gossamr Plan` of a description: where a Plan run's agreed plan lives on the ticket, a collapsible expand of that
//! title (older tickets carry a heading section), found again by its title so a re-plan replaces it and later agents can be shown it.

use super::{Block, Doc, Inline};

pub const PLAN_HEADING: &str = "Gossamr Plan";

fn heading_is_marker(content: &[Inline]) -> bool {
    let text: String = content
        .iter()
        .map(|i| match i {
            Inline::Text { text, .. } | Inline::Link { text, .. } => text.as_str(),
            _ => "",
        })
        .collect();
    text.trim().trim_end_matches(':').trim().eq_ignore_ascii_case(PLAN_HEADING)
}

fn marker_level(block: &Block) -> Option<u8> {
    match block {
        Block::Heading { level, content } if heading_is_marker(content) => Some(*level),
        _ => None,
    }
}

/// Whether `block` is the expand a plan is written into: a top-level collapsible titled `Gossamr Plan`.
pub(super) fn is_plan_expand(block: &Block) -> bool {
    matches!(block, Block::Expand { title, .. } if title.trim().trim_end_matches(':').trim().eq_ignore_ascii_case(PLAN_HEADING))
}

impl Doc {
    /// Where the plan lives and where it ends: the first top-level `Gossamr Plan` expand (its one block), or the first
    /// `Gossamr Plan` heading and what follows it up to the next heading of the same or a higher level (the form older
    /// tickets carry), whichever stands first.
    pub(super) fn plan_range(&self) -> Option<(usize, usize)> {
        let at = self.blocks.iter().position(|b| is_plan_expand(b) || marker_level(b).is_some())?;
        let Some(level) = marker_level(&self.blocks[at]) else { return Some((at, at + 1)) };
        let end = self.blocks[at + 1..].iter().position(|b| matches!(b, Block::Heading { level: l, .. } if *l <= level)).map_or(self.blocks.len(), |n| at + 1 + n);
        Some((at, end))
    }

    /// What stands in the plan: the expand's content, or what stands under the old `Gossamr Plan` heading.
    pub fn plan_section(&self) -> Option<Doc> {
        let (at, end) = self.plan_range()?;
        match &self.blocks[at] {
            Block::Expand { content, .. } => Some(Doc { blocks: content.clone() }),
            _ => Some(Doc { blocks: self.blocks[at + 1..end].to_vec() }),
        }
    }

    /// The document without its plan, whichever form it is in.
    pub fn without_plan_section(&self) -> Doc {
        match self.plan_range() {
            Some((at, end)) => Doc { blocks: self.blocks[..at].iter().chain(&self.blocks[end..]).cloned().collect() },
            None => self.clone(),
        }
    }

    /// This document with `intro` and `plan` as its plan: one `Gossamr Plan` expand, in place of the plan it has (an
    /// expand, or the older heading section, which this replaces) or added at the end. A heading in the plan that
    /// reads `Gossamr Plan` becomes a plain paragraph, so it can't be taken for the old marker.
    pub fn with_plan_section(&self, intro: &str, plan: &Doc) -> Doc {
        let (before, after) = match self.plan_range() {
            Some((at, end)) => (self.blocks[..at].to_vec(), self.blocks[end..].to_vec()),
            None => (self.blocks.clone(), Vec::new()),
        };
        let mut content = Doc::paragraph(intro).blocks;
        content.extend(plan.blocks.iter().map(|b| match b {
            Block::Heading { content, .. } if heading_is_marker(content) => Block::Paragraph { content: content.clone() },
            other => other.clone(),
        }));
        let mut blocks = before;
        blocks.push(Block::Expand { title: PLAN_HEADING.into(), content });
        blocks.extend(after);
        Doc { blocks }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(text: &str) -> Doc {
        Doc::from_markdown(text, &[])
    }

    const OPEN: &str = "<details>\n<summary>Gossamr Plan</summary>\n\n";

    #[test]
    fn a_plan_is_written_as_one_expand_at_the_end_with_the_intro_first() {
        let doc = md("Cart total is wrong.\n\n## Steps to reproduce\n\n1. Add an item");
        let with = doc.with_plan_section("Drafted by an agent run.", &md("# Approach\n\nFix rounding.\n\n## Steps\n\n1. Edit cart.rs"));
        assert!(matches!(with.blocks.last(), Some(Block::Expand { title, .. }) if title == "Gossamr Plan"));
        assert_eq!(
            with.to_markdown(),
            format!("Cart total is wrong.\n\n## Steps to reproduce\n\n1. Add an item\n\n{OPEN}Drafted by an agent run.\n\n# Approach\n\nFix rounding.\n\n## Steps\n\n1. Edit cart.rs\n\n</details>")
        );
        assert_eq!(with.plan_section().unwrap().to_markdown(), "Drafted by an agent run.\n\n# Approach\n\nFix rounding.\n\n## Steps\n\n1. Edit cart.rs");
        assert_eq!(with.without_plan_section(), doc);
        assert_eq!(Doc::from_markdown(&with.to_markdown(), &[]), with, "the markdown reads back as the same expand");
    }

    #[test]
    fn a_second_plan_replaces_the_expand_where_it_stands_and_leaves_what_follows() {
        let first = md("Intro").with_plan_section("old intro", &md("old text")).with_plan_section("x", &md("y"));
        let at_middle = Doc { blocks: [first.blocks.clone(), md("## Notes\n\nkeep me").blocks].concat() };
        let with = at_middle.with_plan_section("new intro", &md("New plan."));
        assert_eq!(with.to_markdown(), format!("Intro\n\n{OPEN}new intro\n\nNew plan.\n\n</details>\n\n## Notes\n\nkeep me"));
        assert_eq!(with.blocks.iter().filter(|b| is_plan_expand(b)).count(), 1);
    }

    #[test]
    fn the_old_heading_section_is_read_and_is_replaced_by_the_expand_not_stacked_beside_it() {
        let old = md("Intro\n\n## Gossamr Plan\n\nold intro\n\n### Old\n\nold text\n\n## Notes\n\nkeep me");
        assert_eq!(old.plan_section().unwrap().to_markdown(), "old intro\n\n### Old\n\nold text");
        assert_eq!(old.without_plan_section().to_markdown(), "Intro\n\n## Notes\n\nkeep me");
        let with = old.with_plan_section("new intro", &md("New plan."));
        assert_eq!(with.to_markdown(), format!("Intro\n\n{OPEN}new intro\n\nNew plan.\n\n</details>\n\n## Notes\n\nkeep me"));
        assert!(!with.to_markdown().contains("## Gossamr Plan"));
        assert_eq!(with.plan_section().unwrap().to_markdown(), "new intro\n\nNew plan.");
    }

    #[test]
    fn the_old_heading_is_found_whatever_its_level_or_case_and_ends_at_the_next_heading_of_that_level_or_above() {
        let doc = md("# gossamr plan:\n\nkept in the section\n\n## Inner\n\nalso kept\n\n# Next\n\nout");
        assert_eq!(doc.plan_section().unwrap().to_markdown(), "kept in the section\n\n## Inner\n\nalso kept");
        assert_eq!(doc.without_plan_section().to_markdown(), "# Next\n\nout");
        assert_eq!(doc.with_plan_section("i", &md("Step")).to_markdown(), format!("{OPEN}i\n\nStep\n\n</details>\n\n# Next\n\nout"));
        assert!(md("A paragraph that says Gossamr Plan.\n\nGossamr Plan").plan_section().is_none());
        let titled = md("<details>\n<summary>gossamr plan</summary>\n\nin\n\n</details>");
        assert_eq!(titled.plan_section().unwrap().to_markdown(), "in");
        assert!(md("<details>\n<summary>Other</summary>\n\nin\n\n</details>").plan_section().is_none());
    }

    #[test]
    fn a_plan_that_names_itself_cannot_make_a_second_marker() {
        let with = md("x").with_plan_section("i", &md("## Gossamr Plan\n\n###### Deep"));
        assert_eq!(with.blocks.iter().filter(|b| marker_level(b).is_some() || is_plan_expand(b)).count(), 1);
        assert_eq!(with.plan_section().unwrap().to_markdown(), "i\n\nGossamr Plan\n\n###### Deep");
    }

    #[test]
    fn a_nested_expand_titled_like_the_plan_is_not_the_plan() {
        let nested = Doc { blocks: vec![Block::Quote { content: vec![Block::Expand { title: "Gossamr Plan".into(), content: md("hidden").blocks }] }] };
        assert!(nested.plan_section().is_none());
    }

    #[test]
    fn a_document_without_the_section_is_unchanged_by_taking_it_out() {
        let doc = md("Just text.\n\n- a\n- b");
        assert_eq!((doc.plan_section(), doc.without_plan_section()), (None, doc.clone()));
    }
}
