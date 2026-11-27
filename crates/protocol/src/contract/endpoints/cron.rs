use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "cron.create",
        module: "cron",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("CronRequest"),
        result: Some("Cron"),
    },
    Endpoint {
        op: "cron.list",
        module: "cron",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: Some("Vec<Cron>"),
    },
    Endpoint {
        op: "cron.update",
        module: "cron",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("CronUpdateInput"),
        result: None,
    },
    Endpoint {
        op: "cron.delete",
        module: "cron",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: Some("cron.previewDelete"),
        input: Some("CronDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "cron.previewDelete",
        module: "cron",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("CronDeleteInput"),
        result: Some("Preview"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    pub struct CronCreate;
    impl Op for CronCreate {
        const NAME: &'static str = "cron.create";
        type Input = t::CronRequest;
        type Result = t::Cron;
    }
    pub struct CronList;
    impl Op for CronList {
        const NAME: &'static str = "cron.list";
        type Input = ();
        type Result = Vec<t::Cron>;
    }
    /// Only what the body gives changes.
    pub struct CronUpdate;
    impl Op for CronUpdate {
        const NAME: &'static str = "cron.update";
        type Input = t::CronUpdateInput;
        type Result = ();
    }
    pub struct CronDelete;
    impl Op for CronDelete {
        const NAME: &'static str = "cron.delete";
        type Input = t::CronDeleteInput;
        type Result = ();
    }
    /// What delete would do, refused as it would be; nothing changes.
    pub struct CronPreviewDelete;
    impl Op for CronPreviewDelete {
        const NAME: &'static str = "cron.previewDelete";
        type Input = t::CronDeleteInput;
        type Result = t::Preview;
    }
}
