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
use serde_json::{Value, json};
use vibevalley_chord::{
    link::{Endpoint, MAX_MESSAGE_BYTES, Options, Principal, RpcError, Transport},
    watch::Document,
};
use vibevalley_protocol::{BizCode, MessageKind};

use crate::{Shared, from_the_farm, refuse};

pub(super) async fn upgrade(State(server): State<Shared>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    let Some(space) = server.space_document() else {
        return refuse(BizCode::ServiceUnavailable, "no workspace document");
    };
    let origin = format!("http://{}", headers["host"].to_str().expect("validated host"));
    ws.max_frame_size(MAX_MESSAGE_BYTES)
        .max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| serve_socket(socket, server, space, origin))
        .into_response()
}

fn endpoint(server: Shared, space: Document, origin: String) -> Endpoint {
    let endpoint = Endpoint::default();
    endpoint.publish("space", space.clone());
    endpoint.handle("channel.events", {
        let server = server.clone();
        move |_, input| channel_events(server.clone(), input)
    });
    endpoint.handle("approval.resolve", {
        let server = server.clone();
        move |_, input| governance(server.clone(), input, |s, v| s.resolve_approval(v))
    });
    endpoint.handle("budget.raise", move |_, input| governance(server.clone(), input, |s, v| s.raise_budget(v)));
    let snapshot = space.clone();
    endpoint.handle("space.snapshot", move |_, _| {
        let (rev, view, _) = snapshot.state();
        async move { Ok(json!({"rev":rev, "view":view})) }
    });
    let health = space.clone();
    endpoint.handle("health.ping", move |_, _| {
        let machines = health.state().1.get(&["onlineMachines".into()]);
        let result = json!({"ok":true, "serverUrl":origin, "onlineMachines":machines});
        async move { Ok(result) }
    });
    endpoint.handle("issue.list", move |_, input| {
        let snapshot = space.state().1;
        async move {
            #[derive(Default, serde::Deserialize)]
            struct Filter {
                #[serde(default)]
                statuses: Vec<String>,
            }
            let filter = if input.is_null() {
                Filter::default()
            } else {
                serde_json::from_value(input).map_err(|e| RpcError::new("invalid_params", e.to_string()))?
            };
            let Some(Value::Array(mut issues)) = snapshot.get(&["issues".into()]) else {
                return Err(RpcError::new("internal", "missing issues"));
            };
            if !filter.statuses.is_empty() {
                issues.retain(|i| i["status"].as_str().is_some_and(|s| filter.statuses.iter().any(|status| status == s)));
            }
            Ok(Value::Array(issues))
        }
    });
    endpoint
}

async fn channel_events(server: Shared, input: Value) -> Result<Value, RpcError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Request {
        channel_id: String,
        #[serde(default)]
        after_seq: i64,
        #[serde(default)]
        limit: i64,
    }

    let req: Request = serde_json::from_value(input).map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let messages = server
            .channel_messages_after(&req.channel_id, req.after_seq, req.limit)
            .map_err(|e| RpcError::new(e.biz_code.code().to_string(), e.message))?;
        let events = messages.into_iter().map(|m| {
            let kind = match m.kind {
                MessageKind::Report => "report",
                MessageKind::Chat | MessageKind::Dispatch | MessageKind::Notice => "message",
            };
            let mut view = json!({"channelId":m.channel, "seq":m.number, "kind":kind, "authorId":m.from, "text":m.text, "createdAtMs":m.at});
            if let Some(session) = m.session {
                view["sessionId"] = json!(session);
            }
            view
        });
        Ok(Value::Array(events.collect()))
    })
    .await
    .map_err(|e| RpcError::new("internal", e.to_string()))?
}

async fn governance(
    server: Shared,
    input: Value,
    call: fn(&dyn vibevalley_server_api::Server, Value) -> vibevalley_protocol::Envelope,
) -> Result<Value, RpcError> {
    let reply = tokio::task::spawn_blocking(move || call(server.as_ref(), input))
        .await
        .map_err(|err| RpcError::new("internal", err.to_string()))?;
    match reply.error() {
        Some(error) => Err(RpcError::new(error.biz_code.code().to_string(), error.message)),
        None => Ok(reply.data.unwrap_or(Value::Null)),
    }
}

async fn serve_socket(socket: WebSocket, server: Shared, space: Document, origin: String) {
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
        let endpoint = endpoint(server, space, origin);
        if let Ok(Ok(link)) = tokio::time::timeout(Duration::from_secs(15), endpoint.connect(wire, options)).await {
            link.closed().await;
        }
    };
    tokio::select! { _ = io => {}, _ = link => {} }
    bridge.close();
}
