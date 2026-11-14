//! `pkm capture|search|radar`, `pkm journal show`, `pkm page list|show|save|export|edit`.

use clap::{ArgMatches, Command};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    PkmCaptureRequest, PkmJournalRequest, PkmMarker, PkmPage, PkmPageRef, PkmPageRequest, PkmRadarGetInput, PkmSearchRequest, PkmSourceUpdate, PkmTier, ops,
};

use crate::farm::{Ctx, Done, Failure, exit, line, out, stdin_text};
use crate::tree::{arg, choice, cmd, get, group, int, joined, maybe_words, number, pos, text};

fn tier_flag() -> clap::Arg {
    choice("tier", PkmTier::ALL.iter().map(|x| x.as_str()), "cli.flag.tier")
}

fn tier_of(m: &ArgMatches) -> Option<PkmTier> {
    get(m, "tier").and_then(|s| PkmTier::ALL.iter().copied().find(|x| x.as_str() == s))
}

/// A page as its outline: the title, then each block at its depth, its marker and priority first.
fn outline(p: &PkmPage) -> String {
    let mut lines = vec![format!("# {}", p.title), String::new()];
    lines.extend(p.blocks.iter().map(|b| {
        let mut parts = vec![];
        if let Some(m) = &b.marker {
            parts.push(m.as_str().to_string());
        }
        if let Some(p) = &b.priority {
            parts.push(format!("[#{}]", p.as_str()));
        }
        parts.push(b.body.replace('\n', " "));
        format!("{}- {}", "  ".repeat(b.depth as usize), parts.join(" "))
    }));
    lines.join("\n")
}

/// The given words, else what comes on stdin.
fn words_or_stdin(m: &ArgMatches) -> String {
    let words = joined(m, "words");
    if words.is_empty() { stdin_text() } else { words }
}

pub fn command() -> Command {
    let page = || pos("page", "cli.arg.page");
    group(
        "pkm",
        "cli.group.pkm.about",
        vec![
            cmd(
                "capture",
                "cli.command.pkm.capture",
                &[
                    ("cli.example.pkmCapture.run", "cli.example.pkmCapture.about"),
                    ("cli.example.pkmCapturePage.run", "cli.example.pkmCapturePage.about"),
                ],
            )
            .args([maybe_words("words", "cli.arg.capture"), text("page", "cli.flag.capturePage")]),
            cmd(
                "search",
                "cli.command.pkm.search",
                &[("cli.example.pkmSearch.run", "cli.example.pkmSearch.about")],
            )
            .args([
                maybe_words("words", "cli.arg.search"),
                tier_flag(),
                choice("marker", PkmMarker::ALL.iter().map(|x| x.as_str()), "cli.flag.marker"),
                int("limit", "cli.flag.limit"),
            ]),
            cmd("radar", "cli.command.pkm.radar", &[("vibevalley pkm radar", "cli.example.pkmRadar.about")]),
            group(
                "journal",
                "cli.group.pkm.journal.about",
                vec![
                    cmd(
                        "show",
                        "cli.command.pkm.journalShow",
                        &[("vibevalley pkm journal show", "cli.example.pkmJournal.about")],
                    )
                    .arg(text("day", "cli.flag.day")),
                ],
            ),
            group(
                "page",
                "cli.group.pkm.page.about",
                vec![
                    cmd(
                        "list",
                        "cli.command.pkm.pageList",
                        &[("vibevalley pkm page list", "cli.example.pkmPageList.about")],
                    )
                    .arg(int("limit", "cli.flag.limit").default_value("20")),
                    cmd(
                        "show",
                        "cli.command.pkm.pageShow",
                        &[("cli.example.pkmPageShow.run", "cli.example.pkmPageShow.about")],
                    )
                    .arg(page()),
                    cmd(
                        "save",
                        "cli.command.pkm.pageSave",
                        &[("cli.example.pkmPageSave.run", "cli.example.pkmPageSave.about")],
                    )
                    .args([pos("title", "cli.arg.pageTitle"), maybe_words("words", "cli.arg.capture"), tier_flag()]),
                    cmd(
                        "export",
                        "cli.command.pkm.pageExport",
                        &[("cli.example.pkmPageExport.run", "cli.example.pkmPageExport.about")],
                    )
                    .arg(page()),
                    cmd(
                        "edit",
                        "cli.command.pkm.pageEdit",
                        &[("cli.example.pkmPageEdit.run", "cli.example.pkmPageEdit.about")],
                    )
                    .arg(page()),
                ],
            ),
        ],
    )
}

pub fn run(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("capture", m)) => {
            let written = ctx.ask::<ops::PkmCapture>(&PkmCaptureRequest {
                text: words_or_stdin(m),
                page: get(m, "page"),
            })?;
            ctx.show(&written, |w| t("cli.pkm.captured", &[("page", w.title.clone().into())]));
            Ok(())
        }
        Some(("search", m)) => {
            let request = PkmSearchRequest {
                text: Some(joined(m, "words")).filter(|t| !t.is_empty()),
                tier: tier_of(m),
                marker: get(m, "marker").and_then(|s| PkmMarker::ALL.iter().copied().find(|x| x.as_str() == s)),
                limit: number(m, "limit"),
                ..Default::default()
            };
            let hits = ctx.ask::<ops::PkmSearch>(&request)?;
            ctx.show(&hits, |hs| {
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
        Some(("radar", _)) => {
            let r = ctx.ask::<ops::PkmRadarGet>(&PkmRadarGetInput::default())?;
            ctx.show(&r, |r| {
                let mut lines = vec![t("cli.pkm.inbox", &[("n", r.inbox.into())])];
                lines.extend(
                    r.stale
                        .iter()
                        .map(|p| t("cli.pkm.stale", &[("page", p.title.clone().into()), ("days", p.days.into())])),
                );
                lines.extend(
                    r.overdue
                        .iter()
                        .map(|d| t("cli.pkm.overdue", &[("deadline", d.deadline.clone().into()), ("words", d.plain.clone().into())])),
                );
                lines.join("\n")
            });
            Ok(())
        }
        Some(("journal", m)) => {
            let Some(("show", m)) = m.subcommand() else { return Ok(()) };
            let day = get(m, "day").unwrap_or_else(|| jiff::Zoned::now().strftime("%Y-%m-%d").to_string());
            let page = ctx.ask::<ops::PkmJournalOpen>(&PkmJournalRequest { day })?;
            ctx.show(&page, outline);
            Ok(())
        }
        Some(("page", m)) => page(ctx, m),
        _ => Ok(()),
    }
}

fn page(ctx: &Ctx, m: &ArgMatches) -> Done {
    let named = |m: &ArgMatches| PkmPageRef { page: arg(m, "page") };
    match m.subcommand() {
        Some(("list", m)) => {
            let limit = number(m, "limit").unwrap_or(20).max(1) as usize;
            let vault = ctx.ask::<ops::PkmPageList>(&())?;
            let shown: Vec<_> = vault.pages.iter().take(limit).cloned().collect();
            ctx.show(&shown, |ps| {
                let mut lines: Vec<String> = ps
                    .iter()
                    .map(|p| line(&[&p.title, p.tier.as_str(), &if p.open > 0 { format!("open {}", p.open) } else { String::new() }]))
                    .collect();
                if vault.pages.len() > limit {
                    lines.push(t("cli.more", &[("flag", format!("--limit {}", limit * 2).into())]));
                }
                lines.join("\n")
            });
            Ok(())
        }
        Some(("show", m)) => {
            let v = ctx.ask::<ops::PkmPageGet>(&named(m))?;
            ctx.show(&v, |v| outline(&v.page));
            Ok(())
        }
        Some(("export", m)) => {
            let x = ctx.ask::<ops::PkmPageExport>(&named(m))?;
            ctx.show(&x, |x| x.markdown.trim_end_matches('\n').to_string());
            Ok(())
        }
        Some(("save", m)) => {
            let markdown = words_or_stdin(m);
            let request = PkmPageRequest {
                title: arg(m, "title"),
                tier: tier_of(m),
                markdown: Some(markdown).filter(|s| !s.is_empty()),
                ..Default::default()
            };
            ctx.change::<ops::PkmPageSave>("pkm page save", None, &request, |p| t("cli.pkm.saved", &[("page", p.title.clone().into())]))
        }
        Some(("edit", m)) => edit(ctx, &arg(m, "page")),
        _ => Ok(()),
    }
}

/// The page's file in `$VISUAL` or `$EDITOR` (vi without either), written back when the editor closes.
fn edit(ctx: &Ctx, page: &str) -> Done {
    let source = ctx.ask::<ops::PkmSourceGet>(&PkmPageRef { page: page.into() })?;
    let file_failure = |e: std::io::Error| Failure::new(exit::OTHER, "File", e.to_string());
    let dir = std::env::temp_dir().join(format!("vibevalley-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(file_failure)?;
    let file = dir.join(format!("{}.md", source.page));
    std::fs::write(&file, &source.markdown).map_err(file_failure)?;
    let editor = std::env::var("VISUAL")
        .ok()
        .filter(|e| !e.is_empty())
        .or_else(|| std::env::var("EDITOR").ok().filter(|e| !e.is_empty()))
        .unwrap_or_else(|| "vi".into());
    let quoted = format!("'{}'", file.display().to_string().replace('\'', "'\\''"));
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} {quoted}"))
        .status()
        .map_err(|e| {
            Failure::new(
                exit::OTHER,
                "Editor",
                t("cli.pkm.editorFailed", &[("editor", editor.clone().into()), ("why", e.to_string().into())]),
            )
        })?;
    if !status.success() {
        let code = status.code().unwrap_or(-1) as i64;
        return Err(Failure::new(
            exit::OTHER,
            "Editor",
            t(
                "cli.pkm.editorExited",
                &[("editor", editor.into()), ("code", code.into()), ("file", file.display().to_string().into())],
            ),
        ));
    }
    let edited = std::fs::read_to_string(&file).map_err(file_failure)?;
    if edited == source.markdown {
        out(&t("cli.pkm.unchanged", &[("page", source.title.clone().into())]));
        return Ok(());
    }
    let update = PkmSourceUpdate {
        page: source.page.clone(),
        markdown: edited,
        updated: source.updated,
    };
    match ctx.ask::<ops::PkmSourceUpdate>(&update) {
        Ok(_) => {
            out(&t("cli.pkm.saved", &[("page", source.title.into())]));
            Ok(())
        }
        Err(mut f) if f.tag == "Refused" => {
            f.text = t("cli.pkm.keptAt", &[("why", f.text.clone().into()), ("file", file.display().to_string().into())]);
            Err(f)
        }
        Err(f) => Err(f),
    }
}
