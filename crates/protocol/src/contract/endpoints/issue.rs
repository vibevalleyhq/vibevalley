use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "issue.conversation.get",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("IssueConversationGetInput"),
        result: Some("Option<String>"),
    },
    Endpoint {
        op: "issue.comment.create",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueCommentCreateInput"),
        result: Some("Applied"),
    },
    Endpoint {
        op: "issue.diff.get",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueDiffGetInput"),
        result: Some("Changes"),
    },
    Endpoint {
        op: "issue.history.list",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<IssueHistory>"),
    },
    Endpoint {
        op: "issue.list",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueFilter"),
        result: Some("Vec<Issue>"),
    },
    Endpoint {
        op: "issue.review",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueReviewInput"),
        result: Some("Issue"),
    },
    Endpoint {
        op: "issue.split",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Session],
        dry_run: None,
        input: Some("IssueSplitInput"),
        result: Some("String"),
    },
    Endpoint {
        op: "issue.get",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueGetInput"),
        result: Some("Issue"),
    },
    Endpoint {
        op: "issue.run.list",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("IssueRunListInput"),
        result: Some("Vec<Run>"),
    },
    Endpoint {
        op: "issue.timeline.get",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("IssueTimelineGetInput"),
        result: Some("IssueTimeline"),
    },
    Endpoint {
        op: "issue.create",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueRequest"),
        result: Some("AppliedIssue"),
    },
    Endpoint {
        op: "issue.update",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueUpdateInput"),
        result: Some("AppliedIssue"),
    },
    Endpoint {
        op: "issue.body.ensure",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueBodyEnsureInput"),
        result: Some("IssueBodyEnsureResult"),
    },
    Endpoint {
        op: "issue.delete",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("issue.previewDelete"),
        input: Some("IssueDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "issue.previewDelete",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("IssueDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "issue.status.update",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: Some("issue.status.previewUpdate"),
        input: Some("IssueStatusUpdateInput"),
        result: Some("AppliedIssue"),
    },
    Endpoint {
        op: "issue.status.previewUpdate",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueStatusUpdateInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "issue.refine",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueRefineInput"),
        result: Some("Issue"),
    },
    Endpoint {
        op: "issue.retro.get",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueRetroGetInput"),
        result: Some("IssueRetroReport"),
    },
    Endpoint {
        op: "issue.digest.get",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueDigestGetInput"),
        result: Some("MorningDigest"),
    },
    Endpoint {
        op: "issue.triage.list",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: Some("Vec<BacklogTriageSuggestion>"),
    },
    Endpoint {
        op: "issue.triage.suggest",
        module: "issue",
        about: &["issueId"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("BacklogTriageSuggestInput"),
        result: Some("BacklogTriageSuggestion"),
    },
    Endpoint {
        op: "issue.triage.confirm",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("BacklogTriageConfirmInput"),
        result: Some("AppliedIssue"),
    },
    Endpoint {
        op: "issue.triage.dismiss",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("BacklogTriageDismissInput"),
        result: None,
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    pub struct IssueConversationGet;
    impl Op for IssueConversationGet {
        const NAME: &'static str = "issue.conversation.get";
        type Input = t::IssueConversationGetInput;
        type Result = Option<String>;
    }
    /// To the issue's newest session, as the user: a comment is on the issue, not on one step. A closed issue is refused: reopen it.
    pub struct IssueCommentCreate;
    impl Op for IssueCommentCreate {
        const NAME: &'static str = "issue.comment.create";
        type Input = t::IssueCommentCreateInput;
        type Result = t::Applied;
    }
    pub struct IssueDiffGet;
    impl Op for IssueDiffGet {
        const NAME: &'static str = "issue.diff.get";
        type Input = t::IssueDiffGetInput;
        type Result = t::Changes;
    }
    /// One joined read of issues and their real sessions, including explicit missing records.
    pub struct IssueHistoryList;
    impl Op for IssueHistoryList {
        const NAME: &'static str = "issue.history.list";
        type Input = ();
        type Result = Vec<t::IssueHistory>;
    }
    /// The open issues by default, the newest first; the filter narrows them.
    pub struct IssueList;
    impl Op for IssueList {
        const NAME: &'static str = "issue.list";
        type Input = t::IssueFilter;
        type Result = Vec<t::Issue>;
    }
    /// A verdict on what was handed back; a pass only makes it ready, completing it is issue.status.update to done.
    pub struct IssueReview;
    impl Op for IssueReview {
        const NAME: &'static str = "issue.review";
        type Input = t::IssueReviewInput;
        type Result = t::Issue;
    }
    /// The issue becomes a parent issue and the split's issues its children, started at once.
    pub struct IssueSplit;
    impl Op for IssueSplit {
        const NAME: &'static str = "issue.split";
        type Input = t::IssueSplitInput;
        type Result = String;
    }
    pub struct IssueGet;
    impl Op for IssueGet {
        const NAME: &'static str = "issue.get";
        type Input = t::IssueGetInput;
        type Result = t::Issue;
    }
    pub struct IssueRunList;
    impl Op for IssueRunList {
        const NAME: &'static str = "issue.run.list";
        type Input = t::IssueRunListInput;
        type Result = Vec<t::Run>;
    }
    /// The issue's milestones, newest first, and what all its runs cost.
    pub struct IssueTimelineGet;
    impl Op for IssueTimelineGet {
        const NAME: &'static str = "issue.timeline.get";
        type Input = t::IssueTimelineGetInput;
        type Result = t::IssueTimeline;
    }
    pub struct IssueCreate;
    impl Op for IssueCreate {
        const NAME: &'static str = "issue.create";
        type Input = t::IssueRequest;
        type Result = t::AppliedIssue;
    }
    pub struct IssueUpdate;
    impl Op for IssueUpdate {
        const NAME: &'static str = "issue.update";
        type Input = t::IssueUpdateInput;
        type Result = t::AppliedIssue;
    }
    /// Lazily materializes or returns an issue's collaborative Block Doc body note.
    pub struct IssueBodyEnsure;
    impl Op for IssueBodyEnsure {
        const NAME: &'static str = "issue.body.ensure";
        type Input = t::IssueBodyEnsureInput;
        type Result = t::IssueBodyEnsureResult;
    }
    pub struct IssueDelete;
    impl Op for IssueDelete {
        const NAME: &'static str = "issue.delete";
        type Input = t::IssueDeleteInput;
        type Result = ();
    }
    /// What issue.delete would do, refused as it would be; nothing changes.
    pub struct IssuePreviewDelete;
    impl Op for IssuePreviewDelete {
        const NAME: &'static str = "issue.previewDelete";
        type Input = t::IssueDeleteInput;
        type Result = t::Preview;
    }
    /// Moving an issue is what it does, by where it stands: todo sends it out (or waits for room), or back from review is another round (the words are the findings.
    pub struct IssueStatusUpdate;
    impl Op for IssueStatusUpdate {
        const NAME: &'static str = "issue.status.update";
        type Input = t::IssueStatusUpdateInput;
        type Result = t::AppliedIssue;
    }
    /// What issue.status.update would do with the same body, refused as it would be; nothing changes.
    pub struct IssueStatusPreviewUpdate;
    impl Op for IssueStatusPreviewUpdate {
        const NAME: &'static str = "issue.status.previewUpdate";
        type Input = t::IssueStatusUpdateInput;
        type Result = t::Preview;
    }
    /// A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then leaves.
    pub struct IssueRefine;
    impl Op for IssueRefine {
        const NAME: &'static str = "issue.refine";
        type Input = t::IssueRefineInput;
        type Result = t::Issue;
    }
    /// Deterministic issue cycle-time and retro analytics for a time window.
    pub struct IssueRetroGet;
    impl Op for IssueRetroGet {
        const NAME: &'static str = "issue.retro.get";
        type Input = t::IssueRetroGetInput;
        type Result = t::IssueRetroReport;
    }
    /// Three-part morning digest combining overnight progress, repo health, and confirmable backlog triage.
    pub struct IssueDigestGet;
    impl Op for IssueDigestGet {
        const NAME: &'static str = "issue.digest.get";
        type Input = t::IssueDigestGetInput;
        type Result = t::MorningDigest;
    }
    /// Pending backlog triage suggestions awaiting explicit user confirmation.
    pub struct IssueTriageList;
    impl Op for IssueTriageList {
        const NAME: &'static str = "issue.triage.list";
        type Input = ();
        type Result = Vec<t::BacklogTriageSuggestion>;
    }
    /// Proposes a non-destructive triage suggestion for a backlog issue without overwriting its fields.
    pub struct IssueTriageSuggest;
    impl Op for IssueTriageSuggest {
        const NAME: &'static str = "issue.triage.suggest";
        type Input = t::BacklogTriageSuggestInput;
        type Result = t::BacklogTriageSuggestion;
    }
    /// Applies a pending backlog triage suggestion after explicit user click/confirmation.
    pub struct IssueTriageConfirm;
    impl Op for IssueTriageConfirm {
        const NAME: &'static str = "issue.triage.confirm";
        type Input = t::BacklogTriageConfirmInput;
        type Result = t::AppliedIssue;
    }
    /// Dismisses a pending backlog triage suggestion without modifying the issue.
    pub struct IssueTriageDismiss;
    impl Op for IssueTriageDismiss {
        const NAME: &'static str = "issue.triage.dismiss";
        type Input = t::BacklogTriageDismissInput;
        type Result = ();
    }
}
