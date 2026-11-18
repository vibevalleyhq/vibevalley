use super::*;
use crate::pixel::sky::Framing;
use unicode_width::UnicodeWidthStr;
use vibevalley_protocol::{Agent, AgentRole};

const PAPER: Color = rgba(0xf3e2b8, 1.0);
const MUTED: Color = rgba(0x776046, 1.0);

fn word_width(s: &str, size: f32) -> f32 {
    s.width() as f32 * size * 0.5
}

fn translate(key: &str) -> String {
    t(key, &[])
}

fn paint(list: &mut DrawList, b: Rect, color: Color) {
    list.hud.push(HudOp::Rect {
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        color,
        border: None,
    });
}

fn card(list: &mut DrawList, b: Rect, paper: Color) {
    paint(list, rect(b.x + 2.0, b.y + 2.0, b.w, b.h), rgba(0x3a2a18, 0.6));
    paint(list, b, INK);
    paint(list, rect(b.x + 2.0, b.y + 2.0, b.w - 4.0, b.h - 4.0), paper);
}

fn label(list: &mut DrawList, x: f32, y: f32, value: impl Into<String>, size: f32, color: Color) {
    list.hud.push(HudOp::Text {
        x,
        y,
        text: value.into(),
        size,
        color,
    });
}

fn sprite(f: &FarmScene, list: &mut DrawList, name: &str, x: f32, y: f32, size: f32) {
    if let Some(info) = f.atlas.get(name) {
        let k = size / info.w.max(info.h);
        let (w, h) = ((info.w * k).round(), (info.h * k).round());
        icon(f, list, name, rect(x + ((size - w) / 2.0).round(), y + ((size - h) / 2.0).round(), w, h));
    }
}

#[derive(Clone, Debug)]
enum Part {
    Button { icon: &'static str, title: String, size: f32 },
    Portrait,
    Level,
    Phone,
    Friends,
}

#[derive(Clone, Debug)]
pub struct Control {
    pub bounds: Rect,
    pub action: Action,
    part: Part,
}

fn button(action: Action, icon: &'static str, title: &str, size: f32) -> (Action, Part, f32) {
    let width = word_width(title, 12.0) + if icon.is_empty() { 16.0 } else { 24.0 + size };
    (
        action,
        Part::Button {
            icon,
            title: title.into(),
            size,
        },
        width,
    )
}

fn helpers(f: &FarmScene) -> Vec<&Agent> {
    let mut helpers: Vec<_> = f.profiles.iter().filter(|a| a.role == AgentRole::Worker).collect();
    helpers.sort_by_key(|a| (!f.frame.state.sessions.iter().any(|s| s.agent == a.id), !a.enabled));
    helpers
}

fn helper_faces_width(f: &FarmScene) -> f32 {
    match helpers(f).len().min(3) {
        0 => 0.0,
        n => 22.0 + (n - 1) as f32 * 12.0,
    }
}

fn quota(f: &FarmScene) -> Option<f64> {
    f.runtimes
        .iter()
        .filter_map(|r| r.quota.as_ref()?.left.map(|left| left.get()))
        .min_by(f64::total_cmp)
}

fn bottle(left: Option<f64>) -> &'static str {
    match left {
        None => "energy-unknown",
        Some(v) if v >= 87.5 => "energy-plenty-100",
        Some(v) if v >= 62.5 => "energy-plenty-75",
        Some(v) if v >= 50.0 => "energy-plenty-50",
        Some(v) if v >= 32.5 => "energy-low-40",
        Some(v) if v >= 20.0 => "energy-low-25",
        Some(v) if v > 2.0 => "energy-empty-10",
        _ => "energy-empty-0",
    }
}

pub fn layout(f: &FarmScene, frame: Framing) -> (Vec<Control>, Vec<Rect>, Rect) {
    let compact = frame.shown.w < 680.0;
    let b = if compact {
        rect(0.0, 0.0, f.view_size.0, f.view_size.1)
    } else {
        rect(frame.shown.x, frame.shown.y, frame.shown.w, frame.shown.h)
    };
    let left = b.x + 8.0;
    let right = b.x + b.w - 10.0;
    let top = b.y + 8.0;
    let bottom = b.y + b.h - 10.0;
    let mut nav = Vec::new();
    let mut x = left;
    let left_buttons = [
        (Action::Panel(Panel::Orchestrator), Part::Portrait, 54.0),
        (Action::Panel(Panel::Achievements), Part::Level, 166.0),
        button(Action::Route("/issues".into()), "icon-tasks", &translate("web.farm.hud.workbench"), 20.0),
    ];
    for (action, part, width) in left_buttons {
        nav.push(Control {
            action,
            part,
            bounds: rect(x, top, width, 52.0),
        });
        x += width + 6.0;
    }
    let mut right_buttons = vec![
        button(Action::Tree, "icon-tree", &translate("web.farm.hud.tree"), 20.0),
        button(Action::Route("/chat".into()), "icon-board", &translate("web.farm.chat.channels"), 20.0),
    ];
    if !f.runtimes.is_empty() {
        let pct = quota(f);
        let title = pct.map(|v| format!("{v:.0}%")).unwrap_or_else(|| translate("web.farm.quota.quota"));
        right_buttons.push(button(Action::Panel(Panel::Quota), bottle(pct), &title, 28.0));
    }
    right_buttons.push(button(
        Action::Panel(Panel::Menu),
        "",
        &format!("{} Esc", translate("web.farm.panel.menu")),
        0.0,
    ));
    x = if compact {
        left
    } else {
        right - right_buttons.iter().map(|b| b.2 + 6.0).sum::<f32>() + 6.0
    };
    let mut y = if compact { top + 56.0 } else { top };
    for (action, part, width) in right_buttons {
        if x + width > right + 1.0 && compact && x > left {
            x = left;
            y += 58.0;
        }
        nav.push(Control {
            action,
            part,
            bounds: rect(x, y, width, 52.0),
        });
        x += width + 6.0;
    }
    let button_y = bottom - 36.0 - if compact { 40.0 } else { 0.0 };
    let phone_w = 32.0 + word_width(&translate("web.farm.phone.phone"), 12.0);
    nav.push(Control {
        action: Action::Phone,
        part: Part::Phone,
        bounds: rect(left, button_y - 42.0, phone_w, 36.0),
    });
    nav.push(Control {
        action: Action::Panel(Panel::Friends),
        part: Part::Friends,
        bounds: rect(
            left,
            button_y,
            40.0 + helper_faces_width(f) + word_width(&translate("web.farm.friends.helpers"), 12.0),
            36.0,
        ),
    });
    let room = (b.h - 16.0 - 52.0 - 72.0 - 16.0).max(1.0);
    let narrow = b.w - 16.0 < 640.0;
    let chat_only = narrow && f.phone.unfolded;
    let game = f.phone.game && !chat_only;
    let chrome_h = if game {90.0} else {34.0};
    let preferred: f32 = if f.phone.unfolded && f.phone.large {680.0} else if game || f.phone.unfolded || f.phone.ringing.is_some() {440.0} else {300.0};
    let screen_h = preferred.min(room-chrome_h).max(200.0);
    let apps_w = if game {332.0} else if f.phone.unfolded {296.0} else {212.0};
    let width = if chat_only {b.w-16.0} else if f.phone.unfolded {24.0+apps_w+2.0+if f.phone.large {(b.w-396.0).clamp(320.0,560.0)}else{320.0}} else {24.0+apps_w+32.0};
    let phone_h = screen_h + chrome_h;
    let phone = rect(left, (button_y - 48.0 - phone_h).max(0.0), width.min(b.w-16.0), phone_h);
    let width = if compact { 44.0 } else { 52.0 };
    let span = 6.0 * width + 5.0 * 6.0 + 2.0;
    let start = (b.x + (b.w - span) / 2.0).round();
    let tools = (0..6).map(|i| rect(start + i as f32 * (width + 6.0), bottom - 36.0, width, 36.0)).collect();
    (nav, tools, phone)
}

pub(super) fn draw_controls(f: &FarmScene, list: &mut DrawList, layout: &Layout) {
    for control in &layout.nav {
        let b = control.bounds;
        card(list, b, PAPER);
        match &control.part {
            Part::Button { icon, title, size } => {
                if !icon.is_empty() {
                    sprite(f, list, icon, b.x + 10.0, b.y + (b.h - size) / 2.0, *size);
                }
                label(
                    list,
                    b.x + if icon.is_empty() { 8.0 } else { 14.0 + size },
                    b.y + (b.h - 16.0) / 2.0,
                    title,
                    12.0,
                    INK,
                );
            }
            Part::Portrait => {
                let look = f
                    .profiles
                    .iter()
                    .find(|a| a.role == AgentRole::Orchestrator)
                    .and_then(|a| a.look.orchestrator)
                    .map(|l| l.as_str())
                    .unwrap_or("farmer");
                let name = if look == "farmer" {
                    "manager-face".into()
                } else {
                    format!("manager-{look}-face")
                };
                sprite(f, list, &name, b.x + 5.0, b.y + 4.0, 44.0);
            }
            Part::Level => {
                let level = &f.frame.view.level;
                let x = b.x + 8.0;
                let y = b.y + 5.0;
                let lv = format!("Lv.{:.0}", level.level);
                label(list, x, y, &lv, 12.0, rgba(0x3f6b2a, 1.0));
                let coin_x = x + word_width(&lv, 12.0) + 3.0;
                sprite(f, list, "icon-coin", coin_x, y + 1.0, 12.0);
                let coins = format!("{:.0}", f.frame.state.progress.as_ref().map(|p| p.coins).unwrap_or_default());
                label(list, coin_x + 15.0, y, &coins, 12.0, INK);
                let clock_x = coin_x + 18.0 + word_width(&coins, 12.0);
                sprite(f, list, "icon-clock", clock_x, y + 1.0, 12.0);
                label(list, clock_x + 15.0, y, clock_text(f.clock.tod), 12.0, INK);
                let bar = rect(x, b.y + 23.0, 150.0, 6.0);
                paint(list, bar, rgba(0xe2c995, 1.0));
                paint(
                    list,
                    rect(
                        bar.x,
                        bar.y,
                        bar.w
                            * if level.need > 0.0 {
                                (level.xp / level.need).clamp(0.0, 1.0) as f32
                            } else {
                                0.0
                            },
                        bar.h,
                    ),
                    rgba(0x7ea64f, 1.0),
                );
                let next = BEDS.iter().filter_map(|b| b.unlock_level).find(|&n| n as f64 > level.level);
                let params = [
                    ("xp", level.xp.into()),
                    ("need", level.need.into()),
                    ("next", i64::from(next.unwrap_or_default()).into()),
                ];
                label(
                    list,
                    x,
                    b.y + 30.0,
                    t(if next.is_some() { "web.farm.hud.toLevelNext" } else { "web.farm.hud.toLevel" }, &params),
                    12.0,
                    MUTED,
                );
            }
            Part::Phone => {
                let x = b.x + 8.0;
                let y = b.y + 8.0;
                for (dx, dy, w, h, color) in [
                    (1, 0, 8, 16, 0x2f1f13),
                    (2, 1, 6, 14, 0x67482d),
                    (3, 2, 4, 5, 0x9fb07a),
                    (3, 9, 1, 1, 0xe2c995),
                    (5, 9, 1, 1, 0xe2c995),
                    (3, 11, 1, 1, 0xe2c995),
                    (5, 11, 1, 1, 0xe2c995),
                    (3, 13, 3, 1, 0xe2c995),
                    (8, 1, 1, 3, 0x2f1f13),
                ] {
                    paint(
                        list,
                        rect(x + dx as f32 * 1.25, y + dy as f32 * 1.25, w as f32 * 1.25, h as f32 * 1.25),
                        rgba(color, 1.0),
                    );
                }
                label(list, x + 16.0, b.y + 10.0, translate("web.farm.phone.phone"), 12.0, INK);
            }
            Part::Friends => {
                let helpers = helpers(f);
                for (i, a) in helpers.iter().take(3).enumerate().collect::<Vec<_>>().into_iter().rev() {
                    let look = super::super::scene::cast_prefix(f.agent_looks.get(&a.id).map(|(s, o)| (s.as_str(), o.as_str())), &a.id, &f.atlas);
                    let bounds = rect(b.x + 10.0 + i as f32 * 12.0, b.y + 7.0, 22.0, 22.0);
                    paint(list, bounds, rgba(0xb4cb7c, 0.6));
                    list.hud.push(HudOp::Clip(Some([bounds.x, bounds.y, bounds.w, bounds.h])));
                    sprite(f, list, &format!("{look}-down"), bounds.x - 11.0, bounds.y - 2.0, 44.0);
                    list.hud.push(HudOp::Clip(None));
                }
                let x = b.x + 14.0 + helper_faces_width(f);
                label(list, x, b.y + 10.0, translate("web.farm.friends.helpers"), 12.0, INK);
                let cx = b.x + b.w - 17.0;
                for (i, w) in [10.0, 8.0, 6.0, 4.0, 2.0].iter().enumerate() {
                    paint(list, rect(cx - w / 2.0, b.y + 15.0 + i as f32, *w, 1.0), INK);
                }
            }
        }
    }
    for (i, b) in layout.tools.iter().enumerate() {
        let tool = FarmTool::ALL[i];
        card(list, *b, if f.tool == tool { rgba(0xb4cb7c, 1.0) } else { rgba(0xeedcb2, 1.0) });
        let x = b.x + (b.w - 33.0) / 2.0;
        label(list, x, b.y + 10.0, (i + 1).to_string(), 12.0, MUTED);
        sprite(f, list, tool.icon(), x + 9.0, b.y + 6.0, 24.0);
    }
}

pub(super) fn repo_sign(f: &FarmScene, fr: Framing) -> Rect {
    let foot = (fr.bx.x + 44.0 * fr.scale, fr.bx.y + 104.0 * fr.scale);
    let name = f.repo.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| translate("web.farm.sign.noRepo"));
    let w = (word_width(&name, 14.0) + 24.0).clamp(42.0, 160.0);
    rect((foot.0 - w / 2.0).round(), foot.1 - 5.0 * fr.scale - 40.0, w, 40.0)
}

pub(super) fn draw_overlay(f: &FarmScene, list: &mut DrawList, fr: Framing) {
    let at = |x: f32, y: f32| ((fr.bx.x + x * fr.scale).round(), (fr.bx.y + y * fr.scale).round());
    let pin = |list: &mut DrawList, x: f32, y: f32, s: &str, paper: Color| {
        let w = word_width(s, 12.0) + 16.0;
        let b = rect((x - w / 2.0).round(), y - 22.0, w, 22.0);
        card(list, b, paper);
        label(list, b.x + 8.0, b.y + 3.0, s, 12.0, INK);
    };
    for bed in BEDS {
        let p = f.world.plot_at(bed.index);
        let (x, y) = at(p.x, p.y - PLOT_H / 2.0);
        let session = f
            .frame
            .state
            .sessions
            .iter()
            .find(|s| s.is_worker() && (f.repo.is_none() || s.repo == f.repo) && bed.station >= 0 && f.frame.station_of(s) == bed.station);
        if let Some(s) = session {
            let badge = f.frame.plot_of(s).and_then(|p| p.badge.as_ref());
            if let Some(b) = badge {
                let paper = match b.tone.as_str() {
                    "ripe" => 0xe8b84a,
                    "bug" => 0xb44b36,
                    "stuck" => 0x4a728c,
                    "wait" => 0xb4cb7c,
                    _ => 0xf3e2b8,
                };
                pin(list, x, at(p.x, p.y - PLOT_H + 5.0).1 - 2.0, &b.text, rgba(paper, 1.0));
            } else if let Some(repo) = &s.repo {
                pin(list, x, at(p.x, p.y - PLOT_H + 5.0).1 - 2.0, repo, PAPER);
            }
        } else if let Some(level) = bed.unlock_level
            && f.frame.view.level.level < level as f64
        {
            pin(list, x, y + 11.0, &t("web.farm.overlay.clearAt", &[("level", i64::from(level).into())]), PAPER);
        }
    }
    for (i, (id, bx)) in f.world.spot_boxes.iter().enumerate() {
        let top = if bx.y0 < 20.0 { bx.y0 + 30.0 } else { bx.y0 };
        let (x, y) = at((bx.x0 + bx.x1) / 2.0, top);
        if let Some(place) = YARD_PLACES.iter().find(|p| p.id == *id)
            && (f.reveal_names || matches!(&f.hover,Some(VillageHit::Spot(s)) if s==id))
        {
            pin(list, x, y - 4.0, &translate(place.label), PAPER);
            continue;
        }
        let name = match *id {
            "shop" => "icon-shop",
            "warehouse" => "icon-crate",
            "tasks" => "icon-tasks",
            "log" => "icon-log",
            "taskBoard" => "icon-task-board",
            "agents" => "icon-board",
            "runtimes" => "machine-tractor",
            "skills" => "icon-skillbook",
            _ => continue,
        };
        if let Some(info) = f.atlas.get(name) {
            let h = 30.0;
            let w = 22.0 * info.w / info.h + 8.0;
            let hop = ((f.t - i as f32 * 0.8) * 2.0).sin().max(0.0) * 2.0;
            let b = rect((x - w / 2.0).round(), (y - 3.0 * fr.scale - h - hop).round(), w, h);
            card(list, b, rgba(0xb07a45, 1.0));
            icon(f, list, name, rect(b.x + 4.0, b.y + 4.0, w - 8.0, 22.0));
        }
    }
    let m = f.world.orchestrator;
    if f.frame.state.sessions.is_empty() && !f.reveal_names {
        let (x, y) = at(m.x, m.y - 34.0);
        pin(list, x, y - 4.0, &translate("web.farm.overlay.idle"), PAPER);
    }
    for s in &f.frame.state.sessions {
        if let Some(p) = f.helper_feet(&s.id) {
            let doing = s.doing().unwrap_or("none");
            let named = s.phase.tag == "working" && s.runs == 0;
            if doing == "none" && !named {
                continue;
            }
            let image = format!("act-{doing}");
            let iw = if f.atlas.has(&image) { 18.0 } else { 0.0 };
            let w = 8.0 + iw + if named { word_width(&s.name, 12.0) + 3.0 } else { 0.0 };
            let (x, y) = at(p.x, p.y - 31.0);
            let b = rect((x - w / 2.0).round(), y - 28.0, w, 26.0);
            card(list, b, PAPER);
            sprite(f, list, &image, b.x + 4.0, b.y + 4.0, iw);
            if named {
                label(list, b.x + 4.0 + iw + 3.0, b.y + 5.0, &s.name, 12.0, INK);
            }
        }
    }
    let b = repo_sign(f, fr);
    paint(list, rect(b.x + b.w / 2.0 - 3.0, b.y + b.h, 6.0, 5.0 * fr.scale), rgba(0x2f1f13, 1.0));
    card(list, b, rgba(0x7f5b3b, 1.0));
    let name = f.repo.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| translate("web.farm.sign.noRepo"));
    let title = translate("web.farm.sign.repo");
    label(list, b.x + (b.w - word_width(&title, 10.0)) / 2.0, b.y + 4.0, title, 10.0, rgba(0xe2c995, 1.0));
    label(list, b.x + (b.w - word_width(&name, 14.0)) / 2.0, b.y + 17.0, name, 14.0, rgba(0xf7e8c4, 1.0));
}
