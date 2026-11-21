//! Controlled experimental features mounted strictly via `Extension`.

use std::sync::Arc;

use crate::oar::Registry;
use serde::{Deserialize, Serialize};

use crate::agent::core::extension::Extension;
use crate::agent::extensions::{CodeModeExtension, OarExtension, OarPolicy};
use crate::agent::harness::Harness;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExperimentFlags {
    pub codemode: bool,
    pub tree_branch: bool,
    pub oar_delegate: bool,
}

#[derive(Clone, Default)]
struct TreeBranchExtension;

impl Extension for TreeBranchExtension {
    fn name(&self) -> &str {
        "tree_branch"
    }
}

pub fn mount_experiments(harness: &Harness, flags: &ExperimentFlags, oar: Option<(Arc<Registry>, OarPolicy)>) {
    if flags.codemode {
        harness.register_extension(Arc::new(CodeModeExtension::default()));
    }
    if flags.oar_delegate
        && let Some((registry, policy)) = oar
    {
        harness.register_extension(Arc::new(OarExtension::new(registry, policy)));
    }
    if flags.tree_branch {
        harness.register_extension(Arc::new(TreeBranchExtension));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::durable::Store;

    #[test]
    fn default_experiment_flags_mount_nothing() -> crate::agent::durable::Result<()> {
        let store = Store::memory()?;
        let harness = Harness::workers_only(store);
        let registry = Arc::new(Registry::new());
        mount_experiments(&harness, &ExperimentFlags::default(), Some((registry, OarPolicy::default())));
        assert!(harness.extension_names().is_empty());
        Ok(())
    }

    #[test]
    fn enabled_experiment_flags_mount_expected_extensions() -> crate::agent::durable::Result<()> {
        let store = Store::memory()?;
        let harness = Harness::workers_only(store);
        let registry = Arc::new(Registry::new());
        let flags = ExperimentFlags {
            codemode: true,
            tree_branch: true,
            oar_delegate: true,
        };
        harness.with_experiments(&flags, Some((registry, OarPolicy::default())));
        let names = harness.extension_names();
        assert_eq!(names, vec!["codemode", "oar", "tree_branch"]);
        Ok(())
    }
}
