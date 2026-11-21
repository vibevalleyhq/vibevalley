//! RFC 6455 data messages carrying Chord frames.
use crate::transport::chord::link::{Error, MAX_MESSAGE_BYTES, Transport};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        handshake::{client::Response, server::Callback},
        protocol::WebSocketConfig,
    },
};

fn config(limit: usize) -> WebSocketConfig {
    WebSocketConfig::default().max_frame_size(Some(limit)).max_message_size(Some(limit))
}

pub async fn dial(request: impl IntoClientRequest + Unpin) -> Result<(Transport, Response), Error> {
    dial_with(request, MAX_MESSAGE_BYTES, None, None).await
}

pub async fn dial_with(
    request: impl IntoClientRequest + Unpin,
    limit: usize,
    timeout: Option<Duration>,
    connector: Option<tokio_tungstenite::Connector>,
) -> Result<(Transport, Response), Error> {
    let start = tokio_tungstenite::connect_async_tls_with_config(request, Some(config(limit)), false, connector);
    let (socket, response) = match timeout {
        Some(t) => tokio::time::timeout(t, start).await.map_err(|_| Error::Deadline)?,
        None => start.await,
    }
    .map_err(|e| Error::Transport(e.to_string()))?;
    Ok((from_websocket(socket, limit), response))
}

pub async fn accept<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(stream: S) -> Result<Transport, Error> {
    accept_with(stream, tokio_tungstenite::tungstenite::handshake::server::NoCallback, MAX_MESSAGE_BYTES).await
}

pub async fn accept_with<S, C>(stream: S, callback: C, limit: usize) -> Result<Transport, Error>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: Callback + Unpin,
{
    let socket = tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(config(limit)))
        .await
        .map_err(|e| Error::Transport(e.to_string()))?;
    Ok(from_websocket(socket, limit))
}

pub fn from_websocket<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(socket: WebSocketStream<S>, limit: usize) -> Transport {
    let (inner, outer) = Transport::pipe_with_limit(8, limit);
    let (mut sink, mut stream) = socket.split();
    tokio::spawn(async move {
        let reads = async {
            while let Some(message) = stream.next().await {
                let message = message.map_err(error_of)?;
                match message {
                    Message::Text(_) | Message::Binary(_) => {
                        let data = message.into_data();
                        if data.len() > limit {
                            return Err(Error::TooLarge);
                        }
                        outer.send(data.to_vec()).await?;
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            Ok(())
        };
        let writes = async {
            loop {
                let bytes = outer.recv().await?;
                if bytes.len() > limit {
                    return Err(Error::TooLarge);
                }
                let text = String::from_utf8(bytes).map_err(|e| Error::Protocol(e.to_string()))?;
                sink.send(Message::Text(text.into())).await.map_err(error_of)?;
            }
        };
        let result: Result<(), Error> = tokio::select! {r=reads=>r,r=writes=>r};
        outer.fail(result.err().unwrap_or(Error::Closed));
        let _ = tokio::time::timeout(Duration::from_millis(250), sink.close()).await;
    });
    inner
}

fn error_of(err: tokio_tungstenite::tungstenite::Error) -> Error {
    use tokio_tungstenite::tungstenite::Error as WebSocketError;
    match err {
        WebSocketError::Capacity(_) => Error::TooLarge,
        WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed => Error::Closed,
        WebSocketError::Protocol(reason) => Error::Protocol(reason.to_string()),
        other => Error::Transport(other.to_string()),
    }
}
