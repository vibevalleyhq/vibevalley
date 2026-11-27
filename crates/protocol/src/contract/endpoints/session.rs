use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "session.stop",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("SessionStopInput"),
        result: None,
    },
    Endpoint {
        op: "session.list",
        module: "session",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("SessionListInput"),
        result: Some("Vec<Session>"),
    },
    Endpoint {
        op: "session.get",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionGetInput"),
        result: Some("Session"),
    },
    Endpoint {
        op: "session.event.list",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionEventListInput"),
        result: Some("SessionEventPage"),
    },
    Endpoint {
        op: "session.openWorkspace",
        module: "session",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionOpenWorkspaceInput"),
        result: Some("SessionWorkspace"),
    },
    Endpoint {
        op: "session.closeWorkspace",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionCloseWorkspaceInput"),
        result: None,
    },
    Endpoint {
        op: "session.send",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionSendInput"),
        result: Some("Session"),
    },
    Endpoint {
        op: "session.respondPermission",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionRespondPermissionInput"),
        result: None,
    },
    Endpoint {
        op: "session.respondInteraction",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionRespondInteractionInput"),
        result: None,
    },
    Endpoint {
        op: "session.setConfig",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionSetConfigInput"),
        result: Some("SessionWorkspace"),
    },
    Endpoint {
        op: "session.childTranscript",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionChildTranscriptInput"),
        result: Some("SessionChildTranscript"),
    },
    Endpoint {
        op: "session.compact",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionCompactInput"),
        result: Some("SessionCompactResult"),
    },
    Endpoint {
        op: "session.runCode",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionRunCodeInput"),
        result: Some("SessionRunCodeResult"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    /// Stops a session's turn; it stays, and a comment starts the next.
    pub struct SessionStop;
    impl Op for SessionStop {
        const NAME: &'static str = "session.stop";
        type Input = t::SessionStopInput;
        type Result = ();
    }
    pub struct SessionList;
    impl Op for SessionList {
        const NAME: &'static str = "session.list";
        type Input = t::SessionListInput;
        type Result = Vec<t::Session>;
    }
    pub struct SessionGet;
    impl Op for SessionGet {
        const NAME: &'static str = "session.get";
        type Input = t::SessionGetInput;
        type Result = t::Session;
    }
    /// Its log, oldest first. `run` narrows to one run; cursor fields page history.
    pub struct SessionEventList;
    impl Op for SessionEventList {
        const NAME: &'static str = "session.event.list";
        type Input = t::SessionEventListInput;
        type Result = t::SessionEventPage;
    }
    /// Opens or resumes a direct workspace chat session in a directory with no issue.
    pub struct SessionOpenWorkspace;
    impl Op for SessionOpenWorkspace {
        const NAME: &'static str = "session.openWorkspace";
        type Input = t::SessionOpenWorkspaceInput;
        type Result = t::SessionWorkspace;
    }
    /// Closes a direct workspace chat session, aborting any running turn without touching the project directory.
    pub struct SessionCloseWorkspace;
    impl Op for SessionCloseWorkspace {
        const NAME: &'static str = "session.closeWorkspace";
        type Input = t::SessionCloseWorkspaceInput;
        type Result = ();
    }
    /// Sends a user message to a workspace session (starts a turn when idle or steers when working).
    pub struct SessionSend;
    impl Op for SessionSend {
        const NAME: &'static str = "session.send";
        type Input = t::SessionSendInput;
        type Result = t::Session;
    }
    /// Answers a pending tool permission request for a session.
    pub struct SessionRespondPermission;
    impl Op for SessionRespondPermission {
        const NAME: &'static str = "session.respondPermission";
        type Input = t::SessionRespondPermissionInput;
        type Result = ();
    }
    /// Answers a pending interactive question from a session.
    pub struct SessionRespondInteraction;
    impl Op for SessionRespondInteraction {
        const NAME: &'static str = "session.respondInteraction";
        type Input = t::SessionRespondInteractionInput;
        type Result = ();
    }
    /// Updates model, effort, or permission mode on a workspace session.
    pub struct SessionSetConfig;
    impl Op for SessionSetConfig {
        const NAME: &'static str = "session.setConfig";
        type Input = t::SessionSetConfigInput;
        type Result = t::SessionWorkspace;
    }
    /// Reads bounded recent transcript steps for a child agent or swarm member.
    pub struct SessionChildTranscript;
    impl Op for SessionChildTranscript {
        const NAME: &'static str = "session.childTranscript";
        type Input = t::SessionChildTranscriptInput;
        type Result = t::SessionChildTranscript;
    }
    /// Manually triggers context compaction for a durable or runtime session.
    pub struct SessionCompact;
    impl Op for SessionCompact {
        const NAME: &'static str = "session.compact";
        type Input = t::SessionCompactInput;
        type Result = t::SessionCompactResult;
    }
    /// Executes a durable CodeMode JavaScript script in the session's tool context.
    pub struct SessionRunCode;
    impl Op for SessionRunCode {
        const NAME: &'static str = "session.runCode";
        type Input = t::SessionRunCodeInput;
        type Result = t::SessionRunCodeResult;
    }
}
