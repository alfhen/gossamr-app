//! The `Gossamr Plan` section of a description: where a Plan run's agreed plan lives on the ticket, found again by
//! its heading so a re-plan replaces it and later agents can be shown it.

use super::{Block, Doc, Inline};

pub const PLAN_HEADING: &str = "Gossamr Plan";
const NEW_LEVEL: u8 = 2;

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

impl Doc {
    /// The first `Gossamr Plan` heading, and where its section ends: at the next heading of the same or a higher level.
    fn plan_range(&self) -> Option<(usize, usize, u8)> {
        let at = self.blocks.iter().position(|b| marker_level(b).is_some())?;
        let level = marker_level(&self.blocks[at])?;
        let end = self.blocks[at + 1..].iter().position(|b| matches!(b, Block::Heading { level: l, .. } if *l <= level)).map_or(self.blocks.len(), |n| at + 1 + n);
        Some((at, end, level))
    }

    /// What stands under the `Gossamr Plan` heading, without the heading.
    pub fn plan_section(&self) -> Option<Doc> {
        let (at, end, _) = self.plan_range()?;
        Some(Doc { blocks: self.blocks[at + 1..end].to_vec() })
    }

    /// The document without its `Gossamr Plan` section, heading included.
    pub fn without_plan_section(&self) -> Doc {
        match self.plan_range() {
            Some((at, end, _)) => Doc { blocks: self.blocks[..at].iter().chain(&self.blocks[end..]).cloned().collect() },
            None => self.clone(),
        }
    }

    /// This document with `intro` and `plan` as its `Gossamr Plan` section: replacing the one it has, in place and at its
    /// heading level, or added at the end. The plan's headings are moved below the section's own so that they
    /// can't end it, and a heading in the plan that reads `Gossamr Plan` becomes a plain paragraph.
    pub fn with_plan_section(&self, intro: &str, plan: &Doc) -> Doc {
        let (before, after, level) = match self.plan_range() {
            Some((at, end, level)) => (self.blocks[..at].to_vec(), self.blocks[end..].to_vec(), level),
            None => (self.blocks.clone(), Vec::new(), NEW_LEVEL),
        };
        let plan: Vec<Block> = plan
            .blocks
            .iter()
            .map(|b| match b {
                Block::Heading { content, .. } if heading_is_marker(content) => Block::Paragraph { content: content.clone() },
                other => other.clone(),
            })
            .collect();
        let shallowest = plan.iter().filter_map(|b| if let Block::Heading { level, .. } = b { Some(*level) } else { None }).min();
        let shift = shallowest.filter(|l| *l <= level).map_or(0, |l| level + 1 - l);
        let mut blocks = before;
        blocks.push(Block::Heading { level, content: vec![Inline::Text { text: PLAN_HEADING.into(), marks: vec![] }] });
        blocks.extend(Doc::paragraph(intro).blocks);
        blocks.extend(plan.into_iter().map(|b| match b {
            Block::Heading { level: at, content } if (at + shift).min(6) > level => Block::Heading { level: (at + shift).min(6), content },
            Block::Heading { content, .. } => Block::Paragraph { content },
            other => other,
        }));
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

    #[test]
    fn a_plan_is_added_at_the_end_under_its_own_heading_with_its_headings_moved_below_it() {
        let doc = md("Cart total is wrong.\n\n## Steps to reproduce\n\n1. Add an item");
        let with = doc.with_plan_section("Drafted by an agent run.", &md("# Approach\n\nFix rounding.\n\n## Steps\n\n1. Edit cart.rs"));
        assert_eq!(
            with.to_markdown(),
            "Cart total is wrong.\n\n## Steps to reproduce\n\n1. Add an item\n\n## Gossamr Plan\n\nDrafted by an agent run.\n\n### Approach\n\nFix rounding.\n\n#### Steps\n\n1. Edit cart.rs"
        );
        assert_eq!(with.plan_section().unwrap().to_markdown(), "Drafted by an agent run.\n\n### Approach\n\nFix rounding.\n\n#### Steps\n\n1. Edit cart.rs");
        assert_eq!(with.without_plan_section(), doc);
    }

    #[test]
    fn a_second_plan_replaces_the_first_where_it_stands_and_leaves_what_follows() {
        let first = md("Intro\n\n## Gossamr Plan\n\nold intro\n\n### Old\n\nold text\n\n## Notes\n\nkeep me");
        let with = first.with_plan_section("new intro", &md("New plan."));
        assert_eq!(with.to_markdown(), "Intro\n\n## Gossamr Plan\n\nnew intro\n\nNew plan.\n\n## Notes\n\nkeep me");
        assert_eq!(with.blocks.iter().filter(|b| marker_level(b).is_some()).count(), 1);
    }

    #[test]
    fn the_heading_is_found_whatever_its_level_or_case_and_the_section_ends_at_the_next_heading_of_that_level_or_above() {
        let doc = md("# gossamr plan:\n\nkept in the section\n\n## Inner\n\nalso kept\n\n# Next\n\nout");
        assert_eq!(doc.plan_section().unwrap().to_markdown(), "kept in the section\n\n## Inner\n\nalso kept");
        assert_eq!(doc.without_plan_section().to_markdown(), "# Next\n\nout");
        let replaced = doc.with_plan_section("i", &md("## Step"));
        assert_eq!(replaced.to_markdown(), "# Gossamr Plan\n\ni\n\n## Step\n\n# Next\n\nout");
        assert!(md("A paragraph that says Gossamr Plan.\n\nGossamr Plan").plan_section().is_none());
    }

    #[test]
    fn a_plan_that_names_itself_cannot_make_a_second_marker_and_headings_stop_at_six() {
        let with = md("x").with_plan_section("i", &md("## Gossamr Plan\n\n###### Deep"));
        assert_eq!(with.blocks.iter().filter(|b| marker_level(b).is_some()).count(), 1);
        assert!(with.to_markdown().contains("Gossamr Plan\n\n###### Deep"));
    }

    #[test]
    fn a_heading_that_would_reach_the_sections_own_level_becomes_text_so_it_cannot_end_it() {
        let with = md("###### Gossamr Plan\n\nold").with_plan_section("i", &md("###### Deep\n\ntext"));
        assert_eq!(with.to_markdown(), "###### Gossamr Plan\n\ni\n\nDeep\n\ntext");
        assert_eq!(with.plan_section().unwrap().to_markdown(), "i\n\nDeep\n\ntext");
    }

    #[test]
    fn a_document_without_the_section_is_unchanged_by_taking_it_out() {
        let doc = md("Just text.\n\n- a\n- b");
        assert_eq!((doc.plan_section(), doc.without_plan_section()), (None, doc.clone()));
    }
}
