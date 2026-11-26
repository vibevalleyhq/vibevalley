use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode};

use crate::context::error::{LookIn, missing};
use crate::runtime::RuntimeError;

pub(super) fn helper_ref(id: &str) -> ApiError {
    missing(t("server.helperRef", &[("id", id.into())]), LookIn::Session)
}

pub(crate) fn session_error(e: RuntimeError) -> ApiError {
    match e {
        RuntimeError::Api(e) => e,
        RuntimeError::Agent(err) => match err {
            vibevalley_runtime::oar::AgentError::UnknownRuntime(_)
            | vibevalley_runtime::oar::AgentError::NotAvailable(_)
            | vibevalley_runtime::oar::AgentError::Unsupported { .. } => ApiError::new(BizCode::RuntimeRefused, err.to_string()),
            vibevalley_runtime::oar::AgentError::Rejected(_)
            | vibevalley_runtime::oar::AgentError::Io(_)
            | vibevalley_runtime::oar::AgentError::Protocol(_) => ApiError::new(BizCode::SessionRefused, err.to_string()),
        },
        RuntimeError::Store(e) => ApiError::new(BizCode::InternalError, e.to_string()),
        other => ApiError::new(BizCode::SessionRefused, other.to_string()),
    }
}
