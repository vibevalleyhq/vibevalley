//! The response envelope and business codes: `packages/protocol/src/endpoint.ts`.
//! Success is `{ bizCode: 0, message, data? }`; failure is
//! `{ bizCode, message, error? }` with a six-digit code.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_with::skip_serializing_none;

macro_rules! biz_codes {
    ($($name:ident = $code:literal => $status:literal, $kind:ident, $retry:literal;)*) => {
        /// `BizCode`: the six-digit error codes (0 is success).
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum BizCode {
            $($name,)*
        }

        impl BizCode {
            pub const ALL: &'static [BizCode] = &[$(BizCode::$name,)*];

            pub fn code(self) -> u32 {
                match self { $(BizCode::$name => $code,)* }
            }

            pub fn from_code(code: u32) -> Option<BizCode> {
                match code { $($code => Some(BizCode::$name),)* _ => None }
            }

            /// `bizCodeMeta`: the HTTP status, kind and retryability.
            pub fn meta(self) -> BizCodeMeta {
                match self {
                    $(BizCode::$name => BizCodeMeta { status: $status, kind: ApiErrorKind::$kind, retryable: $retry },)*
                }
            }

            pub fn name(self) -> &'static str {
                match self { $(BizCode::$name => stringify!($name),)* }
            }
        }
    };
}

biz_codes! {
    InvalidInput = 100001 => 400, InvalidInput, false;
    PayloadTooLarge = 100002 => 413, InvalidInput, false;
    UnsupportedMediaType = 100003 => 415, InvalidInput, false;
    MethodNotAllowed = 100004 => 405, InvalidInput, false;
    RouteNotFound = 100005 => 404, Missing, false;
    RequestKeyTooLong = 100006 => 409, Refused, false;
    InternalError = 100007 => 500, InternalError, true;
    BadGateway = 100008 => 502, BadGateway, true;
    ServiceUnavailable = 100009 => 503, ServiceUnavailable, true;
    NotFound = 100010 => 404, Missing, false;
    Refused = 100011 => 409, Refused, false;
    Unauthorized = 200001 => 401, Unauthorized, false;
    Forbidden = 200002 => 403, Forbidden, false;
    AuthRefused = 200003 => 403, Forbidden, false;
    UserNotFound = 200004 => 404, Missing, false;
    LanForbidden = 200005 => 403, Forbidden, false;
    LanUnavailable = 200006 => 503, ServiceUnavailable, true;
    IssueNotFound = 300001 => 404, Missing, false;
    IssueRefused = 300002 => 409, Refused, false;
    RepoNotFound = 300003 => 404, Missing, false;
    RepoRefused = 300004 => 409, Refused, false;
    SessionNotFound = 400001 => 404, Missing, false;
    SessionRefused = 400002 => 409, Refused, false;
    AgentNotFound = 400003 => 404, Missing, false;
    AgentRefused = 400004 => 409, Refused, false;
    RuntimeNotFound = 400005 => 404, Missing, false;
    RuntimeRefused = 400006 => 409, Refused, false;
    OrchestratorRefused = 400007 => 409, Refused, false;
    OrchestratorNotFound = 400008 => 404, Missing, false;
    ChannelNotFound = 500001 => 404, Missing, false;
    ChannelRefused = 500002 => 409, Refused, false;
    ConnectorRefused = 500003 => 409, Refused, false;
    CronNotFound = 500004 => 404, Missing, false;
    CronRefused = 500005 => 409, Refused, false;
    GameRefused = 500006 => 409, Refused, false;
    ArtifactNotFound = 600001 => 404, Missing, false;
    ArtifactRefused = 600002 => 409, Refused, false;
    MemoryNotFound = 600005 => 404, Missing, false;
    MemoryRefused = 600006 => 409, Refused, false;
    LibraryNotFound = 600007 => 404, Missing, false;
    LibraryRefused = 600008 => 409, Refused, false;
    AttachmentRefused = 600009 => 409, Refused, false;
    VoiceUnavailable = 700001 => 503, VoiceUnavailable, false;
    VoiceCallFailed = 700002 => 502, VoiceCallFailed, true;
    MediaNotFound = 700004 => 404, Missing, false;
    MediaRefused = 700005 => 409, Refused, false;
    ProviderRefused = 700006 => 409, Refused, false;
    SettingRefused = 700007 => 409, Refused, false;
}

impl Serialize for BizCode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u32(self.code())
    }
}

impl<'de> Deserialize<'de> for BizCode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let code = u32::deserialize(d)?;
        BizCode::from_code(code).ok_or_else(|| serde::de::Error::custom(format!("unknown bizCode {code}")))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ApiErrorKind {
    InvalidInput,
    Unauthorized,
    Forbidden,
    Missing,
    Refused,
    VoiceUnavailable,
    VoiceCallFailed,
    InternalError,
    BadGateway,
    ServiceUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BizCodeMeta {
    pub status: u16,
    pub kind: ApiErrorKind,
    pub retryable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceFix {
    Models,
    Moss,
}

/// What to do about a failure: words to say and commands to run.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Next {
    pub say: String,
    pub run: Option<Vec<String>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ApiErrorDetail {
    pub next: Option<Vec<Next>>,
    pub settings: Option<VoiceFix>,
}

/// What a route refuses with (`ApiError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub biz_code: BizCode,
    pub message: String,
    pub detail: ApiErrorDetail,
}

impl ApiError {
    pub fn new(biz_code: BizCode, message: impl Into<String>) -> ApiError {
        ApiError {
            biz_code,
            message: message.into(),
            detail: ApiErrorDetail::default(),
        }
    }

    pub fn with_next(mut self, next: Vec<Next>) -> ApiError {
        self.detail.next = Some(next);
        self
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}): {}", self.biz_code.name(), self.biz_code.code(), self.message)
    }
}

impl std::error::Error for ApiError {}

/// Every reply on the wire. `data` is absent for a void success, `error`
/// absent unless the failure carries remediation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub biz_code: u32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiErrorDetail>,
}

impl Envelope {
    pub fn ok(data: Value) -> Envelope {
        Envelope {
            biz_code: 0,
            message: "ok".into(),
            data: Some(data),
            error: None,
        }
    }

    pub fn void() -> Envelope {
        Envelope {
            biz_code: 0,
            message: "ok".into(),
            data: None,
            error: None,
        }
    }

    pub fn failure(e: &ApiError) -> Envelope {
        let detail = (e.detail != ApiErrorDetail::default()).then(|| e.detail.clone());
        Envelope {
            biz_code: e.biz_code.code(),
            message: e.message.clone(),
            data: None,
            error: detail,
        }
    }

    pub fn of<T: Serialize>(result: Result<T, ApiError>) -> Envelope {
        match result {
            Ok(data) => match serde_json::to_value(data) {
                Ok(Value::Null) => Envelope::void(),
                Ok(v) => Envelope::ok(v),
                Err(e) => Envelope::failure(&ApiError::new(BizCode::InternalError, e.to_string())),
            },
            Err(e) => Envelope::failure(&e),
        }
    }

    /// The failure this envelope says, if it is one.
    pub fn error(&self) -> Option<ApiError> {
        if self.biz_code == 0 {
            return None;
        }
        Some(ApiError {
            biz_code: BizCode::from_code(self.biz_code).unwrap_or(BizCode::InternalError),
            message: self.message.clone(),
            detail: self.error.clone().unwrap_or_default(),
        })
    }
}
