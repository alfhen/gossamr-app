//! Which cached code change a run produced.

use crate::domain::{CodeChange, CodeChangeKind, CodeChangeState, Run};

/// The branch names a run may have pushed: the one the session reported and the one its worktree is named after.
pub fn branches_of(run: &Run) -> Vec<String> {
    let named = format!("worktree-{}", run.spec.name);
    let mut out: Vec<String> = run.branch.iter().filter(|b| !b.trim().is_empty()).cloned().collect();
    if !out.contains(&named) {
        out.push(named);
    }
    out
}

fn rank(c: &CodeChange) -> (u8, u8) {
    let kind = if c.kind == CodeChangeKind::PullRequest { 0 } else { 1 };
    let state = match c.state {
        CodeChangeState::Open | CodeChangeState::Draft => 0,
        CodeChangeState::Merged => 1,
        CodeChangeState::Closed => 2,
    };
    (kind, state)
}

/// A pull request of the run's repository whose head is one of the run's branches, preferring open over merged over
/// closed and then the newest. With no pull request, the branch itself when it is known.
pub fn change_for(run: &Run, changes: &[CodeChange]) -> Option<CodeChange> {
    let branches = branches_of(run);
    changes
        .iter()
        .filter(|c| matches!(c.kind, CodeChangeKind::PullRequest | CodeChangeKind::Branch))
        .filter(|c| c.repo.eq_ignore_ascii_case(&run.spec.repo) && branches.contains(&c.head_ref))
        .min_by(|a, b| rank(a).cmp(&rank(b)).then(b.updated_at.cmp(&a.updated_at)).then(a.external_id.cmp(&b.external_id)))
        .cloned()
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;
    use crate::codehost::links::tests::pr;
    use crate::domain::fixtures::run_spec;
    use crate::domain::RunState;

    fn run() -> Run {
        let mut r = Run::queued("r".into(), "p".into(), "c".into(), None, run_spec(), "f".into(), Utc::now());
        r.state = RunState::Done;
        r
    }

    fn head() -> String {
        format!("worktree-{}", run_spec().name)
    }

    fn on(n: u64, branch: &str, state: CodeChangeState, day: u32) -> CodeChange {
        let mut c = pr(n, branch, "T", "");
        c.state = state;
        c.updated_at = Utc.with_ymd_and_hms(2026, 9, day, 9, 0, 0).unwrap();
        c
    }

    #[test]
    fn a_pull_request_from_the_worktree_branch_is_found_when_the_run_has_not_reported_a_branch() {
        let found = change_for(&run(), &[on(1, "other", CodeChangeState::Open, 28), on(2, &head(), CodeChangeState::Open, 28)]).unwrap();
        assert_eq!(found.number, Some(2));
    }

    #[test]
    fn the_branch_the_session_reported_counts_too() {
        let mut r = run();
        r.branch = Some("worktree-reported".into());
        assert_eq!(change_for(&r, &[on(3, "worktree-reported", CodeChangeState::Open, 28)]).unwrap().number, Some(3));
    }

    #[test]
    fn open_wins_over_merged_over_closed_and_then_the_newest() {
        let all = [on(1, &head(), CodeChangeState::Closed, 29), on(2, &head(), CodeChangeState::Merged, 29), on(3, &head(), CodeChangeState::Open, 20), on(4, &head(), CodeChangeState::Open, 27)];
        assert_eq!(change_for(&run(), &all).unwrap().number, Some(4));
        assert_eq!(change_for(&run(), &all[..3]).unwrap().number, Some(3));
        assert_eq!(change_for(&run(), &all[..2]).unwrap().number, Some(2));
        assert_eq!(change_for(&run(), &all[..1]).unwrap().number, Some(1));
    }

    #[test]
    fn another_repository_and_a_branch_named_after_a_fork_are_ignored() {
        let mut elsewhere = on(1, &head(), CodeChangeState::Open, 28);
        elsewhere.repo = "acme/gateway".into();
        let forked = on(2, &format!("someone:{}", head()), CodeChangeState::Open, 28);
        assert_eq!(change_for(&run(), &[elsewhere, forked]), None);
    }

    #[test]
    fn the_repository_is_compared_without_regard_to_case() {
        let mut c = on(1, &head(), CodeChangeState::Open, 28);
        c.repo = "ACME/WebShop".into();
        assert!(change_for(&run(), &[c]).is_some());
    }

    #[test]
    fn with_no_pull_request_the_branch_is_returned_and_a_commit_is_not() {
        let mut branch = on(1, &head(), CodeChangeState::Open, 28);
        branch.kind = CodeChangeKind::Branch;
        branch.number = None;
        let mut commit = branch.clone();
        commit.kind = CodeChangeKind::Commit;
        commit.external_id = "commit:acme/webshop@abc".into();
        assert_eq!(change_for(&run(), &[commit.clone()]), None);
        assert_eq!(change_for(&run(), &[commit, branch.clone()]).unwrap().kind, CodeChangeKind::Branch);
        let merged_pr = on(5, &head(), CodeChangeState::Closed, 1);
        assert_eq!(change_for(&run(), &[branch, merged_pr]).unwrap().number, Some(5), "a pull request, even a closed one, is better than the bare branch");
    }
}
