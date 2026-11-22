//! `pkm capture|search|undo`, `pkm journal show`, `pkm page list|show|save|rename|export`.

use clap::{Args, Subcommand, ValueEnum};
use vibevalley_protocol::{PkmCaptureRequest, PkmJournalRequest, PkmMarker, PkmPage, PkmPageRef, PkmPageRequest, PkmRenameRequest, PkmSearchRequest, ops};

use crate::client::{Client, Done, no_dry_run};
use crate::output::{line, stdin_text};

#[derive(Debug, Clone, Copy, ValueEnum)]
#[value(rename_all = "UPPER")]
pub enum PkmMarkerArg {
    #[value(name = "TODO")]
    Todo,
    #[value(name = "DOING")]
    Doing,
    #[value(name = "DONE")]
    Done,
    #[value(name = "NOW")]
    Now,
    #[value(name = "LATER")]
    Later,
    #[value(name = "WAITING")]
    Waiting,
    #[value(name = "CANCELED")]
    Canceled,
}

impl From<PkmMarkerArg> for PkmMarker {
    fn from(value: PkmMarkerArg) -> Self {
        match value {
            PkmMarkerArg::Todo => PkmMarker::TODO,
            PkmMarkerArg::Doing => PkmMarker::DOING,
            PkmMarkerArg::Done => PkmMarker::DONE,
            PkmMarkerArg::Now => PkmMarker::NOW,
            PkmMarkerArg::Later => PkmMarker::LATER,
            PkmMarkerArg::Waiting => PkmMarker::WAITING,
            PkmMarkerArg::Canceled => PkmMarker::CANCELED,
        }
    }
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct PkmCmd {
    #[command(subcommand)]
    pub action: PkmAction,
}

#[derive(Debug, Subcommand)]
pub enum PkmAction {
    /// Capture a quick note into today's journal or a named page
    #[command(after_help = "Examples:\n  vibevalley pkm capture 'Check release checklist'\n  vibevalley pkm capture 'Follow up' --page Reading")]
    Capture {
        /// Note text (reads stdin when omitted)
        #[arg(num_args = 0..)]
        words: Vec<String>,
        /// Append to this page instead of today's journal
        #[arg(long)]
        page: Option<String>,
    },
    /// Search blocks across outline notes
    #[command(after_help = "Examples:\n  vibevalley pkm search checklist --marker TODO")]
    Search {
        /// Search terms
        #[arg(num_args = 0..)]
        words: Vec<String>,
        /// Filter by task marker
        #[arg(long, value_enum)]
        marker: Option<PkmMarkerArg>,
        /// Filter to blocks linking to a page
        #[arg(long)]
        linked_to: Option<String>,
        /// Maximum number of hits
        #[arg(long)]
        limit: Option<i64>,
    },
    /// Undo the last PKM file write
    #[command(after_help = "Examples:\n  vibevalley pkm undo")]
    Undo,
    /// Daily journal commands
    Journal(PkmJournalCmd),
    /// Outline note page commands
    Page(PkmPageCmd),
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct PkmJournalCmd {
    #[command(subcommand)]
    pub action: PkmJournalAction,
}

#[derive(Debug, Subcommand)]
pub enum PkmJournalAction {
    /// Open and print a day's journal (defaults to today)
    #[command(after_help = "Examples:\n  vibevalley pkm journal show\n  vibevalley pkm journal show --day 2026-11-22")]
    Show {
        /// Day in YYYY-MM-DD format
        #[arg(long)]
        day: Option<String>,
    },
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct PkmPageCmd {
    #[command(subcommand)]
    pub action: PkmPageAction,
}

#[derive(Debug, Subcommand)]
pub enum PkmPageAction {
    /// List outline note pages
    #[command(after_help = "Examples:\n  vibevalley pkm page list\n  vibevalley pkm page list --limit 50")]
    List {
        /// Maximum number of pages to print
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
    /// Show one outline note page
    #[command(after_help = "Examples:\n  vibevalley pkm page show Reading")]
    Show {
        /// Page slug or title
        page: String,
    },
    /// Create or update an outline note page
    #[command(after_help = "Examples:\n  vibevalley pkm page save Reading -- '- First bullet'")]
    Save {
        /// Page title
        title: String,
        /// Markdown outline content (reads stdin when omitted)
        #[arg(num_args = 0..)]
        words: Vec<String>,
    },
    /// Rename a page and rewrite inbound wiki links
    #[command(after_help = "Examples:\n  vibevalley pkm page rename Reading 'Book Notes'")]
    Rename {
        /// Existing page slug or title
        from: String,
        /// New page title
        to: String,
    },
    /// Export a page as plain Markdown with transclusions expanded
    #[command(after_help = "Examples:\n  vibevalley pkm page export Reading")]
    Export {
        /// Page slug or title
        page: String,
    },
}

fn outline(page: &PkmPage) -> String {
    let mut lines = vec![format!("# {}", page.title), String::new()];
    lines.extend(page.blocks.iter().map(|b| {
        let mut parts = vec![];
        if let Some(marker) = &b.marker {
            parts.push(marker.as_str().to_string());
        }
        if let Some(priority) = &b.priority {
            parts.push(format!("[#{}]", priority.as_str()));
        }
        parts.push(b.body.replace('\n', " "));
        format!("{}- {}", "  ".repeat(b.depth as usize), parts.join(" "))
    }));
    lines.join("\n")
}

fn words_or_stdin(words: Vec<String>) -> String {
    let joined = words.join(" ");
    if joined.is_empty() { stdin_text() } else { joined }
}

pub fn run(client: &Client, cmd: PkmCmd) -> Done {
    match cmd.action {
        PkmAction::Capture { words, page } => {
            if client.dry_run {
                return Err(no_dry_run("pkm capture"));
            }
            let request = PkmCaptureRequest {
                text: words_or_stdin(words),
                page,
            };
            client.mutate::<ops::PkmCapture>("pkm capture", &request, |p| format!("captured to {}", p.title))
        }
        PkmAction::Search {
            words,
            marker,
            linked_to,
            limit,
        } => {
            let text = words.join(" ");
            let request = PkmSearchRequest {
                text: (!text.is_empty()).then_some(text),
                tier: None,
                marker: marker.map(Into::into),
                linked_to,
                limit,
            };
            let hits = client.ask::<ops::PkmSearch>(&request)?;
            client.output.show(&hits, |hs| {
                hs.iter()
                    .map(|h| {
                        format!(
                            "{} › {}{}",
                            h.page_title,
                            if h.path.is_empty() { String::new() } else { format!("{}: ", h.path) },
                            h.plain
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            Ok(())
        }
        PkmAction::Undo => client.mutate::<ops::PkmUndo>("pkm undo", &(), |res| {
            if res.undone {
                format!("undone {}", res.page.as_deref().unwrap_or("last change"))
            } else {
                "nothing to undo".into()
            }
        }),
        PkmAction::Journal(journal) => match journal.action {
            PkmJournalAction::Show { day } => {
                if client.dry_run {
                    return Err(no_dry_run("pkm journal show"));
                }
                let day = day.unwrap_or_else(|| jiff::ZonedDateTime::now().strftime("%Y-%m-%d").to_string());
                let page = client.ask::<ops::PkmJournalOpen>(&PkmJournalRequest { day })?;
                client.output.show(&page, outline);
                Ok(())
            }
        },
        PkmAction::Page(page) => match page.action {
            PkmPageAction::List { limit } => {
                let limit = limit.max(1) as usize;
                let vault = client.ask::<ops::PkmPageList>(&())?;
                let shown: Vec<_> = vault.pages.iter().take(limit).cloned().collect();
                client.output.show(&shown, |ps| {
                    let mut lines: Vec<String> = ps
                        .iter()
                        .map(|p| {
                            let open = if p.open > 0 { format!("open {}", p.open) } else { String::new() };
                            if p.slug == p.title {
                                line(&[&p.title, &open])
                            } else {
                                line(&[&p.slug, &p.title, &open])
                            }
                        })
                        .collect();
                    if vault.pages.len() > limit {
                        lines.push(format!("more available: pass --limit {}", limit * 2));
                    }
                    lines.join("\n")
                });
                Ok(())
            }
            PkmPageAction::Show { page } => {
                let view = client.ask::<ops::PkmPageGet>(&PkmPageRef { page })?;
                client.output.show(&view, |v| outline(&v.page));
                Ok(())
            }
            PkmPageAction::Save { title, words } => {
                if client.dry_run {
                    return Err(no_dry_run("pkm page save"));
                }
                let markdown = words_or_stdin(words);
                let request = PkmPageRequest {
                    title,
                    tier: None,
                    markdown: (!markdown.is_empty()).then_some(markdown),
                    ..Default::default()
                };
                client.mutate::<ops::PkmPageSave>("pkm page save", &request, |p| format!("saved {}", p.title))
            }
            PkmPageAction::Rename { from, to } => client.mutate::<ops::PkmPageRename>("pkm page rename", &PkmRenameRequest { from, to }, |r| {
                format!("renamed into {} ({} pages updated)", r.into, r.pages.len())
            }),
            PkmPageAction::Export { page } => {
                let exported = client.ask::<ops::PkmPageExport>(&PkmPageRef { page })?;
                client.output.show(&exported, |e| e.markdown.trim_end_matches('\n').to_string());
                Ok(())
            }
        },
    }
}
