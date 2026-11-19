use std::{sync::Arc, time::Duration};

use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use vibevalley_chord::{
    link::{Endpoint, MAX_MESSAGE_BYTES, Options, Principal, RpcError, Transport},
    watch::Document,
};
use vibevalley_protocol::BizCode;

use crate::{Shared, from_the_farm, refuse};

pub(super) async fn upgrade(State(server): State<Shared>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    let Some(space) = server.space_document() else {
        return refuse(BizCode::ServiceUnavailable, "no workspace document");
    };
    ws.max_frame_size(MAX_MESSAGE_BYTES)
        .max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| serve_socket(socket, server, space))
        .into_response()
}

fn endpoint(server: Shared, space: Document) -> Endpoint {
    let endpoint = Endpoint::default();
    endpoint.publish("space", space);
    endpoint.handle("budget.raise", move |_, input| raise_budget(server.clone(), input));
    endpoint
}

async fn raise_budget(server: Shared, input: Value) -> Result<Value, RpcError> {
    let reply = tokio::task::spawn_blocking(move || server.raise_budget(input))
        .await
        .map_err(|err| RpcError::new("internal", err.to_string()))?;
    match reply.error() {
        Some(error) => Err(RpcError::new(error.biz_code.code().to_string(), error.message)),
        None => Ok(reply.data.unwrap_or(Value::Null)),
    }
}

async fn serve_socket(socket: WebSocket, server: Shared, space: Document) {
    let (wire, bridge) = Transport::pipe(8);
    let (mut sink, mut stream) = socket.split();
    let io = async {
        let read = async {
            while let Some(Ok(message)) = stream.next().await {
                let bytes = match message {
                    Message::Text(_) | Message::Binary(_) => message.into_data(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                if bridge.send(bytes.to_vec()).await.is_err() {
                    break;
                }
            }
        };
        let write = async {
            while let Ok(bytes) = bridge.recv().await {
                if sink.send(Message::Binary(bytes.into())).await.is_err() {
                    break;
                }
            }
        };
        tokio::select! { _ = read => {}, _ = write => {} }
    };
    let link = async {
        let mut options = Options::new(Principal::user_device("vibe-server"));
        options.authenticate = Some(Arc::new(|peer| {
            if peer.kind == "user_device" {
                Ok(())
            } else {
                Err(RpcError::new("unauthorized", "expected user device"))
            }
        }));
        let endpoint = endpoint(server, space);
        if let Ok(Ok(link)) = tokio::time::timeout(Duration::from_secs(15), endpoint.connect(wire, options)).await {
            link.closed().await;
        }
    };
    tokio::select! { _ = io => {}, _ = link => {} }
    bridge.close();
}
