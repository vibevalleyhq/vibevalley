use std::collections::HashSet;

use serde_json::Value;

use crate::ai::types::ToolSpec;
use crate::core::doc::{CONVERSATION_SCOPE, StandInDoc, StandInState, read_doc, write_doc};
use crate::core::pipeline::PromptSection;
use crate::core::tool::{Tool, ToolOutput};
use crate::durable::{self, Read, Tx};
use vibevalley_oar::BoxFuture;

/// Synthesized placeholder tool kept across restarts when a dynamic extension
/// has not yet reattached, preserving the prompt/tool prefix cache.
pub struct StandInTool {
    pub spec: ToolSpec,
}

impl StandInTool {
    pub fn new(spec: ToolSpec) -> Self {
        Self { spec }
    }
}

impl Tool for StandInTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn execute<'a>(&'a self, _args: &'a Value) -> BoxFuture<'a, ToolOutput> {
        let name = self.spec.name.clone();
        Box::pin(std::future::ready(ToolOutput::error(format!(
            "extension tool `{name}` is currently unavailable after restart; reattach its extension before calling it"
        ))))
    }
}

#[derive(Default)]
pub struct StandInRecovery {
    pub missing_sections: Vec<PromptSection>,
    pub stub_tools: Vec<Box<dyn Tool>>,
}

pub struct StandIn;

impl StandIn {
    pub async fn save(tx: &mut Tx<'_>, conv: &str, sections: &[PromptSection], tool_specs: &[ToolSpec]) -> durable::Result<()> {
        let state = StandInState {
            sections: sections.to_vec(),
            tool_specs: tool_specs.to_vec(),
        };
        write_doc::<StandInDoc>(tx, CONVERSATION_SCOPE, conv, &state).await?;
        Ok(())
    }

    pub async fn reconcile(read: &Read<'_>, conv: &str, active_sections: &[PromptSection], active_tools: &[ToolSpec]) -> durable::Result<StandInRecovery> {
        let saved = read_doc::<StandInDoc>(read, CONVERSATION_SCOPE, conv).await?;
        let present_sections: HashSet<&str> = active_sections.iter().map(|s| s.key.as_str()).collect();
        let present_tools: HashSet<&str> = active_tools.iter().map(|t| t.name.as_str()).collect();

        let missing_sections = saved.sections.into_iter().filter(|s| !present_sections.contains(s.key.as_str())).collect();
        let stub_tools = saved
            .tool_specs
            .into_iter()
            .filter(|spec| !present_tools.contains(spec.name.as_str()))
            .map(|spec| Box::new(StandInTool::new(spec)) as Box<dyn Tool>)
            .collect();

        Ok(StandInRecovery { missing_sections, stub_tools })
    }
}
