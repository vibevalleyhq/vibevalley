use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use vibevalley_protocol::{MachineRuntimeSummary, ModelEntry, RuntimeCapability};
use vibevalley_runtime::oar::{self, Registry, Runtime};

const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Builds the local OAR `Registry` according to `--runtime` filters and `--scripted`.
pub fn build_runtime_registry(filter: &[String], scripted: bool) -> Arc<Registry> {
    let mut registry = Registry::new();
    let filter_set: HashSet<String> = filter
        .iter()
        .map(|s| s.trim().strip_prefix("acp:").unwrap_or(s.trim()).to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // Pure `--scripted` without explicit external `--runtime` flags stays 100% deterministic and offline.
    if scripted && filter_set.is_empty() {
        registry.register(Arc::new(oar::scripted::ScriptedRuntime::new("scripted", oar::scripted::Script::echo())));
        return Arc::new(registry);
    }

    let defaults = oar::default_runtimes();
    let want_scripted = scripted || filter_set.contains("scripted");
    for runtime in defaults.list() {
        let bare = runtime.id().strip_prefix("acp:").unwrap_or(runtime.id());
        if bare == "scripted" {
            if want_scripted {
                registry.register(Arc::new(oar::scripted::ScriptedRuntime::new("scripted", oar::scripted::Script::echo())));
            }
            continue;
        }
        if filter_set.is_empty() || filter_set.contains(bare) || filter_set.contains(runtime.id()) {
            registry.register(runtime.clone());
        }
    }
    Arc::new(registry)
}

/// Probes each runtime in `registry` in parallel with bounded per-runtime timeout and maps to `MachineRuntimeSummary`.
pub async fn probe_runtime_summaries_async(registry: &Registry) -> Vec<MachineRuntimeSummary> {
    let runtimes = registry.list().to_vec();
    let mut set = tokio::task::JoinSet::new();
    for (idx, runtime) in runtimes.into_iter().enumerate() {
        set.spawn(async move { (idx, probe_single_runtime_async(&runtime).await) });
    }
    let mut results = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(item) = joined {
            results.push(item);
        }
    }
    results.sort_by_key(|(idx, _)| *idx);
    results.into_iter().map(|(_, s)| s).collect()
}

async fn probe_single_runtime_async(runtime: &Arc<dyn Runtime>) -> MachineRuntimeSummary {
    let bare_id = runtime.id().strip_prefix("acp:").unwrap_or(runtime.id()).to_string();
    let label = runtime.display_name().to_string();
    let caps = runtime.capabilities();

    let installation = tokio::time::timeout(RUNTIME_PROBE_TIMEOUT, runtime.installation())
        .await
        .unwrap_or(oar::Installation::NotInstalled);
    let available = matches!(installation, oar::Installation::Available { .. });

    // Only call `list_models()` eagerly for fast in-process runtimes (`scripted`) so daemon startup stays instant.
    let models = if available && bare_id == "scripted" {
        runtime
            .list_models()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|m| ModelEntry {
                id: m.id,
                name: m.display_name,
                effort_levels: m.effort_levels,
                default_effort: m.default_effort,
                is_default: m.is_default,
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut capabilities = Vec::new();
    if caps.model_selection {
        capabilities.push(RuntimeCapability::ListModels);
    }
    if caps.usage {
        capabilities.push(RuntimeCapability::AccountUsage);
    }
    capabilities.push(RuntimeCapability::McpServers);
    capabilities.push(RuntimeCapability::Tools);

    MachineRuntimeSummary {
        id: bare_id,
        label,
        models,
        capabilities,
        available,
    }
}
