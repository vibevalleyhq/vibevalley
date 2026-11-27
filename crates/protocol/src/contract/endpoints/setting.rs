use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "setting.get",
        module: "setting",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("SettingsStatus"),
    },
    Endpoint {
        op: "setting.validate",
        module: "setting",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SettingsUpdate"),
        result: Some("Validation"),
    },
    Endpoint {
        op: "setting.update",
        module: "setting",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("SettingsUpdate"),
        result: Some("SettingsStatus"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    pub struct SettingGet;
    impl Op for SettingGet {
        const NAME: &'static str = "setting.get";
        type Input = ();
        type Result = t::SettingsStatus;
    }
    /// The first thing Save would refuse in these settings, without saving them.
    pub struct SettingValidate;
    impl Op for SettingValidate {
        const NAME: &'static str = "setting.validate";
        type Input = t::SettingsUpdate;
        type Result = t::Validation;
    }
    pub struct SettingUpdate;
    impl Op for SettingUpdate {
        const NAME: &'static str = "setting.update";
        type Input = t::SettingsUpdate;
        type Result = t::SettingsStatus;
    }
}
