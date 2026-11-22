//! `library list|add|delete`.

use clap::{ArgGroup, Args, Subcommand, ValueEnum};
use vibevalley_protocol::{
    LibraryAddRequest, LibraryFileKind, LibraryItem, LibraryItemDeleteInput, LibraryListRequest, LibraryOrigin, LibraryOriginKind, LibrarySort, ops,
};

use crate::client::{Client, Done};
use crate::output::line;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum OriginArg {
    Generated,
    Uploaded,
    Fetched,
}

impl From<OriginArg> for LibraryOriginKind {
    fn from(value: OriginArg) -> Self {
        match value {
            OriginArg::Generated => LibraryOriginKind::Generated,
            OriginArg::Uploaded => LibraryOriginKind::Uploaded,
            OriginArg::Fetched => LibraryOriginKind::Fetched,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum FileKindArg {
    Image,
    Audio,
    Video,
    Other,
}

impl From<FileKindArg> for LibraryFileKind {
    fn from(value: FileKindArg) -> Self {
        match value {
            FileKindArg::Image => LibraryFileKind::Image,
            FileKindArg::Audio => LibraryFileKind::Audio,
            FileKindArg::Video => LibraryFileKind::Video,
            FileKindArg::Other => LibraryFileKind::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum SortArg {
    Recent,
    Name,
    Size,
}

impl From<SortArg> for LibrarySort {
    fn from(value: SortArg) -> Self {
        match value {
            SortArg::Recent => LibrarySort::Recent,
            SortArg::Name => LibrarySort::Name,
            SortArg::Size => LibrarySort::Size,
        }
    }
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct LibraryCmd {
    #[command(subcommand)]
    pub action: LibraryAction,
}

#[derive(Debug, Subcommand)]
pub enum LibraryAction {
    /// List media library items
    #[command(after_help = "Examples:\n  vibevalley library list\n  vibevalley library list --type image --sort name")]
    List {
        /// Filter by item origin
        #[arg(long, value_enum)]
        origin: Option<OriginArg>,
        /// Filter by file type
        #[arg(long = "type", value_enum)]
        file_type: Option<FileKindArg>,
        /// Filter by filename substring
        #[arg(long)]
        text: Option<String>,
        /// Sort order
        #[arg(long, value_enum)]
        sort: Option<SortArg>,
    },
    /// Add an attachment, URL, or local file path to the library
    #[command(
        group = ArgGroup::new("source").required(true).multiple(false),
        after_help = "Examples:\n  vibevalley library add --attachment <sha256> --name hero.png\n  vibevalley library add --path ./banner.png"
    )]
    Add {
        /// Existing attachment id
        #[arg(long, group = "source")]
        attachment: Option<String>,
        /// Remote URL to fetch
        #[arg(long, group = "source")]
        url: Option<String>,
        /// Local file path to import
        #[arg(long, group = "source")]
        path: Option<String>,
        /// Display name override
        #[arg(long)]
        name: Option<String>,
    },
    /// Remove an item from the library
    #[command(after_help = "Examples:\n  vibevalley library delete <id> --dry-run")]
    Delete {
        /// Library item (attachment) id
        id: String,
    },
}

fn origin_tag(origin: &LibraryOrigin) -> &'static str {
    match origin {
        LibraryOrigin::Generated { .. } => "generated",
        LibraryOrigin::Uploaded { .. } => "uploaded",
        LibraryOrigin::Fetched { .. } => "fetched",
    }
}

fn item_line(item: &LibraryItem) -> String {
    line(&[
        &item.attachment.id,
        &item.attachment.name,
        &item.attachment.r#type,
        origin_tag(&item.origin),
        &format!("{}B", item.attachment.size),
    ])
}

pub fn run(client: &Client, cmd: LibraryCmd) -> Done {
    match cmd.action {
        LibraryAction::List { origin, file_type, text, sort } => {
            let items = client.ask::<ops::LibraryItemList>(&LibraryListRequest {
                origin: origin.map(Into::into),
                r#type: file_type.map(Into::into),
                text,
                sort: sort.map(Into::into),
            })?;
            client.output.show(&items, |list| list.iter().map(item_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        LibraryAction::Add { attachment, url, path, name } => {
            let request = LibraryAddRequest { attachment, url, path, name };
            client.mutate::<ops::LibraryItemAdd>("library add", &request, item_line)
        }
        LibraryAction::Delete { id } => {
            let key = id.clone();
            client.mutate::<ops::LibraryItemDelete>("library delete", &LibraryItemDeleteInput { id }, |_| format!("deleted {key}"))
        }
    }
}
