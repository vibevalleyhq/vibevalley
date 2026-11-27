use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "orchestrator.open",
        module: "orchestrator",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: None,
    },
    Endpoint {
        op: "orchestrator.stop",
        module: "orchestrator",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("OrchestratorStopInput"),
        result: None,
    },
    Endpoint {
        op: "orchestrator.eval.create",
        module: "orchestrator",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("OrchestratorEvalRequest"),
        result: Some("OrchestratorEval"),
    },
    Endpoint {
        op: "orchestrator.approval.list",
        module: "orchestrator",
        about: &["conversationId"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("OrchestratorApprovalListInput"),
        result: Some("Vec<OrchestratorApproval>"),
    },
    Endpoint {
        op: "orchestrator.approval.resolve",
        module: "orchestrator",
        about: &["conversationId", "taskId", "toolCallId"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("OrchestratorApprovalResolveInput"),
        result: None,
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    /// Only on this machine: never through the gate.
    /// Takes back the key the request came with.
    /// What deleting the device would do, refused as it would be; nothing changes.
    /// A device asks to be signed in (the command line's auth login); no key needed.
    /// The asking device collects its key once approved; no key needed, the claim is its proof.
    /// What stopPairing would do, refused as it would be; nothing changes.
    pub struct OrchestratorOpen;
    impl Op for OrchestratorOpen {
        const NAME: &'static str = "orchestrator.open";
        type Input = ();
        type Result = ();
    }
    /// Ends the orchestrator's run under way and drops what waits for it; the sessions it sent keep working.
    pub struct OrchestratorStop;
    impl Op for OrchestratorStop {
        const NAME: &'static str = "orchestrator.stop";
        type Input = t::OrchestratorStopInput;
        type Result = ();
    }
    /// Saves the turn begun at a step of the orchestrator's log as a case for its evals, with what it should have done.
    pub struct OrchestratorEvalCreate;
    impl Op for OrchestratorEvalCreate {
        const NAME: &'static str = "orchestrator.eval.create";
        type Input = t::OrchestratorEvalRequest;
        type Result = t::OrchestratorEval;
    }
    pub struct OrchestratorApprovalList;
    impl Op for OrchestratorApprovalList {
        const NAME: &'static str = "orchestrator.approval.list";
        type Input = t::OrchestratorApprovalListInput;
        type Result = Vec<t::OrchestratorApproval>;
    }
    pub struct OrchestratorApprovalResolve;
    impl Op for OrchestratorApprovalResolve {
        const NAME: &'static str = "orchestrator.approval.resolve";
        type Input = t::OrchestratorApprovalResolveInput;
        type Result = ();
    }
}
