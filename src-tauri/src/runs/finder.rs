//! What Pip's agent tools ask of the run service: where a run would go, and to start, message and stop one.

use std::sync::Arc;

use async_trait::async_trait;

use super::backend::BackendError;
use super::failure::Failure;
use super::fresh::{remote_default_branch, work_path};
use super::launcher::RunLauncher;
use super::message::Delivery;
use super::service::waiting_words;
use super::repo::{existing_names, new_name, origin_matches};
use super::service::RunService;
use crate::agent::AgentDriver;
use crate::domain::{Actor, ClonePlan, Run};
use crate::error::Result;
use crate::model_choice::ModelChoice;

#[async_trait]
impl AgentDriver for RunService {
    async fn plan(&self, repo: &str, key: &str, title: &str) -> std::result::Result<ClonePlan, String> {
        self.core.require_watched_repo(repo).map_err(|e| e.to_string())?;
        let home = self.fresh_home().ok_or("Gossamr can't find your home folder.")?;
        let path = work_path(&home, repo).map_err(|e| e.to_string())?;
        let git = self.git().await.map_err(|e| e.to_string())?;
        let cloned = path.join(".git").exists() && git.origin(&path).await.is_some_and(|url| origin_matches(&url, repo));
        let (base, taken) = match cloned.then_some(&path) {
            Some(clone) => (git.default_branch(clone).await, existing_names(&git, clone).await),
            None => (None, Default::default()),
        };
        let base = match base {
            Some(base) => base,
            None => remote_default_branch(&git, repo).await.map_err(|e| e.to_string())?,
        };
        Ok(ClonePlan { path, base, name: new_name(key, title, &taken) })
    }

    async fn unready(&self, workstream_choice: Option<&ModelChoice>) -> Option<String> {
        let (choice, instance) = self.core.agents_target(workstream_choice).ok()?;
        let tc = match self.tools.for_instance(&choice.instance_id).await {
            Ok(tc) => tc,
            Err(e) if waiting_words(&e, &instance.display_name).is_some() => return None,
            Err(e) => return Some(Failure::from(e).to_string()),
        };
        match tc.backend.signed_in().await {
            Ok(false) => Some(Failure::NotSignedIn { instance: tc.instance_name.clone(), own_folder: tc.has_own_folder() }.to_string()),
            Err(BackendError::Spawn { source: e, .. }) if e.kind() == std::io::ErrorKind::NotFound => Some(Failure::ClaudeMissing { instance: tc.instance_name.clone(), driver: tc.driver }.to_string()),
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
    use crate::runs::fresh::agents_root;
    use crate::runs::repo::testing::clone_with_origin;
    use crate::runs::rig::{legacy_clone, ready};

    #[tokio::test]
    async fn the_plan_is_the_work_folder_clone_its_default_branch_and_a_new_worktree_name() {
        let rig = ready().await;
        std::fs::write(rig.clone.join(".fake-branches"), "worktree-ca-1-fix-the-cart-0001\n").unwrap();
        let plan = rig.svc.plan("acme/webshop", "CA-1", "Fix the cart").await.unwrap();
        assert_eq!(plan.path, rig.clone);
        assert!(plan.name.starts_with("ca-1-fix-the-cart-") && plan.name != "ca-1-fix-the-cart-0001", "{}", plan.name);
        assert_eq!(plan.base, "main");
    }

    #[tokio::test]
    async fn a_clone_in_code_is_ignored_even_when_it_is_the_only_one() {
        let rig = ready().await;
        std::fs::remove_dir_all(&rig.clone).unwrap();
        let legacy = legacy_clone(&rig.fx);
        let plan = rig.svc.plan("acme/webshop", "CA-1", "x").await.unwrap();
        assert_ne!(plan.path, legacy);
        assert_eq!(plan.path, agents_root(&rig.fx.home).join("acme/webshop"));
        assert_eq!(plan.base, "main", "the base comes from the remote when there is no clone yet");
        let log = std::fs::read_to_string(rig.fx.dir.join("git.log")).unwrap_or_default();
        assert!(!log.contains(&legacy.display().to_string()), "git never looked in ~/Code: {log}");
    }

    #[tokio::test]
    async fn a_repository_with_no_clone_yet_plans_the_path_and_makes_nothing() {
        let rig = ready().await;
        std::fs::remove_dir_all(&rig.clone).unwrap();
        let plan = rig.svc.plan("Acme/WebShop", "CA-1", "x").await.unwrap();
        assert_eq!(plan.path, rig.clone);
        assert!(!plan.path.exists());
    }

    #[tokio::test]
    async fn an_unwatched_repository_comes_back_as_words_for_pip() {
        let rig = ready().await;
        let unwatched = rig.svc.plan("acme/other", "CA-1", "x").await.unwrap_err();
        assert!(unwatched.contains("isn't a repository you watch"), "{unwatched}");
        clone_with_origin(&rig.fx.home.join("Code/other"), "https://github.com/acme/other.git");
    }

    fn second_claude(rig: &crate::runs::rig::Rig) {
        crate::config::AppConfig::update(&rig.fx.core.data_dir(), |config| {
            config.providers.push(crate::connections::ProviderInstance { id: "claude_2".into(), display_name: "Claude personal".into(), ..crate::connections::default_claude() })
        })
        .unwrap();
    }

    fn on_claude_2() -> ModelChoice {
        ModelChoice { instance_id: "claude_2".into(), model: "default".into(), effort: None }
    }

    #[tokio::test]
    async fn pip_can_start_an_agent_on_a_workstream_choice_that_is_ready_while_the_default_login_is_signed_out() {
        let rig = ready().await;
        second_claude(&rig);
        let (svc, _) = crate::runs::rig::with_second_login(&rig.fx, &rig.cli);
        rig.cli.with(|s| s.logged_in = false);
        assert_eq!(svc.unready(Some(&on_claude_2())).await, None);
        assert!(svc.unready(None).await.is_some_and(|why| why.contains("sign")), "the default is the one that is signed out");
    }

    #[tokio::test]
    async fn pip_is_told_when_the_workstream_choice_is_signed_out_though_the_default_is_ready() {
        let rig = ready().await;
        second_claude(&rig);
        let (svc, second) = crate::runs::rig::with_second_login(&rig.fx, &rig.cli);
        second.with(|s| s.logged_in = false);
        assert!(svc.unready(Some(&on_claude_2())).await.is_some());
        assert_eq!(svc.unready(None).await, None);
    }
}
