//! What Pip's agent tools ask of the run service: where a run would go, and to start, message and stop one.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use super::cli::CliError;
use super::failure::Failure;
use super::launcher::RunLauncher;
use super::message::Delivery;
use super::service::RunService;
use crate::agent::AgentDriver;
use crate::domain::{Actor, ClonePlan, Run};
use crate::error::Result;

#[async_trait]
impl AgentDriver for RunService {
    async fn plan(&self, repo: &str, key: &str, title: &str) -> std::result::Result<ClonePlan, String> {
        let choice = self.clones(repo).await.map_err(|e| e.to_string())?;
        // The person's pick is listed first. Without one, the first by path.
        let clone = match &choice.picked {
            Some(_) => choice.clones.first(),
            None => choice.clones.iter().min_by(|a, b| a.path.cmp(&b.path)),
        }
        .ok_or_else(|| format!("There is no local clone of {repo} in ~/Code, ~/Developer or ~/src. Ask the person to clone it there."))?;
        let path: PathBuf = clone.path.clone();
        let name = self.suggest_name(&path, key, title).await.map_err(|e| e.to_string())?;
        Ok(ClonePlan { path, base: clone.default_branch.clone().unwrap_or_else(|| clone.branch.clone()), name })
    }

    async fn unready(&self) -> Option<String> {
        let tc = match self.toolchain().await {
            Ok(tc) => tc,
            Err(e) => return Some(e.to_string()),
        };
        match tc.cli.auth_status().await {
            Ok(auth) if !auth.logged_in => Some(Failure::NotSignedIn.to_string()),
            Err(CliError::Spawn(e)) if e.kind() == std::io::ErrorKind::NotFound => Some(Failure::ClaudeMissing.to_string()),
            _ => None,
        }
    }

    async fn begin(self: Arc<Self>, run_id: String) -> Result<Run> {
        let run = match self.note_slot_wait(&run_id).await {
            Ok(noted) => noted,
            Err(e) => {
                eprintln!("couldn't check the slots for run {run_id}: {e}");
                self.load(&run_id).await?
            }
        };
        (self.changed)(&run.connection_id);
        let launcher = self.clone();
        tokio::spawn(async move {
            // A failed launch is recorded on the run itself; an error here means it couldn't be recorded.
            if let Err(e) = launcher.launch(&run_id).await {
                eprintln!("couldn't start run {run_id}: {e}");
            }
        });
        Ok(run)
    }

    async fn message(&self, run_id: &str, text: &str) -> Result<(Run, Delivery)> {
        self.message_agent(run_id, text, Actor::Pip).await
    }

    async fn stop(self: Arc<Self>, run_id: String) -> Result<Run> {
        let stopped = self.stop_as(&run_id, Actor::Pip).await?;
        tokio::spawn(async move {
            if let Err(e) = self.launch_waiting().await {
                eprintln!("couldn't start the runs waiting for a slot: {e}");
            }
        });
        Ok(stopped)
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
