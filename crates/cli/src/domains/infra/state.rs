//! `state [--slice <name>] [--watch] [--timeout]`: snapshot or stream state slices from `/api/v1/slice/<name>`.

use std::time::Duration;

use clap::{Args, ValueEnum};
use vibevalley_protocol::{BoardSlice, CollabSlice, FarmFrame, InboxSlice, OpsSlice, SessionsSlice, SliceBundle, SliceKind};

use crate::client::{Client, Done, Failure, decode_failure};
use crate::output::line;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum SliceArg {
    Board,
    Sessions,
    Collab,
    Inbox,
    Ops,
    Farm,
}

impl From<SliceArg> for SliceKind {
    fn from(arg: SliceArg) -> Self {
        match arg {
            SliceArg::Board => SliceKind::Board,
            SliceArg::Sessions => SliceKind::Sessions,
            SliceArg::Collab => SliceKind::Collab,
            SliceArg::Inbox => SliceKind::Inbox,
            SliceArg::Ops => SliceKind::Ops,
            SliceArg::Farm => SliceKind::Farm,
        }
    }
}

#[derive(Debug, Args)]
#[command(
    after_help = "Examples:\n  vibevalley state\n  vibevalley state --json\n  vibevalley state --slice board --json\n  vibevalley state --slice board --watch --json"
)]
pub struct StateCmd {
    /// Specific slice to inspect or stream (omit to assemble a full SliceBundle snapshot)
    #[arg(long, value_enum)]
    pub slice: Option<SliceArg>,
    /// Keep streaming slice updates continuously instead of exiting after the initial snapshot
    #[arg(long)]
    pub watch: bool,
    /// Timeout in seconds (defaults to 10 in snapshot mode; unbounded in --watch unless set)
    #[arg(long)]
    pub timeout: Option<i64>,
}

fn bundle_summary(bundle: &SliceBundle) -> String {
    let channels = bundle.collab.chat.as_ref().map_or(0, |c| c.channels.len());
    let media = bundle.ops.media.as_ref().map_or(0, Vec::len);
    line(&[
        &format!("seq {}", bundle.seq),
        &format!("issues {}", bundle.board.issues.len()),
        &format!("sessions {}", bundle.sessions.sessions.len()),
        &format!("channels {channels}"),
        &format!("crons {}", bundle.ops.crons.len()),
        &format!("inbox {}", bundle.inbox.items.len()),
        &format!("media {media}"),
    ])
}

fn board_summary(s: &BoardSlice) -> String {
    line(&["board", &format!("seq {}", s.seq), &format!("issues {}", s.issues.len())])
}

fn sessions_summary(s: &SessionsSlice) -> String {
    line(&[
        "sessions",
        &format!("seq {}", s.seq),
        &format!("sessions {}", s.sessions.len()),
        &format!("machines {}", s.machines.len()),
    ])
}

fn collab_summary(s: &CollabSlice) -> String {
    let channels = s.chat.as_ref().map_or(0, |c| c.channels.len());
    line(&[
        "collab",
        &format!("seq {}", s.seq),
        &format!("channels {channels}"),
        &format!("connectors {}", s.connectors.len()),
    ])
}

fn inbox_summary(s: &InboxSlice) -> String {
    line(&["inbox", &format!("seq {}", s.seq), &format!("items {}", s.items.len())])
}

fn ops_summary(s: &OpsSlice) -> String {
    let media = s.media.as_ref().map_or(0, Vec::len);
    line(&["ops", &format!("seq {}", s.seq), &format!("crons {}", s.crons.len()), &format!("media {media}")])
}

fn farm_summary(s: &FarmFrame) -> String {
    line(&[
        "farm",
        &format!("seq {}", s.seq),
        &format!("level {}", s.view.level.level),
        &format!("plots {}", s.view.plots.len()),
        &format!("effects {}", s.effects.len()),
    ])
}

fn show_slice_json(client: &Client, kind: SliceKind, data: &str) -> Done {
    match kind {
        SliceKind::Board => {
            let s: BoardSlice = serde_json::from_str(data).map_err(decode_failure)?;
            client.output.show(&s, board_summary);
        }
        SliceKind::Sessions => {
            let s: SessionsSlice = serde_json::from_str(data).map_err(decode_failure)?;
            client.output.show(&s, sessions_summary);
        }
        SliceKind::Collab => {
            let s: CollabSlice = serde_json::from_str(data).map_err(decode_failure)?;
            client.output.show(&s, collab_summary);
        }
        SliceKind::Inbox => {
            let s: InboxSlice = serde_json::from_str(data).map_err(decode_failure)?;
            client.output.show(&s, inbox_summary);
        }
        SliceKind::Ops => {
            let s: OpsSlice = serde_json::from_str(data).map_err(decode_failure)?;
            client.output.show(&s, ops_summary);
        }
        SliceKind::Farm => {
            let s: FarmFrame = serde_json::from_str(data).map_err(decode_failure)?;
            client.output.show(&s, farm_summary);
        }
    }
    Ok(())
}

pub fn run(client: &Client, cmd: StateCmd) -> Done {
    if cmd.watch {
        let Some(slice_arg) = cmd.slice else {
            return Err(Failure::usage(
                "MissingOption",
                "--watch requires --slice <board|sessions|collab|inbox|ops|farm>",
            ));
        };
        let kind: SliceKind = slice_arg.into();
        let timeout = cmd.timeout.map(|s| Duration::from_secs(s.max(1) as u64));
        let path = format!("/api/v1/slice/{}", kind.as_str());
        return client.sse(&path, timeout, |data| {
            show_slice_json(client, kind, data)?;
            Ok(true)
        });
    }

    if let Some(slice_arg) = cmd.slice {
        let kind: SliceKind = slice_arg.into();
        let data = client.get_text(&format!("/api/v1/slice/{}?once=1", kind.as_str()))?;
        return show_slice_json(client, kind, &data);
    }

    let board: BoardSlice = client.slice(SliceKind::Board)?;
    let sessions: SessionsSlice = client.slice(SliceKind::Sessions)?;
    let collab: CollabSlice = client.slice(SliceKind::Collab)?;
    let inbox: InboxSlice = client.slice(SliceKind::Inbox)?;
    let ops: OpsSlice = client.slice(SliceKind::Ops)?;
    let farm: FarmFrame = client.slice(SliceKind::Farm)?;
    let seq = [board.seq, sessions.seq, collab.seq, inbox.seq, ops.seq, farm.seq]
        .into_iter()
        .max()
        .unwrap_or(0);
    let bundle = SliceBundle {
        seq,
        board,
        sessions,
        collab,
        inbox,
        ops,
        farm,
    };
    client.output.show(&bundle, bundle_summary);
    Ok(())
}
