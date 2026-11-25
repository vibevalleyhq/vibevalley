//! `channel list|create|delete`, `channel pin list|set`, `channel message list|send|search|delete`.

use clap::{Args, Subcommand};
use vibevalley_protocol::{
    ArtifactViewContext, Channel, ChannelMessageDeleteInput, ChannelMessageListInput, ChannelPinListInput, ChannelPinSetInput, ChannelRequest, ChatMessage,
    MessageSearch, SayRequest, ops,
};

use crate::client::{Client, Done};
use crate::output::{line, one_line, read_json_input};

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct ChannelCmd {
    #[command(subcommand)]
    pub action: ChannelAction,
}

#[derive(Debug, Subcommand)]
pub enum ChannelAction {
    /// List channels and direct threads
    #[command(after_help = "Examples:\n  vibevalley channel list")]
    List,
    /// Create a new channel
    #[command(after_help = "Examples:\n  vibevalley channel create release --description 'Release prep'")]
    Create {
        /// Channel name
        name: String,
        /// Optional channel description
        #[arg(long)]
        description: Option<String>,
        /// Optional repository name bound to the channel
        #[arg(long)]
        repo: Option<String>,
    },
    /// Delete an unused channel
    #[command(after_help = "Examples:\n  vibevalley channel delete release --dry-run")]
    Delete {
        /// Channel id
        channel: String,
    },
    /// Manage pinned messages in a channel
    Pin(ChannelPinCmd),
    /// List, send, search, or delete messages
    Message(ChannelMessageCmd),
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct ChannelPinCmd {
    #[command(subcommand)]
    pub action: ChannelPinAction,
}

#[derive(Debug, Subcommand)]
pub enum ChannelPinAction {
    /// List pinned messages in a channel
    #[command(after_help = "Examples:\n  vibevalley channel pin list general")]
    List {
        /// Channel id
        channel: String,
    },
    /// Pin or unpin a message by id
    #[command(after_help = "Examples:\n  vibevalley channel pin set msg-1\n  vibevalley channel pin set msg-1 --off")]
    Set {
        /// Message id
        message: String,
        /// Unpin the message instead of pinning it
        #[arg(long)]
        off: bool,
    },
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct ChannelMessageCmd {
    #[command(subcommand)]
    pub action: ChannelMessageAction,
}

#[derive(Debug, Subcommand)]
pub enum ChannelMessageAction {
    /// List recent messages in a channel
    #[command(after_help = "Examples:\n  vibevalley channel message list general --limit 10")]
    List {
        /// Channel id
        channel: String,
        /// Maximum number of messages to fetch
        #[arg(long, default_value_t = 20)]
        limit: i64,
        /// Fetch messages before this message number
        #[arg(long)]
        before: Option<i64>,
    },
    /// Send a message to a channel
    #[command(
        after_help = "Examples:\n  vibevalley channel message send general 'Ship ready'\n  vibevalley channel message send general 'Check slide 2' --view-context @ctx.json --send-key k1"
    )]
    Send {
        /// Channel id
        channel: String,
        /// Message body
        #[arg(required = true, num_args = 1..)]
        words: Vec<String>,
        /// Reply to message number
        #[arg(long)]
        reply: Option<i64>,
        /// Client idempotency key echoed on the message
        #[arg(long)]
        send_key: Option<String>,
        /// Attachment id to include (repeatable)
        #[arg(long)]
        attachment: Vec<String>,
        /// ArtifactViewContext JSON (inline JSON, '-' for stdin, or '@file')
        #[arg(long)]
        view_context: Option<String>,
    },
    /// Search messages across channels or within one channel
    #[command(after_help = "Examples:\n  vibevalley channel message search release --channel general")]
    Search {
        /// Search terms
        #[arg(required = true, num_args = 1..)]
        words: Vec<String>,
        /// Limit search to one channel and its threads
        #[arg(long)]
        channel: Option<String>,
    },
    /// Delete a message by id
    #[command(after_help = "Examples:\n  vibevalley channel message delete msg-1 --dry-run")]
    Delete {
        /// Message id
        message: String,
    },
}

fn channel_line(channel: &Channel) -> String {
    let unread = channel.unread.filter(|n| *n > 0).map(|n| format!("unread {n}")).unwrap_or_default();
    let name = channel.name.clone().unwrap_or_else(|| channel.title.clone());
    line(&[
        &format!("#{name}"),
        channel.r#type.as_str(),
        if channel.default { "default" } else { "" },
        &unread,
    ])
}

fn message_line(message: &ChatMessage) -> String {
    format!("#{}  {}: {}", message.number, message.name, one_line(&message.text))
}

pub async fn run(client: &Client, cmd: ChannelCmd) -> Done {
    match cmd.action {
        ChannelAction::List => {
            let channels = client.ask::<ops::ChannelList>(&()).await?;
            client.output.show(&channels, |cs| cs.iter().map(channel_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        ChannelAction::Create { name, description, repo } => {
            let request = ChannelRequest { name, description, repo };
            client.mutate::<ops::ChannelCreate>("channel create", &request, |id| format!("#{id}")).await
        }
        ChannelAction::Delete { channel } => {
            let id = channel.clone();
            client
                .mutate::<ops::ChannelDelete>("channel delete", &ChannelPinListInput { id: channel }, |_| format!("deleted #{id}"))
                .await
        }
        ChannelAction::Pin(pin) => match pin.action {
            ChannelPinAction::List { channel } => {
                let messages = client.ask::<ops::ChannelPinList>(&ChannelPinListInput { id: channel }).await?;
                client.output.show(&messages, |ms| ms.iter().map(message_line).collect::<Vec<_>>().join("\n"));
                Ok(())
            }
            ChannelPinAction::Set { message, off } => {
                client
                    .mutate::<ops::ChannelPinSet>("channel pin set", &ChannelPinSetInput { id: message, on: !off }, message_line)
                    .await
            }
        },
        ChannelAction::Message(msg) => match msg.action {
            ChannelMessageAction::List { channel, limit, before } => {
                let messages = client
                    .ask::<ops::ChannelMessageList>(&ChannelMessageListInput {
                        id: channel,
                        limit: Some(limit),
                        before,
                    })
                    .await?;
                client.output.show(&messages, |ms| {
                    let mut lines: Vec<String> = ms.iter().map(message_line).collect();
                    if let Some(first) = ms.first().filter(|f| f.number > 1) {
                        lines.push(format!("more available: pass --before {}", first.number));
                    }
                    lines.join("\n")
                });
                Ok(())
            }
            ChannelMessageAction::Send {
                channel,
                words,
                reply,
                send_key,
                attachment,
                view_context,
            } => {
                let parsed_ctx = view_context.as_deref().map(read_json_input::<ArtifactViewContext>).transpose()?;
                let request = SayRequest {
                    id: channel.clone(),
                    text: words.join(" "),
                    reply_to: reply,
                    send_key,
                    attachments: (!attachment.is_empty()).then_some(attachment),
                    view_context: parsed_ctx,
                    ..Default::default()
                };
                client
                    .mutate::<ops::ChannelMessageSend>("channel message send", &request, |_| format!("sent to #{channel}"))
                    .await
            }
            ChannelMessageAction::Search { words, channel } => {
                let hits = client
                    .ask::<ops::ChannelMessageSearch>(&MessageSearch {
                        text: words.join(" "),
                        channel,
                    })
                    .await?;
                client.output.show(&hits, |hs| {
                    hs.iter()
                        .map(|h| format!("{}  {}", h.channel, message_line(&h.message)))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            ChannelMessageAction::Delete { message } => {
                let id = message.clone();
                client
                    .mutate::<ops::ChannelMessageDelete>("channel message delete", &ChannelMessageDeleteInput { id: message }, |_| {
                        format!("deleted {id}")
                    })
                    .await
            }
        },
    }
}
