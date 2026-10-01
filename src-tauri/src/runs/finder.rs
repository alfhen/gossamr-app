//! Lets Pip's run tools ask where a run would go. It answers with a clone and a name and cannot start anything.

use std::path::PathBuf;

use async_trait::async_trait;

use super::service::RunService;
use crate::agent::RunPlanner;
use crate::domain::ClonePlan;

#[async_trait]
impl RunPlanner for RunService {
    fn enabled(&self) -> bool {
        self.is_enabled()
    }

    async fn plan(&self, repo: &str, key: &str, title: &str) -> Result<ClonePlan, String> {
        let choice = self.clones(repo).await.map_err(|e| e.to_string())?;
        // The person's pick is listed first. Without one, the first by path: the draft is still theirs to read and edit.
        let clone = match &choice.picked {
            Some(_) => choice.clones.first(),
            None => choice.clones.iter().min_by(|a, b| a.path.cmp(&b.path)),
        }
        .ok_or_else(|| format!("There is no local clone of {repo} in ~/Code, ~/Developer or ~/src. Ask the person to clone it there."))?;
        let path: PathBuf = clone.path.clone();
        let name = self.suggest_name(&path, key, title).await.map_err(|e| e.to_string())?;
        Ok(ClonePlan { path, base: clone.default_branch.clone().unwrap_or_else(|| clone.branch.clone()), name })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runs::rig::ready;
    use crate::runs::repo::testing::clone_with_origin;

    #[tokio::test]
    async fn the_plan_is_the_clone_its_default_branch_and_a_new_worktree_name() {
        let rig = ready().await;
        let plan = rig.svc.plan("acme/webshop", "CA-1", "Fix the cart").await.unwrap();
        assert_eq!(plan.path, rig.clone);
        assert!(plan.name.starts_with("ca-1-fix-the-cart-"), "{}", plan.name);
        assert!(!plan.base.is_empty());
        assert!(<RunService as RunPlanner>::enabled(&rig.svc));
    }

    #[tokio::test]
    async fn without_a_pick_the_first_clone_by_path_is_used_and_a_pick_wins() {
        let rig = ready().await;
        let other = rig.fx.home.join("a-webshop");
        clone_with_origin(&other, "https://github.com/acme/webshop.git");
        let other = other.canonicalize().unwrap();
        let first = rig.svc.plan("acme/webshop", "CA-1", "x").await.unwrap().path;
        assert_eq!(first, other.min(rig.clone.clone()));
        rig.svc.pick_clone("acme/webshop", &rig.clone).await.unwrap();
        assert_eq!(rig.svc.plan("acme/webshop", "CA-1", "x").await.unwrap().path, rig.clone);
    }

    #[tokio::test]
    async fn no_clone_and_an_unwatched_repository_come_back_as_words_for_pip() {
        let rig = ready().await;
        std::fs::remove_dir_all(&rig.clone).unwrap();
        let none = rig.svc.plan("acme/webshop", "CA-1", "x").await.unwrap_err();
        assert!(none.contains("no local clone of acme/webshop"), "{none}");
        let unwatched = rig.svc.plan("acme/other", "CA-1", "x").await.unwrap_err();
        assert!(unwatched.contains("isn't a repository you watch"), "{unwatched}");
    }
}
