use std::sync::Arc;

use crate::ai::types::ToolSpec;
use crate::core::extension::{Extension, ExtensionRunner};
use crate::core::pipeline::PromptSection;
use crate::core::tool::Tool;

#[derive(Clone, Default)]
pub struct ExtensionRegistry {
    extensions: Vec<Arc<dyn Extension>>,
}

impl ExtensionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, ext: Arc<dyn Extension>) {
        if self.extensions.iter().any(|existing| existing.name() == ext.name()) {
            self.extensions.retain(|existing| existing.name() != ext.name());
        }
        self.extensions.push(ext);
    }

    pub fn extensions(&self) -> &[Arc<dyn Extension>] {
        &self.extensions
    }

    pub fn runner(&self) -> ExtensionRunner {
        ExtensionRunner::new(self.extensions.clone())
    }

    pub fn tools(&self) -> Vec<Box<dyn Tool>> {
        let mut out = Vec::new();
        for ext in &self.extensions {
            out.extend(ext.tools());
        }
        out
    }

    pub fn tool_specs(&self) -> Vec<ToolSpec> {
        self.tools().into_iter().map(|t| t.spec()).collect()
    }

    pub fn sections(&self) -> Vec<PromptSection> {
        let mut out = Vec::new();
        for ext in &self.extensions {
            out.extend(ext.sections());
        }
        out
    }
}
