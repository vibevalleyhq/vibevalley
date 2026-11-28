//! Shared HTTP fetch abstraction, process TLS initialization, pooled/no-redirect
//! clients, and bound-DNS public HTTPS downloads delegated to [`vibevalley_kit::net::outbound`].

pub use vibevalley_kit::net::outbound::{
    Fetch, FetchError, Http, PublicBytes, PublicDownload, PublicDownloadError, ReadError, Request, Response, install_tls, no_redirect_client, pooled_client,
    public_https, read_max, read_max_until,
};

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::io::{Cursor, Read};
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use axum::Router;
    use axum::body::{Body, Bytes};
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::routing::{get, post};
    use tokio::net::TcpListener;
    use tokio_util::sync::{CancellationToken, DropGuard};

    use super::*;

    async fn spawn_mock_async(router: Router) -> (SocketAddr, DropGuard) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let guard = cancel.clone().drop_guard();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
        });
        (addr, guard)
    }

    #[tokio::test]
    async fn download_addresses_cannot_reach_private_networks_or_carry_credentials() {
        for address in [
            "https://127.0.0.1/image",
            "https://[::ffff:7f00:1]/image",
            "https://10.0.0.2/image",
            "https://169.254.169.254/latest",
            "https://100.64.0.1/",
            "https://192.168.0.1/",
            "file:///etc/passwd",
            "http://example.com/image",
            "https://user:secret@example.com/a",
            "https://example.com:8443/a",
            "https://example.com/a#fragment",
        ] {
            assert!(!public_https(&url::Url::parse(address).unwrap()), "{address}");
            assert!(
                matches!(
                    PublicDownload::get_bytes_async(address, Duration::from_secs(1), 1024).await,
                    Err(PublicDownloadError::BadUrl)
                ),
                "PublicDownload::get_bytes_async must reject {address}"
            );
            assert!(
                PublicDownload::fetch_async(
                    Request {
                        method: "GET",
                        url: address.into(),
                        headers: vec![],
                        body: None,
                        timeout: Duration::from_secs(1),
                    },
                    None,
                )
                .await
                .is_err(),
                "PublicDownload::fetch_async must reject {address}"
            );
        }
        for address in ["https://example.com/image?signed=x", "https://8.8.8.8/image"] {
            assert!(public_https(&url::Url::parse(address).unwrap()));
        }
    }

    #[tokio::test]
    async fn http_fetch_streams_post_body_and_never_follows_redirects() {
        let seen = Arc::new(Mutex::new(None::<(Option<String>, Vec<u8>)>));
        let seen_for_route = seen.clone();
        let app = Router::new()
            .route(
                "/upload",
                post(move |headers: HeaderMap, body: Bytes| {
                    let x_test = headers.get("x-test").and_then(|v| v.to_str().ok()).map(ToString::to_string);
                    *seen_for_route.lock().unwrap() = Some((x_test, body.to_vec()));
                    async move { (StatusCode::CREATED, [(header::CONTENT_TYPE, "application/json")], r#"{"ok":true}"#) }
                }),
            )
            .route(
                "/redir",
                get(|| async { (StatusCode::FOUND, [(header::LOCATION, "http://127.0.0.1:1/other")]) }),
            );
        let (addr, _guard) = spawn_mock_async(app).await;

        let mut res = Http::fetch_async(
            Request {
                method: "POST",
                url: format!("http://{addr}/upload"),
                headers: vec![("x-test".into(), "ok".into())],
                body: Some(("text/plain".into(), Box::new(Cursor::new(b"payload".to_vec())))),
                timeout: Duration::from_secs(5),
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(res.status, 201);
        assert_eq!(res.media_type(), "application/json");
        let body = tokio::task::spawn_blocking(move || {
            let mut body = String::new();
            res.body.read_to_string(&mut body).unwrap();
            body
        })
        .await
        .unwrap();
        assert_eq!(body, "{\"ok\":true}");
        assert_eq!(seen.lock().unwrap().as_ref(), Some(&(Some("ok".to_string()), b"payload".to_vec())));

        let redirect = Http::fetch_async(
            Request {
                method: "GET",
                url: format!("http://{addr}/redir"),
                headers: vec![],
                body: None,
                timeout: Duration::from_secs(5),
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(redirect.status, 302);
        assert_eq!(redirect.header("location"), Some("http://127.0.0.1:1/other"));
    }

    #[tokio::test]
    async fn async_fetch_and_public_download_reject_bad_urls_and_stream_without_block_on() {
        let app = Router::new().route("/ping", get(|| async { ([(header::CONTENT_TYPE, "text/plain")], "hello") }));
        let (addr, _guard) = spawn_mock_async(app).await;

        assert!(matches!(
            PublicDownload::get_bytes_async("https://127.0.0.1/private", Duration::from_secs(1), 1024).await,
            Err(PublicDownloadError::BadUrl)
        ));
        let mut res = Http::fetch_async(
            Request {
                method: "GET",
                url: format!("http://{addr}/ping"),
                headers: vec![],
                body: None,
                timeout: Duration::from_secs(5),
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(res.status, 200);
        let body = tokio::task::spawn_blocking(move || {
            let mut text = String::new();
            res.body.read_to_string(&mut text).unwrap();
            text
        })
        .await
        .unwrap();
        assert_eq!(body, "hello");
    }

    #[tokio::test]
    async fn http_fetch_streams_chunks_enforces_read_max_and_aborts_on_cancel() {
        let stream_cancel = CancellationToken::new();
        let stream_cancel_for_route = stream_cancel.clone();
        let app = Router::new()
            .route(
                "/chunks",
                get(|| async {
                    let stream = futures_util::stream::iter([Ok::<_, Infallible>(Bytes::from_static(b"hello")), Ok(Bytes::from_static(b"world"))]);
                    ([(header::CONTENT_TYPE, "application/octet-stream")], Body::from_stream(stream))
                }),
            )
            .route(
                "/stalled",
                get(move || {
                    let cancel = stream_cancel_for_route.clone();
                    let stream = futures_util::stream::unfold((true, cancel), |(first, cancel)| async move {
                        if first {
                            Some((Ok::<_, Infallible>(Bytes::from_static(b"first")), (false, cancel)))
                        } else {
                            cancel.cancelled().await;
                            None
                        }
                    });
                    async move { ([(header::CONTENT_TYPE, "text/plain")], Body::from_stream(stream)) }
                }),
            );
        let (addr, _guard) = spawn_mock_async(app).await;
        let _stream_guard = stream_cancel.drop_guard();

        let mut res = Http::fetch_async(
            Request {
                method: "GET",
                url: format!("http://{addr}/chunks"),
                headers: vec![],
                body: None,
                timeout: Duration::from_secs(5),
            },
            None,
        )
        .await
        .unwrap();
        let read_res = tokio::task::spawn_blocking(move || read_max(&mut res.body, 8)).await.unwrap();
        assert_eq!(read_res, Err(ReadError::TooLarge));

        let cancel = CancellationToken::new();
        let mut res = Http::fetch_async(
            Request {
                method: "GET",
                url: format!("http://{addr}/stalled"),
                headers: vec![],
                body: None,
                timeout: Duration::from_secs(30),
            },
            Some(cancel.clone()),
        )
        .await
        .unwrap();
        let res = tokio::task::spawn_blocking(move || {
            let mut first = [0u8; 5];
            res.body.read_exact(&mut first).unwrap();
            assert_eq!(&first, b"first");
            res
        })
        .await
        .unwrap();

        let cancel_trigger = cancel.clone();
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel_trigger.cancel();
        });
        let started = std::time::Instant::now();
        tokio::task::spawn_blocking(move || {
            let mut res = res;
            let mut rest = [0u8; 16];
            let err = res.body.read(&mut rest).expect_err("cancelled read must fail");
            assert_eq!(err.kind(), std::io::ErrorKind::Interrupted);
            assert!(started.elapsed() < Duration::from_secs(2), "cancel must abort promptly");
            assert_eq!(res.body.read(&mut rest).unwrap_err().kind(), std::io::ErrorKind::Interrupted);
        })
        .await
        .unwrap();

        canceller.await.unwrap();
    }
}
