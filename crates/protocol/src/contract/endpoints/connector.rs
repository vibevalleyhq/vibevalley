use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "connector.login",
        module: "connector",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ConnectorLoginInput"),
        result: Some("ConnectorStatus"),
    },
    Endpoint {
        op: "connector.verify",
        module: "connector",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ConnectorVerifyInput"),
        result: Some("ConnectorStatus"),
    },
    Endpoint {
        op: "connector.logout",
        module: "connector",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ConnectorLogoutInput"),
        result: Some("ConnectorStatus"),
    },
    Endpoint {
        op: "connector.channel.set",
        module: "connector",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ConnectorChannelSetInput"),
        result: Some("ConnectorStatus"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    pub struct ConnectorLogin;
    impl Op for ConnectorLogin {
        const NAME: &'static str = "connector.login";
        type Input = t::ConnectorLoginInput;
        type Result = t::ConnectorStatus;
    }
    pub struct ConnectorVerify;
    impl Op for ConnectorVerify {
        const NAME: &'static str = "connector.verify";
        type Input = t::ConnectorVerifyInput;
        type Result = t::ConnectorStatus;
    }
    pub struct ConnectorLogout;
    impl Op for ConnectorLogout {
        const NAME: &'static str = "connector.logout";
        type Input = t::ConnectorLogoutInput;
        type Result = t::ConnectorStatus;
    }
    pub struct ConnectorChannelSet;
    impl Op for ConnectorChannelSet {
        const NAME: &'static str = "connector.channel.set";
        type Input = t::ConnectorChannelSetInput;
        type Result = t::ConnectorStatus;
    }
}
