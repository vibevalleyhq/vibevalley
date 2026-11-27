use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[Endpoint {
    op: "voice.moss.verify",
    module: "voice",
    about: &[],
    can: &[Caller::User],
    dry_run: None,
    input: None,
    result: Some("Validation"),
}];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    /// Whether MOSS Live takes the key: a session is attached and closed again, nothing is said.
    pub struct VoiceMossVerify;
    impl Op for VoiceMossVerify {
        const NAME: &'static str = "voice.moss.verify";
        type Input = ();
        type Result = t::Validation;
    }
}
