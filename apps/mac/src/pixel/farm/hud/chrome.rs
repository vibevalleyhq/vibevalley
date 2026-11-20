use super::*;
use crate::pixel::level::pt;
use crate::pixel::projection::ground;
use crate::pixel::sky::Framing;
use vibevalley_protocol::{Agent, AgentRole};

const PAPER: Color = rgba(0xf3e2b8, 1.0);
const MUTED: Color = rgba(0x776046, 1.0);

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
    framed_card(list, b, paper, INK);
}

fn framed_card(list: &mut DrawList, b: Rect, paper: Color, border: Color) {
    paint(list, rect(b.x + 2.0, b.y + 2.0, b.w, b.h), rgba(0x3a2a18, 0.6));
    paint(list, b, border);
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
        let (w, h) = (info.w * k, info.h * k);
        // CSS object-fit snaps both edges of the contained image in logical pixels.
        let left = (x + (size - w) / 2.).round();
        let top = (y + (size - h) / 2.).round();
        let right = (x + (size + w) / 2.).round();
        let bottom = (y + (size + h) / 2.).round();
        icon(f, list, name, rect(left, top, right - left, bottom - top));
    }
}

#[derive(Clone, Debug)]
enum Part {
    Button {
        icon: &'static str,
        title: String,
        size: f32,
        unread: i64,
    },
    Menu,
    Portrait,
    Level,
    Phone,
    Friends {
        busy: usize,
        stage: Option<Color>,
    },
}

#[derive(Clone, Debug)]
pub struct Control {
    pub bounds: Rect,
    pub action: Action,
    part: Part,
}

fn unread(f: &FarmScene) -> i64 {
    f.frame.state.chat.channels.iter().filter_map(|c| c.unread).sum()
}

fn button(action: Action, icon: &'static str, title: &str, size: f32, unread: i64) -> (Action, Part, f32) {
    let badge = if unread > 0 {
        12. + crate::pixel::font::width(&unread.to_string(), 10.)
    } else {
        0.
    };
    let width = crate::pixel::font::width(title, 12.) + size + 24. + badge;
    (
        action,
        Part::Button {
            icon,
            title: title.into(),
            size,
            unread,
        },
        width,
    )
}

fn helpers(f: &FarmScene) -> Vec<&Agent> {
    let mut helpers: Vec<_> = f.profiles.iter().filter(|a| a.role == AgentRole::Worker).collect();
    helpers.sort_by_key(|a| !a.enabled);
    helpers
}

fn friend_activity(f: &FarmScene) -> (usize, Option<Color>) {
    use super::super::frame::Crop;
    let mut busy = 0;
    let mut stage = None;
    for agent in f.profiles.iter().filter(|a| a.role == AgentRole::Worker) {
        let mine = f.frame.state.sessions.iter().filter(|s| s.agent == agent.id);
        let crops = mine.clone().filter_map(|s| f.frame.plot_of(s)).map(|p| p.crop);
        if crops.clone().any(|crop| crop == Crop::Withered) {
            stage = Some(rgba(0xc84a3a, 1.));
        } else if crops.clone().any(|crop| crop == Crop::Dry) {
            stage.get_or_insert(rgba(0xd97426, 1.));
        } else if crops.clone().any(super::super::world::is_ripe) {
            stage.get_or_insert(rgba(0xe5a93c, 1.));
        } else if mine.into_iter().any(|s| s.phase.tag == "working") {
            busy += 1;
        }
    }
    (busy, stage)
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
        button(Action::Route("/issues".into()), "icon-tasks", &translate("web.farm.hud.workbench"), 20.0, 0),
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
        button(Action::Tree, "icon-tree", &translate("web.farm.hud.tree"), 20.0, 0),
        button(
            Action::Route("/chat".into()),
            "icon-board",
            &translate("web.farm.chat.channels"),
            20.0,
            unread(f),
        ),
    ];
    if !f.runtimes.is_empty() {
        let pct = quota(f);
        let title = pct.map(|v| format!("{v:.0}%")).unwrap_or_else(|| translate("web.farm.quota.quota"));
        right_buttons.push(button(Action::Panel(Panel::Quota), bottle(pct), &title, 28.0, 0));
    }
    right_buttons.push((
        Action::Panel(Panel::Menu),
        Part::Menu,
        19. + crate::pixel::font::width(&translate("web.farm.panel.menu"), 12.) + crate::pixel::font::width("Esc", 12.),
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
    let phone_word = translate(if f.phone.ringing.is_some() {
        "web.farm.phone.ring"
    } else {
        "web.farm.phone.phone"
    });
    let phone_w = 31.5 + crate::pixel::font::width(&phone_word, 12.);
    nav.push(Control {
        action: Action::Phone,
        part: Part::Phone,
        bounds: rect(left, button_y - 42.0, phone_w, 36.0),
    });
    let (busy, stage) = friend_activity(f);
    let count_w = if busy == 0 {
        0.
    } else {
        4. + (8. + crate::pixel::font::width(&busy.to_string(), 10.)).max(16.)
    };
    nav.push(Control {
        action: Action::Panel(Panel::Friends),
        part: Part::Friends { busy, stage },
        bounds: rect(
            left,
            button_y,
            40.0 + helper_faces_width(f) + crate::pixel::font::width(&translate("web.farm.friends.helpers"), 12.0) + count_w,
            36.0,
        ),
    });
    let room = (b.h - 16.0 - 52.0 - 72.0 - 16.0).max(1.0);
    let narrow = b.w - 16.0 < 640.0;
    let chat_only = narrow && f.phone.unfolded;
    let game = f.phone.game && !chat_only;
    let chrome_h = if game { 90.0 } else { 34.0 };
    let preferred: f32 = if f.phone.unfolded && f.phone.large {
        680.0
    } else if game || f.phone.unfolded || f.phone.ringing.is_some() {
        440.0
    } else {
        300.0
    };
    let screen_h = preferred.min(room - chrome_h).max(200.0);
    let apps_w = if game {
        332.0
    } else if f.phone.unfolded {
        296.0
    } else {
        212.0
    };
    let width = if chat_only {
        b.w - 16.0
    } else if f.phone.unfolded {
        24.0 + apps_w + 2.0 + if f.phone.large { (b.w - 396.0).clamp(320.0, 560.0) } else { 320.0 }
    } else {
        24.0 + apps_w + 32.0
    };
    let phone_h = screen_h + chrome_h;
    let phone = rect(left, (button_y - 48.0 - phone_h).max(0.0), width.min(b.w - 16.0), phone_h);
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
            Part::Button { icon, title, size, unread } => {
                sprite(f, list, icon, b.x + 10., b.y + (b.h - size) / 2., *size);
                let x = b.x + 14. + size;
                let y = b.y + (b.h - 20.) / 2.;
                label(list, x, line_top(y, 12., 20.), title, 12., INK);
                if *unread > 0 {
                    let text = unread.to_string();
                    let x = x + crate::pixel::font::width(title, 12.) + 4.;
                    let width = 8. + crate::pixel::font::width(&text, 10.);
                    paint(list, rect(x, y, width, 20.), rgba(0xa83a2c, 1.));
                    label(list, x + 4., line_top(y, 10., 20.), text, 10., rgba(0xf7e8c4, 1.));
                }
            }
            Part::Menu => {
                let title = translate("web.farm.panel.menu");
                let x = b.x + 8.;
                let y = line_top(b.y + (b.h - 14.) / 2., 12., 14.);
                label(list, x, y, &title, 12., INK);
                label(list, x + crate::pixel::font::width(&title, 12.) + 3., y, "Esc", 12., MUTED);
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
                let y = b.y + 7.0;
                let lv = format!("Lv.{:.0}", level.level);
                label(list, x, line_top(y, 12., 14.), &lv, 12.0, rgba(0x3f6b2a, 1.0));
                let coin_x = x + crate::pixel::font::width(&lv, 12.0) + 3.0;
                sprite(f, list, "icon-coin", coin_x, y + 1.0, 12.0);
                let coins = format!("{:.0}", f.frame.state.progress.as_ref().map(|p| p.coins).unwrap_or_default());
                label(list, coin_x + 15.0, line_top(y, 12., 14.), &coins, 12.0, rgba(0x2f1f13, 1.));
                let clock_x = coin_x + 18.0 + crate::pixel::font::width(&coins, 12.0);
                sprite(f, list, "icon-clock", clock_x, y + 1.0, 12.0);
                label(list, clock_x + 15.0, line_top(y, 12., 14.), clock_text(f.clock.tod), 12.0, rgba(0x2f1f13, 1.));
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
                    line_top(b.y + 31., 12., 14.),
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
                    (3, 2, 4, 5, if f.phone.ringing.is_some() { 0xb4e07a } else { 0x9fb07a }),
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
                let title = if f.phone.ringing.is_some() {
                    paint(list, rect(x + 11.25, y, 1.25, 1.25), rgba(0xc84a3a, 1.));
                    "web.farm.phone.ring"
                } else {
                    "web.farm.phone.phone"
                };
                label(list, x + 15.5, line_top(b.y + 11., 12., 14.), translate(title), 12., INK);
                let missed = f.phone.missed(&f.frame.inbox).count() as i64;
                let badge_text = if missed > 0 {
                    Some((missed.to_string(), 0xc84a3a))
                } else if !f.phone.unfolded && unread(f) > 0 {
                    Some((translate("web.farm.phone.new"), 0xa83a2c))
                } else {
                    None
                };
                if let Some((text, color)) = badge_text {
                    let width = 8. + crate::pixel::font::width(&text, 10.);
                    let badge = rect(b.x + b.w + 8. - width, b.y - 6., width, 14.);
                    paint(list, badge, rgba(color, 1.));
                    label(list, badge.x + 4., line_top(badge.y, 10., 14.), text, 10., rgba(0xf7e8c4, 1.));
                }
            }
            Part::Friends { busy, stage } => {
                let helpers = helpers(f);
                for (i, a) in helpers.iter().take(3).enumerate().collect::<Vec<_>>().into_iter().rev() {
                    let look = super::super::scene::cast_prefix(f.agent_looks.get(&a.id).map(|(s, o)| (s.as_str(), o.as_str())), &a.id, &f.atlas);
                    let logo = format!("logo-{}", a.runtime);
                    let logo = if f.atlas.has(&logo) { &logo } else { "icon-wrench" };
                    let face = super::face::HelperFace {
                        head: f.atlas.image(&format!("{look}-down")),
                        logo: f.atlas.image(logo),
                    };
                    list.hud.push(HudOp::Bitmap {
                        key: format!("helper-face:{look}:{logo}"),
                        x: b.x + 10. + i as f32 * 12.,
                        y: b.y + 7.,
                        w: super::face::HelperFace::SIZE,
                        h: super::face::HelperFace::SIZE,
                        render: std::sync::Arc::new(move |w, _| face.paint(w)),
                    });
                }
                let x = b.x + 14.0 + helper_faces_width(f);
                label(list, x, line_top(b.y + 8., 12., 20.), translate("web.farm.friends.helpers"), 12., INK);
                if *busy > 0 {
                    let text = busy.to_string();
                    let width = (8. + crate::pixel::font::width(&text, 10.)).max(16.);
                    let count = rect(b.x + b.w - 26. - width, b.y + 10., width, 16.);
                    paint(list, count, rgba(0x74a046, 1.));
                    label(
                        list,
                        count.x + (count.w - crate::pixel::font::width(&text, 10.)) / 2.,
                        line_top(count.y, 10., 16.),
                        text,
                        10.,
                        rgba(0x2f1f13, 1.),
                    );
                }
                if let Some(color) = stage {
                    paint(list, rect(b.x - 4., b.y - 4., 10., 10.), rgba(0xc8a46e, 1.));
                    paint(list, rect(b.x - 2., b.y - 2., 6., 6.), *color);
                }
                if let Some(arrows) = &f.friend_arrows {
                    let open = f.panel == Some(Panel::Friends);
                    let image = &arrows[usize::from(open)];
                    let h = 12. * image.height() as f32 / image.width() as f32;
                    let y = (b.y + (b.h - h) / 2.).round();
                    list.hud.push(HudOp::Image {
                        key: format!("friend-arrow-{open}"),
                        image: image.clone(),
                        x: b.x + b.w - 22.,
                        y,
                        w: 12.,
                        h: (b.y + (b.h + h) / 2.).round() - y,
                    });
                }
            }
        }
    }
    for (i, b) in layout.tools.iter().enumerate() {
        let tool = FarmTool::ALL[i];
        card(list, *b, if f.tool == tool { rgba(0xb4cb7c, 1.0) } else { rgba(0xeedcb2, 1.0) });
        let x = b.x + (b.w - 33.0) / 2.0;
        label(list, x, line_top(b.y + 8., 12., 20.), (i + 1).to_string(), 12.0, MUTED);
        sprite(f, list, tool.icon(), x + 9.0, b.y + 6.0, 24.0);
    }
}

fn hover_action(
    f: &FarmScene,
    bed: super::super::world::Bed,
    crop: super::super::frame::Crop,
    session: Option<&super::super::frame::Session>,
) -> (bool, String) {
    use super::super::frame::Crop;
    use vibevalley_protocol::IssueAction;
    if let Some(level) = bed.unlock_level {
        return (
            false,
            if crop == Crop::Locked {
                t("web.farm.aim.clearAt", &[("level", i64::from(level).into())])
            } else {
                translate("web.farm.aim.flowerbed")
            },
        );
    }
    let stage = session
        .and_then(|s| s.issue.as_ref())
        .and_then(|id| f.frame.state.issues.iter().find(|i| &i.id == id))
        .and_then(|i| i.stage.as_ref());
    let action = stage.and_then(|s| f.tool.action(s));
    let (ok, key) = match (f.tool, session, action) {
        (FarmTool::Hand, _, _) => (true, if session.is_some() { "web.farm.aim.look" } else { "web.farm.aim.sow" }),
        (FarmTool::Weed, _, _) => (false, if crop == Crop::Weeds { "web.farm.aim.weeds" } else { "web.farm.aim.noWeeds" }),
        (FarmTool::Water, Some(s), Some(_)) => return (true, t("web.farm.aim.water", &[("name", s.name.clone().into())])),
        (FarmTool::Bug, Some(_), Some(_)) => (true, "web.farm.aim.bug"),
        (FarmTool::Harvest, Some(_), Some(_)) => (
            true,
            if super::super::world::is_ripe(crop) {
                "web.farm.aim.harvestRipe"
            } else {
                "web.farm.aim.harvestLook"
            },
        ),
        (FarmTool::Shovel, Some(_), Some(IssueAction::Stop { .. })) => (true, "web.farm.aim.shovelStop"),
        (FarmTool::Shovel, Some(_), Some(_)) => (true, "web.farm.aim.shovelDismiss"),
        (_, Some(_), _) => {
            return (
                false,
                match stage {
                    Some(s) => t(
                        "web.farm.aim.unavailable",
                        &[("state", translate(&format!("shared.stage.{}", s.state.as_str())).to_lowercase().into())],
                    ),
                    None => translate("web.farm.aim.unread"),
                },
            );
        }
        (FarmTool::Water, None, _) => (false, "web.farm.aim.nothingYet"),
        (FarmTool::Bug, None, _) => (false, "web.farm.aim.noBugs"),
        (FarmTool::Harvest, None, _) => (false, "web.farm.aim.nothingToHarvest"),
        (FarmTool::Shovel, None, _) => (false, "web.farm.aim.noShovel"),
    };
    (ok, translate(key))
}

fn draw_plot_hover(f: &FarmScene, list: &mut DrawList, fr: Framing) {
    use super::super::frame::Crop;
    let Some(i) = f.hovered_bed() else { return };
    let bed = BEDS[i];
    let session = f
        .frame
        .state
        .sessions
        .iter()
        .find(|s| s.is_worker() && (f.repo.is_none() || s.repo == f.repo) && bed.station >= 0 && f.frame.station_of(s) == bed.station);
    let crop = f.crop_of_bed(bed, false);
    let name = if bed.unlock_level.is_some() {
        translate(if crop == Crop::Locked {
            "web.farm.overlay.unclaimed"
        } else {
            "web.farm.overlay.flowerbed"
        })
    } else if let Some(s) = session {
        let crop = if crop == Crop::Carrot { Crop::Wheat } else { crop };
        format!("{} · {}", s.name, translate(&format!("web.farm.crop.{}", crop.name())))
    } else {
        t("web.farm.overlay.bare", &[("plot", (bed.station as i64 + 1).into())])
    };
    let (ok, action) = hover_action(f, bed, crop, session);
    let action = if ok {
        t("web.farm.overlay.click", &[("text", action.into())])
    } else {
        action
    };
    let mut rows = vec![(name.as_str(), INK)];
    if let Some(repo) = session.and_then(|s| s.repo.as_deref()) {
        rows.push((repo, MUTED));
    }
    rows.push((&action, if ok { rgba(0x3f6b2a, 1.) } else { MUTED }));
    let foot = f.world.plot_at(i);
    let p = ground(pt(foot.x, foot.y - PLOT_H * 0.5));
    let center = fr.bx.x + p.x * fr.scale;
    let bottom = fr.bx.y + (p.y - PLOT_H * 0.5 - 3.) * fr.scale - 2.;
    let width = rows.iter().map(|(s, _)| crate::pixel::font::width(s, 12.)).fold(0.0f32, f32::max) + 16.;
    let height = rows.len() as f32 * 14. + 10.;
    let raw_x = center - (width + 2.) / 2.;
    let raw_y = bottom - height - 2.;
    let (bx, by) = if f.view_size.0 > 0.0 && f.view_size.1 > 0.0 {
        (
            raw_x.clamp(4.0, (f.view_size.0 - width - 6.0).max(4.0)),
            raw_y.clamp(4.0, (f.view_size.1 - height - 6.0).max(4.0)),
        )
    } else {
        (raw_x, raw_y)
    };
    let b = rect(bx, by, width, height);
    card(list, b, PAPER);
    for (index, (words, ink)) in rows.into_iter().enumerate() {
        let x = b.x + (b.w - crate::pixel::font::width(words, 12.)) / 2.;
        label(list, x, line_top(b.y + 5. + 14. * index as f32, 12., 14.), words, 12., ink);
    }
}

pub(super) fn repo_sign(f: &FarmScene, fr: Framing) -> Rect {
    let sign = ground(pt(44., 104.));
    let foot = (fr.bx.x + sign.x * fr.scale, fr.bx.y + sign.y * fr.scale);
    let name = f.repo.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| translate("web.farm.sign.noRepo"));
    let title = translate("web.farm.sign.repo");
    let w = (crate::pixel::font::width(&name, 13.0).max(crate::pixel::font::width(&title, 10.0)) + 24.0).min(160.0);
    let h = 40.0 + 5.0 * fr.scale;
    rect(foot.0 - w / 2.0, foot.1 - h, w, h)
}

// GPUI paints these glyphs in a 1.25-em line. Centre that line in the pin's text row.
fn line_top(top: f32, font_size: f32, row_height: f32) -> f32 {
    top + (row_height - font_size * 1.25) / 2.0
}

#[derive(Clone, Copy)]
struct AttentionStyle {
    paper: Color,
    ink: Color,
    accent: u32,
    icon: &'static str,
}

fn attention_style(tone: Option<&str>, crop: Option<super::super::frame::Crop>) -> Option<AttentionStyle> {
    use super::super::frame::Crop;
    match tone {
        Some("wait") => Some(AttentionStyle {
            paper: rgba(0xd97426, 1.0),
            ink: rgba(0xfff3dc, 1.0),
            accent: 0xffc078,
            icon: "icon-bell",
        }),
        Some("ripe") => Some(AttentionStyle {
            paper: rgba(0xf0b93c, 1.0),
            ink: INK,
            accent: 0xfff1a8,
            icon: "icon-harvest",
        }),
        Some("bug") => Some(AttentionStyle {
            paper: rgba(0xb44b36, 1.0),
            ink: rgba(0xfff3dc, 1.0),
            accent: 0xff9b85,
            icon: "icon-bug",
        }),
        Some("stuck") => Some(AttentionStyle {
            paper: rgba(0x4a728c, 1.0),
            ink: rgba(0xfff3dc, 1.0),
            accent: 0x9cd1f0,
            icon: "mark-warn",
        }),
        _ => match crop {
            Some(Crop::Dry) => attention_style(Some("wait"), None),
            Some(c) if super::super::world::is_ripe(c) => attention_style(Some("ripe"), None),
            Some(Crop::Withered) => attention_style(Some("bug"), None),
            _ => None,
        },
    }
}

fn attention_pin(list: &mut DrawList, point: (f32, f32), rows: &[&str], style: AttentionStyle, t: f64) {
    let pulse = (0.5 + 0.5 * (t * 3.5).sin()) as f32;
    let bob = ((t * 3.2).sin().max(0.0) * 2.5).round() as f32;
    let dot_space = 10.0;
    let (px, py) = (6.0, 3.0);
    let first_w = rows.first().map(|s| crate::pixel::font::width(s, 12.0) + dot_space).unwrap_or(0.0);
    let rest_w = rows.iter().skip(1).map(|s| crate::pixel::font::width(s, 12.0)).fold(0.0f32, f32::max);
    let w = first_w.max(rest_w) + 4.0 + 2.0 * px;
    let h = rows.len() as f32 * 14.0 + 4.0 + 2.0 * py;
    let b = rect(point.0 - (w + 2.0) / 2.0, point.1 - (h + 2.0) - bob, w, h);
    paint(list, rect(b.x - 2.0, b.y - 2.0, b.w + 4.0, b.h + 4.0), rgba(style.accent, 0.30 + 0.50 * pulse));
    card(list, b, style.paper);
    let dot_x = b.x + 2.0 + px;
    let dot_y = b.y + 2.0 + py + 4.0;
    paint(list, rect(dot_x, dot_y, 6.0, 6.0), rgba(style.accent, 0.65 + 0.35 * pulse));
    paint(list, rect(dot_x + 2.0, dot_y + 2.0, 2.0, 2.0), rgba(0xfffdf2, 0.8 + 0.2 * pulse));
    for (row, text) in rows.iter().enumerate() {
        let indent = if row == 0 { dot_space } else { 0.0 };
        label(
            list,
            b.x + 2.0 + px + indent,
            line_top(b.y + 2.0 + py + row as f32 * 14.0, 12.0, 14.0),
            *text,
            12.0,
            style.ink,
        );
    }
}

fn text_pin(list: &mut DrawList, point: (f32, f32), ay: f32, rows: &[&str], pad: (f32, f32), paper: Color, ink: Color) {
    let w = rows.iter().map(|s| crate::pixel::font::width(s, 12.0)).fold(0.0f32, f32::max) + 4.0 + 2.0 * pad.0;
    let h = rows.len() as f32 * 14.0 + 4.0 + 2.0 * pad.1;
    let b = rect(point.0 - (w + 2.0) / 2.0, point.1 - (h + 2.0) * ay, w, h);
    card(list, b, paper);
    for (row, text) in rows.iter().enumerate() {
        label(
            list,
            b.x + 2.0 + pad.0,
            line_top(b.y + 2.0 + pad.1 + row as f32 * 14.0, 12.0, 14.0),
            *text,
            12.0,
            ink,
        );
    }
}

fn place_sign(f: &FarmScene, list: &mut DrawList, id: &str, index: usize, x: f32, y: f32) {
    let name = match id {
        "shop" => "icon-shop",
        "warehouse" => "icon-crate",
        "tasks" => "icon-tasks",
        "log" => "icon-log",
        "taskBoard" => "icon-task-board",
        "agents" => "icon-board",
        "runtimes" => "machine-tractor",
        "skills" => "icon-skillbook",
        _ => return,
    };
    if let Some(info) = f.atlas.get(name) {
        let h = 30.0;
        let w = 22.0 * info.w / info.h + 8.0;
        let hop = if (f.t + index as f64 * 0.8).rem_euclid(3.2) >= 0.89 * 3.2 { 3.0 } else { 0.0 };
        let b = rect(x - (w + 2.0) / 2.0, y - (h + 2.0) - hop, w, h);
        list.hud.push(super::sign::Plaque::Building.background(b.x, b.y, b.w, b.h + 2.));
        if let Some(image) = f.atlas.image(name) {
            list.hud.push(super::sign::marker_icon(name, image, b.x + 4., b.y + 4., w - 8.));
        }
    }
}

pub(super) fn draw_overlay(f: &FarmScene, list: &mut DrawList, fr: Framing) {
    let at = |x: f32, y: f32| (fr.bx.x + x * fr.scale, fr.bx.y + y * fr.scale);
    let pin = |list: &mut DrawList, x: f32, y: f32, text: &str, paper: Color| text_pin(list, (x, y), 1.0, &[text], (6.0, 3.0), paper, INK);
    let hovered = f.hovered_bed();
    for bed in BEDS {
        if hovered == Some(bed.index) {
            continue;
        }
        let foot = f.world.plot_at(bed.index);
        let p = ground(pt(foot.x, foot.y - PLOT_H / 2.0));
        let (x, y) = at(p.x, p.y);
        let badge_y = at(p.x, p.y - PLOT_H * 0.5 + 5.).1 - 2.;
        let session = f
            .frame
            .state
            .sessions
            .iter()
            .find(|s| s.is_worker() && (f.repo.is_none() || s.repo == f.repo) && bed.station >= 0 && f.frame.station_of(s) == bed.station);
        if let Some(s) = session {
            let badge = f.frame.plot_of(s).and_then(|p| p.badge.as_ref());
            if let Some(b) = badge {
                let mut rows = vec![b.text.as_str()];
                rows.extend(s.repo.as_deref());
                if let Some(style) = attention_style(Some(b.tone.as_str()), None) {
                    attention_pin(list, (x, badge_y), &rows, style, f.t);
                } else {
                    let paper = match b.tone.as_str() {
                        "rest" => 0xcdbb92,
                        _ => 0xf3e2b8,
                    };
                    text_pin(list, (x, badge_y), 1.0, &rows, (6.0, 3.0), rgba(paper, 1.0), INK);
                }
            } else if let Some(repo) = &s.repo {
                text_pin(list, (x, badge_y), 1.0, &[repo], (3.0, 0.0), PAPER, MUTED);
            }
        } else if let Some(level) = bed.unlock_level
            && f.frame.view.level.level < level as f64
        {
            text_pin(
                list,
                (x, y),
                0.5,
                &[&t("web.farm.overlay.clearAt", &[("level", i64::from(level).into())])],
                (6.0, 3.0),
                PAPER,
                INK,
            );
        }
    }
    for (i, (id, bx)) in f.world.spot_boxes.iter().enumerate() {
        let top = if bx.y0 < 20.0 { bx.y0 + 30.0 } else { bx.y0 };
        let prop_top = || {
            let prop = f.world.props.iter().find(|prop| prop.spot == *id)?;
            let feet = ground(prop.at);
            let ink = f.atlas.visible_box(&prop.sprite, feet.x, feet.y, false)?;
            Some(pt((ink.x0 + ink.x1) * 0.5, ink.y0))
        };
        let p = f
            .atlas
            .landmarks
            .as_ref()
            .and_then(|mask| mask.pin(id))
            .or_else(prop_top)
            .unwrap_or_else(|| ground(pt((bx.x0 + bx.x1) / 2., top)));
        let (x, y) = at(p.x, p.y);
        let tip = YARD_PLACES
            .iter()
            .find(|p| p.id == *id && (f.reveal_names || matches!(&f.hover, Some(VillageHit::Spot(s)) if s == id)));
        if tip.is_none() {
            place_sign(f, list, id, i, x, y - 3. * fr.scale);
        }
        let count = match *id {
            "warehouse" => f.frame.state.issues.iter().filter(|issue| issue.harvested()).count(),
            "taskBoard" => f
                .frame
                .inbox
                .iter()
                .filter(|item| !matches!(item.target, vibevalley_protocol::InboxTarget::Chat(_)))
                .count(),
            _ => 0,
        };
        if count > 0 {
            text_pin(
                list,
                (x + 6. * fr.scale, y),
                0.5,
                &[&count.to_string()],
                (3.0, 0.0),
                rgba(0xb44b36, 1.0),
                rgba(0xfff3dc, 1.0),
            );
        }
        if let Some(place) = tip {
            pin(list, x, y - 4.0, &translate(place.label), PAPER);
        }
    }
    let m = ground(f.world.orchestrator);
    if f.frame.state.sessions.is_empty() && !f.reveal_names {
        let (x, y) = at(m.x, m.y - 34.0);
        pin(list, x, y - 4.0, &translate("web.farm.overlay.idle"), PAPER);
    }
    for s in &f.frame.state.sessions {
        if let Some(p) = f.helper_feet(&s.id) {
            let plot = f.frame.plot_of(s);
            let attention = attention_style(plot.and_then(|pl| pl.badge.as_ref()).map(|b| b.tone.as_str()), plot.map(|pl| pl.crop));
            if let Some(style) = attention
                && f.atlas.has(style.icon)
            {
                let pulse = (0.5 + 0.5 * (f.t * 3.5).sin()) as f32;
                let bob = ((f.t * 3.2).sin().max(0.0) * 2.5).round() as f32;
                let w = 26.0;
                let (x, y) = at(p.x, p.y - 31.0);
                let b = rect((x - w / 2.0).round(), y - 28.0 - bob, w, 26.0);
                paint(list, rect(b.x - 2.0, b.y - 2.0, b.w + 4.0, b.h + 4.0), rgba(style.accent, 0.35 + 0.50 * pulse));
                card(list, b, style.paper);
                sprite(f, list, style.icon, b.x + 4.0, b.y + 4.0, 18.0);
                continue;
            }
            let doing = s.doing().unwrap_or("none");
            let named = s.phase.tag == "working" && s.runs == 0;
            if doing == "none" && !named {
                continue;
            }
            let image = format!("act-{doing}");
            let iw = if f.atlas.has(&image) { 18.0 } else { 0.0 };
            let gap = if iw > 0.0 && named { 3.0 } else { 0.0 };
            let text_w = if named { crate::pixel::font::width(&s.name, 12.0) } else { 0.0 };
            let w = 8.0 + iw + gap + text_w;
            let (x, y) = at(p.x, p.y - 31.0);
            let b = rect((x - w / 2.0).round(), y - 28.0, w, 26.0);
            card(list, b, PAPER);
            if iw > 0.0 {
                sprite(f, list, &image, b.x + 4.0, b.y + 4.0, iw);
            }
            if named {
                label(list, b.x + 4.0 + iw + gap, line_top(b.y + 2.0, 12.0, 22.0), &s.name, 12.0, INK);
            }
        }
    }
    draw_plot_hover(f, list, fr);
    let button = repo_sign(f, fr);
    let b = rect(button.x, button.y, button.w, 40.0);
    list.hud
        .push(super::sign::Plaque::Repository.background(button.x, button.y, button.w, button.h));
    let name = f.repo.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| translate("web.farm.sign.noRepo"));
    let title = translate("web.farm.sign.repo");
    label(
        list,
        b.x + (b.w - crate::pixel::font::width(&title, 10.0)) / 2.0,
        line_top(b.y + 6.0, 10.0, 12.0),
        title,
        10.0,
        rgba(0xe2c995, 1.0),
    );
    let name_width = crate::pixel::font::width(&name, 13.0).min(b.w - 24.0);
    list.hud.push(HudOp::TextIn {
        x: b.x + (b.w - name_width) / 2.0,
        y: line_top(b.y + 18.0, 13.0, 16.0) - 0.5,
        w: name_width,
        text: name,
        size: 13.0,
        color: rgba(0xf7e8c4, 1.0),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_plot_label_anchors_include_the_cast_shadow() {
        let mut draw = DrawList::default();
        text_pin(&mut draw, (412.0, 338.0), 1.0, &["parity"], (3.0, 0.0), PAPER, MUTED);
        assert!(matches!(&draw.hud[1],HudOp::Rect{x,y,w,h,..} if (*x,*y,*w,*h)==(390.0,318.0,42.0,18.0)));
        assert!(matches!(&draw.hud[3],HudOp::Text{x,y,text,..} if (*x,*y)==(395.0,319.5) && text=="parity"));
    }
    #[test]
    fn regression_warehouse_marker_anchors_the_whole_card() {
        let (world, atlas) = crate::pixel::load_village().unwrap();
        let mut farm = FarmScene::new(world, atlas);
        farm.view_size = (1208.0, 800.0);
        let fr = frame_cover(farm.view_size, (farm.world.level.width, farm.world.level.height), FARM_CUT);
        let mut draw = DrawList::default();
        draw_overlay(&farm, &mut draw, fr);
        let image = draw
            .hud
            .iter()
            .find_map(|op| match op {
                HudOp::Bitmap { key, x, y, w, h, .. } if key.starts_with("marker:icon-crate:") => Some((*x, *y, *w, *h)),
                _ => None,
            })
            .unwrap();
        let crates = farm.world.props.iter().find(|prop| prop.spot == "warehouse").unwrap();
        let foot = ground(crates.at);
        let ink = farm.atlas.visible_box(&crates.sprite, foot.x, foot.y, false).unwrap();
        let center = fr.bx.x + fr.scale * (ink.x0 + ink.x1) * 0.5;
        let top = fr.bx.y + fr.scale * ink.y0;
        assert_eq!((image.2, image.3), (30., 22.));
        assert!((image.0 + image.2 / 2. - center).abs() <= 2.);
        assert!((image.1 + image.3 - (top - 3. * fr.scale - 6.)).abs() < 0.1);
    }
    #[test]
    fn regression_world_badges_count_non_chat_inbox_items_and_harvested_issues() {
        use vibevalley_protocol::{InboxFrom, InboxFromOrchestrator, InboxItem, InboxKind, InboxTarget, InboxTargetChat, InboxTargetIssue};
        let (world, atlas) = crate::pixel::load_village().unwrap();
        let mut farm = FarmScene::new(world, atlas);
        farm.view_size = (1208.0, 800.0);
        for target in [
            InboxTarget::Issue(InboxTargetIssue { id: "first".into() }),
            InboxTarget::Issue(InboxTargetIssue { id: "second".into() }),
            InboxTarget::Chat(InboxTargetChat { channel: "general".into() }),
        ] {
            farm.frame.inbox.push(InboxItem {
                target,
                id: String::new(),
                kind: InboxKind::Ask,
                from: InboxFrom::Orchestrator(InboxFromOrchestrator {}),
                at: 0,
                who: String::new(),
                text: String::new(),
                words: Default::default(),
            });
        }
        for delivered in ["merged", "pull_request", "kept", "merged"] {
            farm.frame.state.issues.push(crate::pixel::farm::frame::Issue {
                delivered: Some(delivered.into()),
                ..Default::default()
            });
        }
        let fr = frame_cover(farm.view_size, (farm.world.level.width, farm.world.level.height), FARM_CUT);
        let mut draw = DrawList::default();
        draw_overlay(&farm, &mut draw, fr);
        let counts: Vec<_> = draw
            .hud
            .iter()
            .filter_map(|op| match op {
                HudOp::Text { text, color, .. } if *color == rgba(0xfff3dc, 1.0) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(counts.contains(&"2") && counts.contains(&"3"));
    }
    #[test]
    fn regression_repo_post_opens_the_same_repo_as_the_plaque() {
        let (world, atlas) = crate::pixel::load_village().unwrap();
        let mut farm = FarmScene::new(world, atlas);
        farm.repo = Some("parity".into());
        farm.view_size = (1208.0, 800.0);
        let framing = frame_cover(farm.view_size, (farm.world.level.width, farm.world.level.height), FARM_CUT);
        let sign = repo_sign(&farm, framing);
        assert!((sign.h - (40.0 + 5.0 * framing.scale)).abs() < 0.01);
        assert!((sign.w - 58.6667).abs() < 0.01);
        assert_eq!(hit(&farm, sign.x + sign.w / 2.0, sign.y + sign.h - 1.0), Some(Action::Route("/repos".into())));
    }
    #[test]
    fn attention_plots_and_helpers_render_pulsing_indicators() {
        use crate::pixel::farm::frame::{Badge, Crop, Frame, Play, PlotView, Session};
        let (world, atlas) = crate::pixel::load_village().unwrap();
        let mut farm = FarmScene::new(world, atlas);
        farm.view_size = (1208.0, 800.0);
        let mut frame = Frame::default();
        frame.state.sessions.push(Session {
            id: "s-wait".into(),
            role: "worker".into(),
            name: "cat".into(),
            agent: "agent-cat".into(),
            issue: Some("i-wait".into()),
            ..Default::default()
        });
        frame.state.sessions.push(Session {
            id: "s-ripe".into(),
            role: "worker".into(),
            name: "rabbit".into(),
            agent: "agent-rabbit".into(),
            issue: Some("i-ripe".into()),
            ..Default::default()
        });
        frame.view.plays.insert("s-wait".into(), Play { station: 0.0 });
        frame.view.plays.insert("s-ripe".into(), Play { station: 1.0 });
        frame.view.plots.insert(
            "i-wait".into(),
            PlotView {
                crop: Crop::Dry,
                badge: Some(Badge {
                    text: "等你回答".into(),
                    tone: "wait".into(),
                }),
            },
        );
        frame.view.plots.insert(
            "i-ripe".into(),
            PlotView {
                crop: Crop::Wheat,
                badge: Some(Badge {
                    text: "可收获".into(),
                    tone: "ripe".into(),
                }),
            },
        );
        farm.apply_frame(frame);
        farm.tick(0.1);
        let list = farm.draw(2.0);
        assert!(list.hud.iter().any(|op| matches!(op, HudOp::Image { key, .. } if key == "hud:icon-bell")));
        assert!(list.hud.iter().any(|op| matches!(op, HudOp::Image { key, .. } if key == "hud:icon-harvest")));
        assert!(list.hud.iter().any(|op| matches!(op, HudOp::Text { text, .. } if text == "等你回答")));
        assert!(list.hud.iter().any(|op| matches!(op, HudOp::Text { text, .. } if text == "可收获")));
    }
    #[test]
    fn regression_plot_hover_clamps_inside_viewport() {
        let (world, atlas) = crate::pixel::load_village().unwrap();
        let mut farm = FarmScene::new(world, atlas);
        farm.view_size = (320.0, 400.0);
        farm.hover = Some(VillageHit::Plot(0));
        let fr = frame_cover(farm.view_size, (farm.world.level.width, farm.world.level.height), FARM_CUT);
        let mut draw = DrawList::default();
        draw_plot_hover(&farm, &mut draw, fr);
        assert!(!draw.hud.is_empty());
        for op in &draw.hud {
            if let HudOp::Rect { x, y, w, h, .. } = op {
                assert!(
                    *x >= 4.0 && *y >= 4.0 && x + w <= farm.view_size.0 && y + h <= farm.view_size.1,
                    "hover rect out of bounds: ({x}, {y}, {w}, {h})"
                );
            }
        }
    }
}
