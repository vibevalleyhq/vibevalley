use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "memory.list",
        module: "memory",
        about: &["agent"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MemoryListInput"),
        result: Some("MemoryList"),
    },
    Endpoint {
        op: "memory.recall",
        module: "memory",
        about: &["agent"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MemoryRecallInput"),
        result: Some("RecallPreview"),
    },
    Endpoint {
        op: "memory.create",
        module: "memory",
        about: &["agent"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("MemoryCreateInput"),
        result: Some("Memory"),
    },
    Endpoint {
        op: "memory.search",
        module: "memory",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("MemorySearchInput"),
        result: Some("MemorySearch"),
    },
    Endpoint {
        op: "memory.delete",
        module: "memory",
        about: &["agent", "memory"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("memory.previewDelete"),
        input: Some("MemoryDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "memory.previewDelete",
        module: "memory",
        about: &["agent", "memory"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MemoryDeleteInput"),
        result: Some("Preview"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    /// An agent's memories from the database and its configured sources.
    pub struct MemoryList;
    impl Op for MemoryList {
        const NAME: &'static str = "memory.list";
        type Input = t::MemoryListInput;
        type Result = t::MemoryList;
    }
    /// What the agent would recall for this repo and input.
    pub struct MemoryRecall;
    impl Op for MemoryRecall {
        const NAME: &'static str = "memory.recall";
        type Input = t::MemoryRecallInput;
        type Result = t::RecallPreview;
    }
    pub struct MemoryCreate;
    impl Op for MemoryCreate {
        const NAME: &'static str = "memory.create";
        type Input = t::MemoryCreateInput;
        type Result = t::Memory;
    }
    /// Memories whose words match, from every source the agent has; none named is every profile's.
    pub struct MemorySearch;
    impl Op for MemorySearch {
        const NAME: &'static str = "memory.search";
        type Input = t::MemorySearchInput;
        type Result = t::MemorySearch;
    }
    pub struct MemoryDelete;
    impl Op for MemoryDelete {
        const NAME: &'static str = "memory.delete";
        type Input = t::MemoryDeleteInput;
        type Result = ();
    }
    /// What delete would do, refused as it would be; nothing changes.
    pub struct MemoryPreviewDelete;
    impl Op for MemoryPreviewDelete {
        const NAME: &'static str = "memory.previewDelete";
        type Input = t::MemoryDeleteInput;
        type Result = t::Preview;
    }
}
