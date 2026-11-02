//! Which connection a Pip turn works in.

use super::Core;
use crate::auth::Scope;
use crate::config::AppConfig;
use crate::domain::ItemRef;
use crate::error::Result;

impl Core {
    /// The connection a Pip turn works in: the workstream's, else the open ticket's, else the one the person picked in the
    /// drawer, else the primary. A connection the page names must be registered and on; the page's word for it is
    /// checked here, never trusted.
    pub async fn pip_scope(&self, workstream: Option<&str>, open: Option<&ItemRef>, drawer: Option<&str>) -> Result<Scope> {
        if let Some(id) = workstream {
            return self.workstream_scope(id).await;
        }
        let named = open.map(|i| i.connection_id.as_str()).filter(|c| !c.is_empty()).or(drawer.filter(|c| !c.is_empty()));
        match named {
            Some(connection_id) => {
                self.refuse_hidden(connection_id)?;
                self.scope_of(connection_id).await
            }
            None => self.scope().await,
        }
    }

    /// The name of the connection `scope` is, when more than one Jira connection is on, so Pip can be told which one the
    /// turn is in.
    pub async fn pip_site(&self, scope: &Scope) -> Option<String> {
        let on = self.on_accounts().await.ok().filter(|on| on.len() > 1)?;
        let here = on.iter().find(|s| s.scope == *scope)?;
        let config = AppConfig::load(&self.data_dir);
        let named = config.connections.iter().find(|i| i.bound_to.as_deref().unwrap_or(&i.id) == scope.connection_id);
        Some(named.map_or_else(|| here.site.name.clone(), |i| i.display_name.clone()))
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::ItemRef;
    use crate::error::Error;
    use crate::inbox::testing::fixture_with_two_jira;

    fn on(connection_id: &str, key: &str) -> ItemRef {
        ItemRef { connection_id: connection_id.into(), external_id: key.into(), key: key.into() }
    }

    #[tokio::test]
    async fn a_turn_works_in_the_workstreams_connection_else_the_open_tickets_else_the_drawers_else_the_primary() {
        let (fx, second) = fixture_with_two_jira().await;
        let (first, other) = (fx.scope.connection_id.as_str(), second.connection_id.as_str());
        let ws = fx.core.open_workstream(&second, None, Some("On Beta".into())).await.unwrap();

        async fn scope(core: &crate::inbox::Core, ws: Option<&str>, item: Option<&ItemRef>, drawer: Option<&str>) -> crate::error::Result<crate::auth::Scope> {
            core.pip_scope(ws, item, drawer).await
        }
        let core = &fx.core;
        assert_eq!(scope(core, Some(&ws.id), Some(&on(first, "CA-1")), Some(first)).await.unwrap(), second);
        assert_eq!(scope(core, None, Some(&on(other, "CA-1")), Some(first)).await.unwrap(), second);
        assert_eq!(scope(core, None, None, Some(other)).await.unwrap(), second);
        assert_eq!(scope(core, None, Some(&on("", "CA-1")), Some(other)).await.unwrap(), second, "a ref the page sent without a connection says nothing");
        assert_eq!(scope(core, None, None, None).await.unwrap(), fx.scope);
        assert_eq!(scope(core, None, None, Some("")).await.unwrap(), fx.scope);
    }

    #[tokio::test]
    async fn a_connection_the_page_names_is_refused_when_it_is_off_unknown_or_not_jira() {
        let (fx, second) = fixture_with_two_jira().await;
        fx.core.adopt_instances().await;
        fx.core.set_instance_enabled("jira_2", false).await.unwrap();

        let off = fx.core.pip_scope(None, None, Some(&second.connection_id)).await.unwrap_err();
        assert!(off.to_string().contains("Beta is off"), "{off}");
        let off_item = fx.core.pip_scope(None, Some(&on(&second.connection_id, "CA-1")), None).await.unwrap_err();
        assert!(off_item.to_string().contains("Beta is off"), "{off_item}");
        for stale in ["jira:gone:nobody", "github:alfhen"] {
            assert!(matches!(fx.core.pip_scope(None, None, Some(stale)).await, Err(Error::SiteChanged)), "{stale}");
        }
        assert_eq!(fx.core.pip_scope(None, None, Some(&fx.scope.connection_id)).await.unwrap(), fx.scope);
    }

    #[tokio::test]
    async fn pip_is_told_the_site_only_when_more_than_one_jira_connection_is_on() {
        let (fx, second) = fixture_with_two_jira().await;
        fx.core.adopt_instances().await;
        assert_eq!(fx.core.pip_site(&second).await.as_deref(), Some("Beta"));
        assert_eq!(fx.core.pip_site(&fx.scope).await.as_deref(), Some("Acme"));

        fx.core.set_instance_enabled("jira_2", false).await.unwrap();
        assert_eq!(fx.core.pip_site(&fx.scope).await, None);
    }
}
