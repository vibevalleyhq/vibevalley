use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "repo.pr.submit",
        module: "repo",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("SubmitBranch"),
        result: Some("BranchPublication"),
    },
    Endpoint {
        op: "github.get",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("GitHubStatus"),
    },
    Endpoint {
        op: "github.refresh",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("GitHubStatus"),
    },
    Endpoint {
        op: "repo.list",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: Some("Vec<RepoSummary>"),
    },
    Endpoint {
        op: "repo.validate",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NewRepo"),
        result: Some("Validation"),
    },
    Endpoint {
        op: "repo.create",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NewRepo"),
        result: Some("RepoSummary"),
    },
    Endpoint {
        op: "repo.mount",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MountRepo"),
        result: Some("RepoSummary"),
    },
    Endpoint {
        op: "repo.unmount",
        module: "repo",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RepoUnmountInput"),
        result: None,
    },
    Endpoint {
        op: "repo.language.list",
        module: "repo",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RepoLanguageListInput"),
        result: Some("RepoLanguages"),
    },
    Endpoint {
        op: "repo.template.list",
        module: "repo",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RepoTemplateListInput"),
        result: Some("RepoTemplates"),
    },
    Endpoint {
        op: "repo.activity.get",
        module: "repo",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RepoActivityGetInput"),
        result: Some("RepoActivity"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    pub struct RepoPrSubmit;
    impl Op for RepoPrSubmit {
        const NAME: &'static str = "repo.pr.submit";
        type Input = t::SubmitBranch;
        type Result = t::BranchPublication;
    }
    pub struct GithubGet;
    impl Op for GithubGet {
        const NAME: &'static str = "github.get";
        type Input = ();
        type Result = t::GitHubStatus;
    }
    pub struct GithubRefresh;
    impl Op for GithubRefresh {
        const NAME: &'static str = "github.refresh";
        type Input = ();
        type Result = t::GitHubStatus;
    }
    pub struct RepoList;
    impl Op for RepoList {
        const NAME: &'static str = "repo.list";
        type Input = ();
        type Result = Vec<t::RepoSummary>;
    }
    /// The first thing Create would refuse in this repo, without making it.
    pub struct RepoValidate;
    impl Op for RepoValidate {
        const NAME: &'static str = "repo.validate";
        type Input = t::NewRepo;
        type Result = t::Validation;
    }
    pub struct RepoCreate;
    impl Op for RepoCreate {
        const NAME: &'static str = "repo.create";
        type Input = t::NewRepo;
        type Result = t::RepoSummary;
    }
    pub struct RepoMount;
    impl Op for RepoMount {
        const NAME: &'static str = "repo.mount";
        type Input = t::MountRepo;
        type Result = t::RepoSummary;
    }
    pub struct RepoUnmount;
    impl Op for RepoUnmount {
        const NAME: &'static str = "repo.unmount";
        type Input = t::RepoUnmountInput;
        type Result = ();
    }
    pub struct RepoLanguageList;
    impl Op for RepoLanguageList {
        const NAME: &'static str = "repo.language.list";
        type Input = t::RepoLanguageListInput;
        type Result = t::RepoLanguages;
    }
    pub struct RepoTemplateList;
    impl Op for RepoTemplateList {
        const NAME: &'static str = "repo.template.list";
        type Input = t::RepoTemplateListInput;
        type Result = t::RepoTemplates;
    }
    pub struct RepoActivityGet;
    impl Op for RepoActivityGet {
        const NAME: &'static str = "repo.activity.get";
        type Input = t::RepoActivityGetInput;
        type Result = t::RepoActivity;
    }
}
