use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "runtime.list",
        module: "runtime",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<RuntimeInfo>"),
    },
    Endpoint {
        op: "runtime.refresh",
        module: "runtime",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RuntimeRefreshInput"),
        result: Some("RuntimeInfo"),
    },
    Endpoint {
        op: "runtime.setting.update",
        module: "runtime",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("RuntimeSettingUpdateInput"),
        result: Some("RuntimeInfo"),
    },
    Endpoint {
        op: "runtime.mcp.list",
        module: "runtime",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("McpListInput"),
        result: Some("McpListResult"),
    },
    Endpoint {
        op: "runtime.mcp.install",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("McpInstallInput"),
        result: Some("McpHostInfo"),
    },
    Endpoint {
        op: "runtime.mcp.uninstall",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("McpUninstallInput"),
        result: Some("McpHostInfo"),
    },
    Endpoint {
        op: "runtime.mcpServer.list",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("McpServerListInput"),
        result: Some("McpServerListResult"),
    },
    Endpoint {
        op: "runtime.mcpServer.save",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("McpServerSaveInput"),
        result: Some("McpServerListResult"),
    },
    Endpoint {
        op: "runtime.mcpServer.toggle",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("McpServerToggleInput"),
        result: Some("McpServerListResult"),
    },
    Endpoint {
        op: "runtime.mcpServer.remove",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("McpServerRemoveInput"),
        result: Some("McpServerListResult"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    pub struct RuntimeList;
    impl Op for RuntimeList {
        const NAME: &'static str = "runtime.list";
        type Input = ();
        type Result = Vec<t::RuntimeInfo>;
    }
    pub struct RuntimeRefresh;
    impl Op for RuntimeRefresh {
        const NAME: &'static str = "runtime.refresh";
        type Input = t::RuntimeRefreshInput;
        type Result = t::RuntimeInfo;
    }
    pub struct RuntimeSettingUpdate;
    impl Op for RuntimeSettingUpdate {
        const NAME: &'static str = "runtime.setting.update";
        type Input = t::RuntimeSettingUpdateInput;
        type Result = t::RuntimeInfo;
    }
    pub struct RuntimeMcpList;
    impl Op for RuntimeMcpList {
        const NAME: &'static str = "runtime.mcp.list";
        type Input = t::McpListInput;
        type Result = t::McpListResult;
    }
    pub struct RuntimeMcpInstall;
    impl Op for RuntimeMcpInstall {
        const NAME: &'static str = "runtime.mcp.install";
        type Input = t::McpInstallInput;
        type Result = t::McpHostInfo;
    }
    pub struct RuntimeMcpUninstall;
    impl Op for RuntimeMcpUninstall {
        const NAME: &'static str = "runtime.mcp.uninstall";
        type Input = t::McpUninstallInput;
        type Result = t::McpHostInfo;
    }
    pub struct RuntimeMcpServerList;
    impl Op for RuntimeMcpServerList {
        const NAME: &'static str = "runtime.mcpServer.list";
        type Input = t::McpServerListInput;
        type Result = t::McpServerListResult;
    }
    pub struct RuntimeMcpServerSave;
    impl Op for RuntimeMcpServerSave {
        const NAME: &'static str = "runtime.mcpServer.save";
        type Input = t::McpServerSaveInput;
        type Result = t::McpServerListResult;
    }
    pub struct RuntimeMcpServerToggle;
    impl Op for RuntimeMcpServerToggle {
        const NAME: &'static str = "runtime.mcpServer.toggle";
        type Input = t::McpServerToggleInput;
        type Result = t::McpServerListResult;
    }
    pub struct RuntimeMcpServerRemove;
    impl Op for RuntimeMcpServerRemove {
        const NAME: &'static str = "runtime.mcpServer.remove";
        type Input = t::McpServerRemoveInput;
        type Result = t::McpServerListResult;
    }
}
