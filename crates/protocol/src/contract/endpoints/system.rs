use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "attachment.create",
        module: "attachment",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("AttachmentUpload"),
        result: Some("Attachment"),
    },
    Endpoint {
        op: "attachment.importPath",
        module: "attachment",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AttachmentImportPathInput"),
        result: Some("Attachment"),
    },
    Endpoint {
        op: "server.health.get",
        module: "core",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Health"),
    },
    Endpoint {
        op: "debug.snapshot",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("DebugSnapshot"),
    },
    Endpoint {
        op: "debug.timeline.list",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("DebugTimelineQuery"),
        result: Some("DebugTimelinePage"),
    },
    Endpoint {
        op: "debug.timeline.clear",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: None,
    },
    Endpoint {
        op: "debug.trajectory.list",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("Vec<DebugTrajectorySummary>"),
    },
    Endpoint {
        op: "debug.trajectory.get",
        module: "debug",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("DebugTrajectoryGetRequest"),
        result: Some("DebugTrajectoryDetail"),
    },
    Endpoint {
        op: "debug.trajectory.export",
        module: "debug",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("DebugTrajectoryExportRequest"),
        result: Some("DebugTrajectoryExportResult"),
    },
    Endpoint {
        op: "debug.override.set",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("DebugOverrideConfig"),
        result: Some("DebugOverrideConfig"),
    },
    Endpoint {
        op: "debug.bundle.export",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("DebugBundleResult"),
    },
    Endpoint {
        op: "remote.status",
        module: "remote",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("RemoteStatus"),
    },
    Endpoint {
        op: "remote.enable",
        module: "remote",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("RemoteEnableRequest"),
        result: Some("RemoteStatus"),
    },
    Endpoint {
        op: "remote.disable",
        module: "remote",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("RemoteStatus"),
    },
    Endpoint {
        op: "remote.pair.create",
        module: "remote",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("RemotePairCode"),
    },
    Endpoint {
        op: "remote.pair.exchange",
        module: "remote",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RemotePairExchangeRequest"),
        result: Some("RemotePairExchangeResult"),
    },
    Endpoint {
        op: "remote.device.revoke",
        module: "remote",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("RemoteDeviceRevokeRequest"),
        result: None,
    },
    Endpoint {
        op: "remote.whoami",
        module: "remote",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("RemoteWhoami"),
    },
    Endpoint {
        op: "machine.list",
        module: "machine",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<MachineInfo>"),
    },
    Endpoint {
        op: "game.shop.list",
        module: "game",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("FarmShopView"),
    },
    Endpoint {
        op: "game.shop.buy",
        module: "game",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ShopPurchaseRequest"),
        result: Some("FarmShopView"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    /// Kept once by its bytes: the same file again is the same attachment.
    pub struct AttachmentCreate;
    impl Op for AttachmentCreate {
        const NAME: &'static str = "attachment.create";
        type Input = t::AttachmentUpload;
        type Result = t::Attachment;
    }
    /// Local regular file imported directly into CAS without base64 framing (`Caller::User` only).
    pub struct AttachmentImportPath;
    impl Op for AttachmentImportPath {
        const NAME: &'static str = "attachment.importPath";
        type Input = t::AttachmentImportPathInput;
        type Result = t::Attachment;
    }
    pub struct ServerHealthGet;
    impl Op for ServerHealthGet {
        const NAME: &'static str = "server.health.get";
        type Input = ();
        type Result = t::Health;
    }
    pub struct DebugSnapshot;
    impl Op for DebugSnapshot {
        const NAME: &'static str = "debug.snapshot";
        type Input = ();
        type Result = t::DebugSnapshot;
    }
    pub struct DebugTimelineList;
    impl Op for DebugTimelineList {
        const NAME: &'static str = "debug.timeline.list";
        type Input = t::DebugTimelineQuery;
        type Result = t::DebugTimelinePage;
    }
    pub struct DebugTimelineClear;
    impl Op for DebugTimelineClear {
        const NAME: &'static str = "debug.timeline.clear";
        type Input = ();
        type Result = ();
    }
    pub struct DebugTrajectoryList;
    impl Op for DebugTrajectoryList {
        const NAME: &'static str = "debug.trajectory.list";
        type Input = ();
        type Result = Vec<t::DebugTrajectorySummary>;
    }
    pub struct DebugTrajectoryGet;
    impl Op for DebugTrajectoryGet {
        const NAME: &'static str = "debug.trajectory.get";
        type Input = t::DebugTrajectoryGetRequest;
        type Result = t::DebugTrajectoryDetail;
    }
    pub struct DebugTrajectoryExport;
    impl Op for DebugTrajectoryExport {
        const NAME: &'static str = "debug.trajectory.export";
        type Input = t::DebugTrajectoryExportRequest;
        type Result = t::DebugTrajectoryExportResult;
    }
    pub struct DebugOverrideSet;
    impl Op for DebugOverrideSet {
        const NAME: &'static str = "debug.override.set";
        type Input = t::DebugOverrideConfig;
        type Result = t::DebugOverrideConfig;
    }
    pub struct DebugBundleExport;
    impl Op for DebugBundleExport {
        const NAME: &'static str = "debug.bundle.export";
        type Input = ();
        type Result = t::DebugBundleResult;
    }
    pub struct RemoteStatus;
    impl Op for RemoteStatus {
        const NAME: &'static str = "remote.status";
        type Input = ();
        type Result = t::RemoteStatus;
    }
    pub struct RemoteEnable;
    impl Op for RemoteEnable {
        const NAME: &'static str = "remote.enable";
        type Input = t::RemoteEnableRequest;
        type Result = t::RemoteStatus;
    }
    pub struct RemoteDisable;
    impl Op for RemoteDisable {
        const NAME: &'static str = "remote.disable";
        type Input = ();
        type Result = t::RemoteStatus;
    }
    pub struct RemotePairCreate;
    impl Op for RemotePairCreate {
        const NAME: &'static str = "remote.pair.create";
        type Input = ();
        type Result = t::RemotePairCode;
    }
    pub struct RemotePairExchange;
    impl Op for RemotePairExchange {
        const NAME: &'static str = "remote.pair.exchange";
        type Input = t::RemotePairExchangeRequest;
        type Result = t::RemotePairExchangeResult;
    }
    pub struct RemoteDeviceRevoke;
    impl Op for RemoteDeviceRevoke {
        const NAME: &'static str = "remote.device.revoke";
        type Input = t::RemoteDeviceRevokeRequest;
        type Result = ();
    }
    pub struct RemoteWhoami;
    impl Op for RemoteWhoami {
        const NAME: &'static str = "remote.whoami";
        type Input = ();
        type Result = t::RemoteWhoami;
    }
    pub struct MachineList;
    impl Op for MachineList {
        const NAME: &'static str = "machine.list";
        type Input = ();
        type Result = Vec<t::MachineInfo>;
    }
    pub struct GameShopList;
    impl Op for GameShopList {
        const NAME: &'static str = "game.shop.list";
        type Input = ();
        type Result = t::FarmShopView;
    }
    pub struct GameShopBuy;
    impl Op for GameShopBuy {
        const NAME: &'static str = "game.shop.buy";
        type Input = t::ShopPurchaseRequest;
        type Result = t::FarmShopView;
    }
}
