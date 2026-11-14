//! Hand-written pieces the generated types use: JavaScript numbers, literal
//! `true`/`false` tags, and the endpoint and subscription descriptions.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A JavaScript number: written as an integer when it is one (`1200`, not
/// `1200.0`), as `JSON.stringify` does.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Default)]
pub struct JsNumber(pub f64);

impl JsNumber {
    pub fn get(self) -> f64 {
        self.0
    }
}

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let v = self.0;
        if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
            s.serialize_i64(v as i64)
        } else {
            s.serialize_f64(v)
        }
    }
}

impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        f64::deserialize(d).map(JsNumber)
    }
}

impl ts_rs::TS for JsNumber {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn name(_: &ts_rs::Config) -> String {
        "number".to_owned()
    }

    fn inline(cfg: &ts_rs::Config) -> String {
        Self::name(cfg)
    }
}

impl From<f64> for JsNumber {
    fn from(v: f64) -> Self {
        JsNumber(v)
    }
}

impl From<i64> for JsNumber {
    fn from(v: i64) -> Self {
        JsNumber(v as f64)
    }
}

impl From<u32> for JsNumber {
    fn from(v: u32) -> Self {
        JsNumber(v.into())
    }
}

macro_rules! literal_bool {
    ($name:ident, $value:literal) => {
        #[doc = concat!("The literal `", stringify!($value), "`: a tag that only takes that value.")]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
        pub struct $name;

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_bool($value)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                if bool::deserialize(d)? == $value {
                    Ok($name)
                } else {
                    Err(serde::de::Error::custom(concat!("expected ", stringify!($value))))
                }
            }
        }

        impl ts_rs::TS for $name {
            type WithoutGenerics = Self;
            type OptionInnerType = Self;

            fn name(_: &ts_rs::Config) -> String {
                stringify!($value).to_owned()
            }

            fn inline(cfg: &ts_rs::Config) -> String {
                Self::name(cfg)
            }
        }
    };
}

literal_bool!(LitTrue, true);
literal_bool!(LitFalse, false);

/// Who may call an endpoint (`Caller` in `endpoint.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Caller {
    User,
    Remote,
    Orchestrator,
    Session,
}

impl Caller {
    pub fn as_str(self) -> &'static str {
        match self {
            Caller::User => "user",
            Caller::Remote => "remote",
            Caller::Orchestrator => "orchestrator",
            Caller::Session => "session",
        }
    }
}

/// One row of the endpoint table (`Endpoint` in `endpoint.ts`), with its
/// input and result named by their Rust types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Endpoint {
    pub op: &'static str,
    /// The `packages/protocol/src/<module>` it is declared in.
    pub module: &'static str,
    /// The input's fields that say what it is about.
    pub about: &'static [&'static str],
    pub can: &'static [Caller],
    /// The op that previews this one, for those that cannot be taken back.
    pub dry_run: Option<&'static str>,
    pub input: Option<&'static str>,
    pub result: Option<&'static str>,
}

/// An endpoint as a type. `Input` is `()` when it takes nothing, `Result`
/// is `()` when it answers with the void envelope.
pub trait Op {
    const NAME: &'static str;
    type Input: DeserializeOwned + Serialize;
    type Result: DeserializeOwned + Serialize;
}

/// One of `rpc.ts`'s subscriptions as a type.
pub trait Subscription {
    const NAME: &'static str;
    type Payload: DeserializeOwned + Serialize;
    type Event: DeserializeOwned + Serialize;
}

/// The endpoint named `op`.
pub fn endpoint(op: &str) -> Option<&'static Endpoint> {
    crate::contract::ENDPOINTS.iter().chain(crate::NATIVE_ENDPOINTS).find(|e| e.op == op)
}
