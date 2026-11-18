use vibevalley_i18n::t;

use super::scene::{FarmScene, FarmTool};
use super::world::{BEDS, PLOT_H, VillageHit, YARD_PLACES};
use crate::pixel::draw::{Color, DrawList, HudOp, rgba};
use crate::pixel::sky::{FARM_CUT, clock_text, frame_whole};

const INK: Color = [0.23, 0.16, 0.10, 1.0];
const PAPER: Color = [0.99, 0.96, 0.88, 0.98];
const SELECTED: Color = [0.72, 0.85, 0.55, 1.0];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Panel {
    Ledger,
    Achievements,
    Log,
    Warehouse,
    Shop,
    Chat,
}

impl Panel {
    pub fn title(self) -> String {
        t(
            match self {
                Self::Ledger => "web.farm.native.ledger",
                Self::Achievements => "web.farm.native.achievements",
                Self::Log => "web.farm.native.log",
                Self::Warehouse => "web.farm.native.warehouse",
                Self::Shop => "web.farm.native.shop",
                Self::Chat => "web.farm.native.chat",
            },
            &[],
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Route(String),
    Map,
    Tree,
    Panel(Panel),
    Close,
    Page(i32),
    Phone,
    RestartSnake,
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
    pub nav: Vec<Rect>,
    pub tools: Vec<Rect>,
    pub panel: Rect,
    pub phone: Rect,
    pub rows: usize,
}
impl Layout {
    pub fn new(view: (f32, f32)) -> Self {
        let (w, h) = view;
        let columns = if w >= 650.0 { 6 } else { 3 };
        let nw = ((w - 24.0 - (columns - 1) as f32 * 4.0) / columns as f32).clamp(1.0, 100.0);
        let nav = (0..6)
            .map(|i| rect(12.0 + (i % columns) as f32 * (nw + 4.0), 74.0 + (i / columns) as f32 * 34.0, nw, 30.0))
            .collect();
        let sw = ((w - 24.0 - 20.0) / 6.0).clamp(1.0, 48.0);
        let start = (w - sw * 6.0 - 20.0) / 2.0;
        let tools = (0..6).map(|i| rect(start + i as f32 * (sw + 4.0), (h - 50.0).max(150.0), sw, 38.0)).collect();
        let pw = (w - 24.0).clamp(1.0, 430.0);
        let ph = (h - 40.0).clamp(1.0, 360.0);
        let panel = rect((w - pw) / 2.0, (h - ph) / 2.0, pw, ph);
        Self {
            nav,
            tools,
            panel,
            phone: rect(12.0, (h - 236.0).max(12.0), 216.0_f32.min(w - 24.0), 224.0),
            rows: ((ph - 90.0) / 42.0).max(1.0) as usize,
        }
    }
}

fn nav() -> [(Action, &'static str, &'static str); 6] {
    [
        (Action::Route("/issues".into()), "icon-tasks", "web.farm.native.workbench"),
        (Action::Map, "icon-map", "web.farm.native.map"),
        (Action::Tree, "icon-tree", "web.farm.native.tree"),
        (Action::Panel(Panel::Chat), "icon-board", "web.farm.native.chat"),
        (Action::Panel(Panel::Ledger), "icon-trophy", "web.farm.native.ledger"),
        (Action::Phone, "icon-bell", "web.farm.native.phone"),
    ]
}

pub fn hit(f: &FarmScene, x: f32, y: f32) -> Option<Action> {
    let l = Layout::new(f.view_size);
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
    if f.phone_open && l.phone.contains(x, y) {
        return Some(if rect(l.phone.x + l.phone.w - 28.0, l.phone.y, 28.0, 24.0).contains(x, y) {
            Action::Phone
        } else if f.snake.over {
            Action::RestartSnake
        } else {
            Action::Block
        });
    }
    for (i, b) in l.nav.iter().enumerate() {
        if b.contains(x, y) {
            return Some(nav()[i].0.clone());
        }
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
        Panel::Chat | Panel::Log => {
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
            .filter(|i| f.repo.is_none() || i.repo == f.repo)
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

pub fn draw(f: &FarmScene, list: &mut DrawList, scale: f32) {
    let l = Layout::new(f.view_size);
    let fr = frame_whole(f.view_size, (list.width, list.height), FARM_CUT);
    list.hud_view = true;
    let width = (f.view_size.0 - 24.0).clamp(1.0, 380.0);
    box_(list, rect(12.0, 12.0, width, 54.0), false);
    let level = &f.frame.view.level;
    text(
        list,
        rect(22.0, 18.0, width - 20.0, 18.0),
        t(
            "web.farm.native.progress",
            &[("level", level.level.into()), ("xp", level.xp.into()), ("need", level.need.into())],
        ),
        16.0,
    );
    text(
        list,
        rect(22.0, 42.0, width - 20.0, 16.0),
        format!("{} · {}", clock_text(f.clock.tod), f.repo.as_deref().unwrap_or("VibeValley")),
        12.0,
    );
    for (i, (_, image, key)) in nav().iter().enumerate() {
        let b = l.nav[i];
        box_(list, b, false);
        icon(f, list, image, rect(b.x + 5.0, b.y + 6.0, 18.0, 18.0));
        text(list, rect(b.x + 26.0, b.y + 9.0, b.w - 30.0, 16.0), t(key, &[]), 12.0);
    }
    for bed in BEDS {
        let at = f.world.plot_at(bed.index);
        if let Some(s) = f.frame.session_at_station(bed.station).filter(|s| f.repo.is_none() || s.repo == f.repo) {
            let badge = f.frame.plot_of(s).and_then(|p| p.badge.as_ref());
            let label = badge.map(|b| format!("{} · {}", s.name, b.text)).unwrap_or_else(|| s.name.clone());
            let w = (56.0 * scale).min(160.0).min(f.view_size.0 - 24.0);
            let b = rect(
                (fr.bx.x + at.x * scale - w / 2.0).clamp(12.0, (f.view_size.0 - w - 12.0).max(12.0)),
                fr.bx.y + (at.y - PLOT_H - 6.0) * scale - 20.0,
                w,
                18.0,
            );
            box_(list, b, false);
            text(list, rect(b.x + 4.0, b.y + 2.0, b.w - 8.0, 14.0), label, 12.0);
        }
    }
    if let Some(VillageHit::Spot(id)) = &f.hover
        && let Some(place) = YARD_PLACES.iter().find(|p| p.id == *id)
    {
        text(
            list,
            rect(12.0, if f.view_size.0 >= 650.0 { 112.0 } else { 146.0 }, f.view_size.0 - 24.0, 18.0),
            t(place.label, &[]),
            12.0,
        );
    }
    let b = l.tools[0];
    let status = f
        .toast
        .as_ref()
        .filter(|(_, until)| f.t < *until)
        .map(|(s, _)| s.clone())
        .unwrap_or_else(|| f.tool.label());
    box_(list, rect(12.0, b.y - 26.0, f.view_size.0 - 24.0, 22.0), false);
    text(list, rect(20.0, b.y - 22.0, f.view_size.0 - 40.0, 16.0), status, 12.0);
    for (i, b) in l.tools.iter().enumerate() {
        box_(list, *b, f.tool == FarmTool::ALL[i]);
        text(list, rect(b.x + 4.0, b.y + 4.0, 10.0, 12.0), (i + 1).to_string(), 11.0);
        icon(f, list, FarmTool::ALL[i].icon(), rect(b.x + b.w - 26.0, b.y + 9.0, 22.0, 22.0));
    }
    if f.phone_open {
        phone(f, list, l.phone);
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
    let last = rows(f, panel).len().saturating_sub(1) / Layout::new(f.view_size).rows;
    f.panel_page = f.panel_page.saturating_add_signed(by as isize).min(last);
}

fn phone(f: &FarmScene, list: &mut DrawList, p: Rect) {
    box_(list, p, false);
    text(list, rect(p.x + 10.0, p.y + 8.0, p.w - 40.0, 16.0), t("web.farm.native.phone", &[]), 12.0);
    text(list, rect(p.x + p.w - 38.0, p.y + 8.0, 32.0, 16.0), t("web.farm.native.close", &[]), 12.0);
    let cell = ((p.w - 24.0) / 16.0).min(12.0);
    let (x, y) = (p.x + 12.0, p.y + 30.0);
    list.hud.push(HudOp::Rect {
        x,
        y,
        w: 16.0 * cell,
        h: 10.0 * cell,
        color: rgba(0x9bbc0f, 1.0),
        border: Some(INK),
    });
    for (bx, by) in &f.snake.body {
        list.hud.push(HudOp::Rect {
            x: x + *bx as f32 * cell + 1.0,
            y: y + *by as f32 * cell + 1.0,
            w: cell - 2.0,
            h: cell - 2.0,
            color: INK,
            border: None,
        });
    }
    list.hud.push(HudOp::Rect {
        x: x + f.snake.bug.0 as f32 * cell + 1.0,
        y: y + f.snake.bug.1 as f32 * cell + 1.0,
        w: cell - 2.0,
        h: cell - 2.0,
        color: rgba(0xc4320a, 1.0),
        border: None,
    });
    text(
        list,
        rect(p.x + 12.0, p.y + 164.0, p.w - 24.0, 16.0),
        t("web.farm.native.score", &[("score", (f.snake.score as i64).into())]),
        12.0,
    );
    text(
        list,
        rect(p.x + 12.0, p.y + 190.0, p.w - 24.0, 16.0),
        t(if f.snake.over { "web.farm.native.restart" } else { "web.farm.native.steer" }, &[]),
        12.0,
    );
}
