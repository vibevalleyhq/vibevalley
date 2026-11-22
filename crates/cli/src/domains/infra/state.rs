//! `state [--watch] [--timeout]`: snapshot or stream `StateFrame` updates from `/api/v1/state`.

use std::time::Duration;

use clap::Args;
use vibevalley_protocol::StateFrame;

use crate::client::{Client, Done, decode_failure};
use crate::output::line;

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  vibevalley state\n  vibevalley state --json\n  vibevalley state --watch --json")]
pub struct StateCmd {
    /// Keep streaming frames continuously instead of exiting after the initial snapshot
    #[arg(long)]
    pub watch: bool,
    /// Timeout in seconds (defaults to 10 in snapshot mode; unbounded in --watch unless set)
    #[arg(long)]
    pub timeout: Option<i64>,
}

fn frame_summary(frame: &StateFrame) -> String {
    let channels = frame.state.chat.as_ref().map_or(0, |c| c.channels.len());
    let media = frame.state.media.as_ref().map_or(0, Vec::len);
    line(&[
        &format!("seq {}", frame.seq),
        &format!("issues {}", frame.state.issues.len()),
        &format!("sessions {}", frame.state.sessions.len()),
        &format!("channels {channels}"),
        &format!("crons {}", frame.state.crons.len()),
        &format!("inbox {}", frame.inbox.len()),
        &format!("media {media}"),
    ])
}

pub fn run(client: &Client, cmd: StateCmd) -> Done {
    let timeout = if cmd.watch {
        cmd.timeout.map(|s| Duration::from_secs(s.max(1) as u64))
    } else {
        Some(Duration::from_secs(cmd.timeout.unwrap_or(10).max(1) as u64))
    };
    client.sse("/api/v1/state", timeout, |data| {
        let frame: StateFrame = serde_json::from_str(data).map_err(decode_failure)?;
        client.output.show(&frame, frame_summary);
        Ok(cmd.watch)
    })
}
