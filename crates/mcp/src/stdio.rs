//! Async newline-delimited JSON-RPC 2.0 stdio transport built on [`McpHandler`].
//!
//! Stdout is reserved strictly for JSON-RPC 2.0 response frames; diagnostics
//! must never be written to stdout.

use std::io::{self, BufRead, Write};

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

use crate::stateless::{McpHandler, RequestContext, dispatch_line};

/// Serves newline-delimited JSON-RPC 2.0 MCP requests over any async reader/writer pair.
///
/// Treats EOF and `BrokenPipe` as graceful shutdown (`Ok(())`).
pub async fn serve_io<H, R, W>(handler: &H, mut reader: R, mut writer: W) -> io::Result<()>
where
    H: McpHandler + ?Sized,
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let ctx = RequestContext::default();
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader.read_line(&mut line).await?;
        if bytes == 0 {
            return Ok(());
        }
        if let Some(response) = dispatch_line(handler, &ctx, &line).await {
            let encoded = serde_json::to_string(&response).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
            let write_res: io::Result<()> = async {
                writer.write_all(encoded.as_bytes()).await?;
                writer.write_all(b"\n").await?;
                writer.flush().await
            }
            .await;
            if let Err(err) = write_res {
                if err.kind() == io::ErrorKind::BrokenPipe {
                    return Ok(());
                }
                return Err(err);
            }
        }
    }
}

/// Serves newline-delimited JSON-RPC 2.0 MCP requests on process stdin/stdout.
///
/// Reads blocking stdin on a dedicated OS thread feeding a bounded channel so
/// the Tokio runtime never blocks on stdin.
pub async fn serve_stdio<H>(handler: &H) -> io::Result<()>
where
    H: McpHandler + ?Sized,
{
    let (tx, mut rx) = tokio::sync::mpsc::channel::<io::Result<String>>(32);

    std::thread::Builder::new().name("vibevalley-mcp-stdin".into()).spawn(move || {
        let stdin = io::stdin();
        let mut reader = io::BufReader::new(stdin.lock());
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if tx.blocking_send(Ok(std::mem::take(&mut line))).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = tx.blocking_send(Err(err));
                    break;
                }
            }
        }
    })?;

    let ctx = RequestContext::default();
    while let Some(next_line) = rx.recv().await {
        let line = next_line?;
        if let Some(response) = dispatch_line(handler, &ctx, &line).await {
            let encoded = serde_json::to_string(&response).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
            let mut stdout = io::stdout().lock();
            if let Err(err) = writeln!(stdout, "{encoded}").and_then(|()| stdout.flush()) {
                if err.kind() == io::ErrorKind::BrokenPipe {
                    return Ok(());
                }
                return Err(err);
            }
        }
    }
    Ok(())
}
