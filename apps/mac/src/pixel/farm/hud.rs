mod chrome;
mod face;
mod sign;

use vibevalley_i18n::t;

use super::scene::{FarmScene, FarmTool};
use super::world::{BEDS, PLOT_H, VillageHit, YARD_PLACES};
use crate::pixel::draw::{Color, DrawList, HudOp, rgba};
use crate::pixel::sky::{FARM_CUT, clock_text, frame_whole};

const INK: Color = rgba(0x3a2a18, 1.0);
const PAPER: Color = [0.99, 0.96, 0.88, 0.98];
const SELECTED: Color = [0.72, 0.85, 0.55, 1.0];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Panel {
    Menu,
    Friends,
    Orchestrator,
    Quota,
    Ledger,
    Achievements,
    Log,
    Warehouse,
    Shop,
}

impl Panel {
    pub fn title(self) -> String {
        t(
            match self {
                Self::Menu => "web.farm.panel.menu",
                Self::Friends => "web.farm.friends.helpers",
                Self::Orchestrator => "web.farm.panel.orchestrator",
                Self::Quota => "web.farm.quota.left",
                Self::Ledger => "web.farm.native.ledger",
                Self::Achievements => "web.farm.native.achievements",
                Self::Log => "web.farm.native.log",
                Self::Warehouse => "web.farm.native.warehouse",
                Self::Shop => "web.farm.native.shop",
            },
            &[],
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Route(String),
    Tree,
    Panel(Panel),
    Close,
    Page(i32),
    Phone,
    Tool(FarmTool),
    Clock(f32),
    Block,
}

#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}
impl Rect {
    fn contains(self, x: f32, y: f32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}
fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
    Rect { x, y, w, h }
}

pub struct Layout {
    pub nav: Vec<chrome::Control>,
    pub tools: Vec<Rect>,
    pub panel: Rect,
    pub phone: Rect,
    pub rows: usize,
}
impl Layout {
    pub fn new(f: &FarmScene) -> Self {
        let (w, h) = f.view_size;
        let frame = frame_whole(f.view_size, (f.world.level.width, f.world.level.height), FARM_CUT);
        let (nav, tools, phone) = chrome::layout(f, frame);
        let pw = (w - 24.0).clamp(1.0, 430.0);
        let ph = (h - 40.0).clamp(1.0, 360.0);
        let panel = rect((w - pw) / 2.0, (h - ph) / 2.0, pw, ph);
        Self {
            nav,
            tools,
            panel,
            phone,
            rows: ((ph - 90.0) / 42.0).max(1.0) as usize,
        }
    }
}

pub fn hit(f: &FarmScene, x: f32, y: f32) -> Option<Action> {
    let l = Layout::new(f);
    if let Some(panel) = f.panel {
        let p = l.panel;
        if rect(p.x + p.w - 32.0, p.y, 32.0, 32.0).contains(x, y) {
            return Some(Action::Close);
        }
        if panel == Panel::Ledger {
            for (i, tod) in [0.30, 0.50, 0.76, 0.92].iter().enumerate() {
                if clock_button(p, i).contains(x, y) {
                    return Some(Action::Clock(*tod));
                }
            }
        } else {
            if rect(p.x, p.y + p.h - 30.0, p.w / 2.0, 30.0).contains(x, y) {
                return Some(Action::Page(-1));
            }
            if rect(p.x + p.w / 2.0, p.y + p.h - 30.0, p.w / 2.0, 30.0).contains(x, y) {
                return Some(Action::Page(1));
            }
            for (i, row) in rows(f, panel).iter().skip(f.panel_page * l.rows).take(l.rows).enumerate() {
                if rect(p.x + 10.0, p.y + 40.0 + i as f32 * 42.0, p.w - 20.0, 38.0).contains(x, y) {
                    return Some(row.2.clone().map(Action::Route).unwrap_or(Action::Block));
                }
            }
        }
        return Some(Action::Block);
    }
    if f.phone.open && l.phone.contains(x, y) {
        return Some(Action::Block);
    }
    for control in &l.nav {
        if control.bounds.contains(x, y) {
            return Some(control.action.clone());
        }
    }
    let fr = frame_whole(f.view_size, (f.world.level.width, f.world.level.height), FARM_CUT);
    if chrome::repo_sign(f, fr).contains(x, y) {
        return Some(Action::Route("/repos".into()));
    }
    for (i, b) in l.tools.iter().enumerate() {
        if b.contains(x, y) {
            return Some(Action::Tool(FarmTool::ALL[i]));
        }
    }
    None
}

fn box_(list: &mut DrawList, b: Rect, active: bool) {
    list.hud.push(HudOp::Rect {
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        color: if active { SELECTED } else { PAPER },
        border: Some(INK),
    });
}
fn text(list: &mut DrawList, b: Rect, value: impl Into<String>, size: f32) {
    list.hud.push(HudOp::TextIn {
        x: b.x,
        y: b.y,
        w: b.w,
        text: value.into(),
        size,
        color: INK,
    });
}
fn icon(f: &FarmScene, list: &mut DrawList, name: &str, b: Rect) {
    if let Some(image) = f.atlas.image(name) {
        list.hud.push(HudOp::Image {
            key: format!("hud:{name}"),
            image,
            x: b.x,
            y: b.y,
            w: b.w,
            h: b.h,
        });
    }
}
fn clock_button(p: Rect, i: usize) -> Rect {
    let w = (p.w - 28.0) / 4.0;
    rect(p.x + 8.0 + i as f32 * (w + 4.0), p.y + p.h - 44.0, w, 28.0)
}

type Row = (String, String, Option<String>);
fn rows(f: &FarmScene, panel: Panel) -> Vec<Row> {
    match panel {
        Panel::Menu => [
            ("web.farm.menu.chat", "/chat"),
            ("web.farm.menu.agents", "/agents"),
            ("web.farm.menu.runtimes", "/runtimes"),
            ("web.farm.menu.skills", "/settings/skills"),
            ("web.farm.menu.connectors", "/settings/chat"),
            ("web.farm.menu.repos", "/repos"),
            ("web.farm.menu.catalog", "/catalog"),
            ("web.farm.menu.issues", "/issues"),
        ]
        .into_iter()
        .map(|(key, path)| (t(key, &[]), String::new(), Some(path.into())))
        .collect(),
        Panel::Friends | Panel::Orchestrator => f
            .profiles
            .iter()
            .filter(|a| (a.role == vibevalley_protocol::AgentRole::Orchestrator) == (panel == Panel::Orchestrator))
            .map(|a| {
                (
                    a.name.clone(),
                    a.duty.clone(),
                    Some(if panel == Panel::Orchestrator {
                        "/orchestrator".into()
                    } else {
                        format!("/agents/{}", a.id)
                    }),
                )
            })
            .collect(),
        Panel::Quota => f
            .runtimes
            .iter()
            .map(|r| {
                (
                    r.preset.label.clone(),
                    r.quota.as_ref().map(|q| q.text.clone()).unwrap_or_default(),
                    Some("/runtimes".into()),
                )
            })
            .collect(),
        Panel::Log => {
            let mut channels: Vec<_> = f
                .frame
                .state
                .chat
                .channels
                .iter()
                .filter(|c| c.archived.is_none() && (panel == Panel::Log || c.parent.is_none()))
                .collect();
            channels.sort_by_key(|c| std::cmp::Reverse(c.last.as_ref().map(|m| m.at).unwrap_or(c.at)));
            channels
                .into_iter()
                .map(|c| {
                    (
                        if c.unread.unwrap_or(0) > 0 {
                            format!("{} ({})", c.title, c.unread.unwrap_or(0))
                        } else {
                            c.title.clone()
                        },
                        c.last
                            .as_ref()
                            .map(|m| format!("{}: {}", m.name, m.text.replace('\n', " ")))
                            .unwrap_or_else(|| t("web.farm.native.noMessages", &[])),
                        Some(format!("/chat/{}", c.id)),
                    )
                })
                .collect()
        }
        Panel::Warehouse => f
            .frame
            .state
            .issues
            .iter()
            .filter(|i| i.harvested() && (f.repo.is_none() || i.repo == f.repo))
            .map(|i| {
                (
                    format!("#{} {}", i.number.unwrap_or(0), i.title),
                    f.frame
                        .view
                        .plots
                        .get(&i.id)
                        .and_then(|p| p.badge.as_ref())
                        .map(|b| b.text.clone())
                        .unwrap_or_else(|| t(&format!("shared.status.{}", i.status), &[])),
                    Some(format!("/issues/{}", i.id)),
                )
            })
            .collect(),
        Panel::Achievements => f
            .achievements
            .iter()
            .map(|a| {
                let standing = f.frame.view.achievements.iter().find(|s| s.id == a.id);
                let progress = standing
                    .map(|s| match s.next {
                        Some(n) => format!("{} / {n}", s.count),
                        None => s.count.to_string(),
                    })
                    .unwrap_or_else(|| "0".into());
                (format!("{} · {progress}", a.title), a.detail.clone(), None)
            })
            .collect(),
        Panel::Shop => vec![(
            t("web.farm.native.shop", &[]),
            t(
                "web.farm.panel.shopClosed",
                &[("coins", f.frame.state.progress.as_ref().map(|p| p.coins).unwrap_or(0.0).into())],
            ),
            None,
        )],
        Panel::Ledger => Vec::new(),
    }
}

pub fn draw(f: &FarmScene, list: &mut DrawList, _scale: f32) {
    let l = Layout::new(f);
    let fr = frame_whole(f.view_size, (list.width, list.height), FARM_CUT);
    list.hud_view = true;
    let level = &f.frame.view.level;
    chrome::draw_overlay(f, list, fr);
    chrome::draw_controls(f, list, &l);
    if let Some((message, until)) = &f.toast
        && f.t < *until
    {
        let b = rect((f.view_size.0 - 240.0).max(0.0) / 2.0, l.tools[0].y - 30.0, 240.0_f32.min(f.view_size.0), 24.0);
        box_(list, b, false);
        text(list, rect(b.x + 8.0, b.y + 4.0, b.w - 16.0, 16.0), message, 12.0);
    }
    if let Some(panel) = f.panel {
        list.hud.push(HudOp::Rect {
            x: 0.0,
            y: 0.0,
            w: f.view_size.0,
            h: f.view_size.1,
            color: rgba(0x101810, 0.40),
            border: None,
        });
        let p = l.panel;
        box_(list, p, false);
        text(list, rect(p.x + 12.0, p.y + 10.0, p.w - 52.0, 20.0), panel.title(), 16.0);
        text(list, rect(p.x + p.w - 38.0, p.y + 10.0, 32.0, 16.0), t("web.farm.native.close", &[]), 12.0);
        if panel == Panel::Ledger {
            let coins = f.frame.state.progress.as_ref().map(|p| p.coins).unwrap_or(0.0);
            let values = [
                t(
                    "web.farm.native.progress",
                    &[("level", level.level.into()), ("xp", level.xp.into()), ("need", level.need.into())],
                ),
                t("web.farm.native.coins", &[("coins", coins.into())]),
                t("web.farm.native.workers", &[("count", (f.workers().len() as i64).into())]),
            ];
            for (i, value) in values.into_iter().enumerate() {
                text(list, rect(p.x + 12.0, p.y + 50.0 + i as f32 * 30.0, p.w - 24.0, 20.0), value, 12.0);
            }
            for (i, key) in ["dawn", "noon", "dusk", "night"].iter().enumerate() {
                let b = clock_button(p, i);
                box_(list, b, false);
                text(
                    list,
                    rect(b.x + 6.0, b.y + 8.0, b.w - 12.0, 16.0),
                    t(&format!("web.farm.native.{key}"), &[]),
                    12.0,
                );
            }
        } else {
            let values = rows(f, panel);
            if values.is_empty() {
                text(list, rect(p.x + 12.0, p.y + 50.0, p.w - 24.0, 20.0), t("web.farm.native.empty", &[]), 12.0);
            }
            list.hud.push(HudOp::Clip(Some([p.x + 8.0, p.y + 36.0, p.w - 16.0, p.h - 70.0])));
            for (i, (title, detail, route)) in values.iter().skip(f.panel_page * l.rows).take(l.rows).enumerate() {
                let y = p.y + 40.0 + i as f32 * 42.0;
                if route.is_some() {
                    box_(list, rect(p.x + 10.0, y, p.w - 20.0, 38.0), false);
                }
                text(list, rect(p.x + 16.0, y + 3.0, p.w - 32.0, 16.0), title, 12.0);
                text(list, rect(p.x + 16.0, y + 21.0, p.w - 32.0, 16.0), detail, 12.0);
            }
            list.hud.push(HudOp::Clip(None));
            text(
                list,
                rect(p.x + 12.0, p.y + p.h - 22.0, p.w / 2.0 - 20.0, 16.0),
                t("web.farm.native.previous", &[]),
                12.0,
            );
            text(
                list,
                rect(p.x + p.w / 2.0, p.y + p.h - 22.0, p.w / 2.0 - 12.0, 16.0),
                t(
                    "web.farm.native.next",
                    &[
                        ("page", ((f.panel_page + 1) as i64).into()),
                        ("pages", (values.len().div_ceil(l.rows).max(1) as i64).into()),
                    ],
                ),
                12.0,
            );
        }
    }
}

pub fn page(f: &mut FarmScene, by: i32) {
    let Some(panel) = f.panel else { return };
    let last = rows(f, panel).len().saturating_sub(1) / Layout::new(f).rows;
    f.panel_page = f.panel_page.saturating_add_signed(by as isize).min(last);
}
