use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "provider.get",
        module: "provider",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("ProviderStatus"),
    },
    Endpoint {
        op: "provider.update",
        module: "provider",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ProviderUpdate"),
        result: Some("ProviderStatus"),
    },
    Endpoint {
        op: "provider.verify",
        module: "provider",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ProviderVerifyRequest"),
        result: Some("ProviderStatus"),
    },
    Endpoint {
        op: "provider.voice.list",
        module: "provider",
        about: &["connection"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ProviderVoiceRequest"),
        result: Some("ProviderVoiceListing"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    pub struct ProviderGet;
    impl Op for ProviderGet {
        const NAME: &'static str = "provider.get";
        type Input = ();
        type Result = t::ProviderStatus;
    }
    pub struct ProviderUpdate;
    impl Op for ProviderUpdate {
        const NAME: &'static str = "provider.update";
        type Input = t::ProviderUpdate;
        type Result = t::ProviderStatus;
    }
    pub struct ProviderVerify;
    impl Op for ProviderVerify {
        const NAME: &'static str = "provider.verify";
        type Input = t::ProviderVerifyRequest;
        type Result = t::ProviderStatus;
    }
    pub struct ProviderVoiceList;
    impl Op for ProviderVoiceList {
        const NAME: &'static str = "provider.voice.list";
        type Input = t::ProviderVoiceRequest;
        type Result = t::ProviderVoiceListing;
    }
}
