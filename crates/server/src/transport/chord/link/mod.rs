//! Multiplexed Chord RPC and document watches over complete byte frames.
mod client;
mod session;
mod wire;
pub use client::{Client, ClientWatch};
pub use session::{Link, RemoteWatch};

use crate::transport::chord::watch::Document;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, OnceLock, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;
use wire::Frame;

pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct RpcError {
    pub code: String,
    pub message: String,
}
impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("link closed")]
    Closed,
    #[error("link heartbeat timed out")]
    Heartbeat,
    #[error("deadline exceeded")]
    Deadline,
    #[error("message exceeds maximum size")]
    TooLarge,
    #[error("invalid link frame: {0}")]
    Protocol(String),
    #[error("websocket transport: {0}")]
    Transport(String),
    #[error(transparent)]
    Rpc(#[from] RpcError),
}
impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Protocol(error.to_string())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub kind: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub expires_at_ms: i64,
}
fn is_zero(n: &i64) -> bool {
    *n == 0
}
impl Principal {
    pub fn new(kind: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            id: id.into(),
            session_id: String::new(),
            capabilities: vec![],
            expires_at_ms: 0,
        }
    }
    pub fn user_device(id: impl Into<String>) -> Self {
        Self::new("user_device", id)
    }
    pub fn validate(&self) -> Result<(), RpcError> {
        if self.kind.is_empty() || self.id.is_empty() {
            return Err(RpcError::new("unauthorized", "missing principal kind or id"));
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
        if self.expires_at_ms > 0 && now >= self.expires_at_ms as u128 {
            return Err(RpcError::new("unauthorized", "principal expired"));
        }
        Ok(())
    }
}

type Auth = Arc<dyn Fn(&Principal) -> Result<(), RpcError> + Send + Sync>;
type Handler = Arc<dyn Fn(Principal, Value) -> BoxFuture<'static, Result<Value, RpcError>> + Send + Sync>;
type Resolver = Arc<dyn Fn(&Principal, &str) -> Result<Option<Document>, RpcError> + Send + Sync>;
#[derive(Clone)]
pub struct Options {
    pub principal: Principal,
    pub authenticate: Option<Auth>,
    pub heartbeat: Duration,
    pub heartbeat_timeout: Duration,
    pub max_frame_bytes: usize,
    pub max_message_bytes: usize,
}
impl Options {
    pub fn new(principal: Principal) -> Self {
        Self {
            principal,
            authenticate: None,
            heartbeat: Duration::from_secs(15),
            heartbeat_timeout: Duration::from_secs(45),
            max_frame_bytes: MAX_FRAME_BYTES,
            max_message_bytes: MAX_MESSAGE_BYTES,
        }
    }
}

#[derive(Clone)]
pub struct Transport {
    tx: flume::Sender<Vec<u8>>,
    rx: flume::Receiver<Vec<u8>>,
    max_message: usize,
    cause: Arc<OnceLock<Error>>,
    stop: CancellationToken,
}
impl Transport {
    pub fn pipe(capacity: usize) -> (Self, Self) {
        Self::pipe_with_limit(capacity, usize::MAX)
    }
    pub(crate) fn pipe_with_limit(capacity: usize, max_message: usize) -> (Self, Self) {
        let (a_tx, a_rx) = flume::bounded(capacity.max(1));
        let (b_tx, b_rx) = flume::bounded(capacity.max(1));
        let stop = CancellationToken::new();
        let cause = Arc::new(OnceLock::new());
        (
            Self {
                tx: a_tx,
                rx: b_rx,
                max_message,
                cause: cause.clone(),
                stop: stop.clone(),
            },
            Self {
                tx: b_tx,
                rx: a_rx,
                max_message,
                cause,
                stop,
            },
        )
    }
    pub async fn send(&self, bytes: Vec<u8>) -> Result<(), Error> {
        if bytes.len() > self.max_message {
            return Err(Error::TooLarge);
        }
        tokio::select! { biased; _ = self.stop.cancelled()=>Err(self.error()), res=self.tx.send_async(bytes)=>res.map_err(|_|self.error()) }
    }
    pub async fn recv(&self) -> Result<Vec<u8>, Error> {
        tokio::select! { biased; v=self.rx.recv_async()=>v.map_err(|_|self.error()), _=self.stop.cancelled()=>Err(self.error()) }
    }
    fn error(&self) -> Error {
        self.cause.get().cloned().unwrap_or(Error::Closed)
    }
    pub(crate) fn fail(&self, error: Error) {
        let _ = self.cause.set(error);
        self.stop.cancel();
    }
    pub fn close(&self) {
        self.fail(Error::Closed);
    }
}

#[derive(Default)]
struct Routes {
    methods: HashMap<String, Handler>,
    watches: HashMap<String, Document>,
    resolve: Option<Resolver>,
}
#[derive(Default, Clone)]
pub struct Endpoint(Arc<RwLock<Routes>>);
impl Endpoint {
    pub fn handle<F, Fut>(&self, method: impl Into<String>, handler: F)
    where
        F: Fn(Principal, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, RpcError>> + Send + 'static,
    {
        self.0
            .write()
            .unwrap()
            .methods
            .insert(method.into(), Arc::new(move |p, v| Box::pin(handler(p, v))));
    }
    pub fn publish(&self, target: impl Into<String>, doc: Document) {
        self.0.write().unwrap().watches.insert(target.into(), doc);
    }
    pub fn resolve_watches(&self, resolve: impl Fn(&Principal, &str) -> Result<Option<Document>, RpcError> + Send + Sync + 'static) {
        self.0.write().unwrap().resolve = Some(Arc::new(resolve));
    }
    pub async fn connect(&self, transport: Transport, options: Options) -> Result<Link, Error> {
        let handshake = async {
            options.principal.validate()?;
            let send = async |f: Frame| transport.send(serde_json::to_vec(&f)?).await;
            send(Frame::Hello {
                principal: options.principal.clone(),
            })
            .await?;
            let mut ack = false;
            let mut peer = None;
            loop {
                let bytes = transport.recv().await?;
                if bytes.len() > options.max_message_bytes {
                    return Err(Error::TooLarge);
                }
                match serde_json::from_slice(&bytes)? {
                    Frame::Hello { principal } => {
                        let auth = principal
                            .validate()
                            .and_then(|()| options.authenticate.as_ref().map_or(Ok(()), |check| check(&principal)));
                        match auth {
                            Ok(()) => {
                                send(Frame::HelloAck { error: None }).await?;
                                peer = Some(principal);
                            }
                            Err(error) => {
                                send(Frame::HelloAck { error: Some(error.clone()) }).await?;
                                return Err(error.into());
                            }
                        }
                    }
                    Frame::HelloAck { error: None } => ack = true,
                    Frame::HelloAck { error: Some(e) } => return Err(e.into()),
                    _ => return Err(Error::Protocol("unexpected frame during handshake".into())),
                }
                if ack && let Some(p) = peer.take() {
                    return Ok(p);
                }
            }
        };
        let peer = match handshake.await {
            Ok(p) => p,
            Err(e) => {
                transport.fail(e.clone());
                return Err(e);
            }
        };
        Ok(session::start(self.clone(), peer, transport, options))
    }
}
