//! The map of islands, one per repo: VibeValley's `farm/map/islands.ts`
//! (rules) and `RepoMap.tsx` (the picture, here painted).

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;

use super::super::atlas::Atlas;
use super::super::draw::{DrawList, HudOp, Op, rgba};
use super::super::level::{Box2, Point, pt};
use super::frame::{Frame, Issue, PlotView, Session};
use super::scene::cast_prefix;

/// How many helpers may work on the whole farm at once (`maxRunning`).
const MAX_RUNNING: i64 = vibevalley_protocol::MAX_RUNNING as i64;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepoSummary {
    pub name: String,
    pub path: String,
    pub max_sessions: f64,
    pub last: Option<f64>,
}

#[derive(Debug, Clone)]
pub enum Spot {
    Taken {
        session: Box<Session>,
        plot: PlotView,
        pose: &'static str,
    },
    Open,
    Shut,
}

#[derive(Debug, Clone)]
pub struct Island {
    pub repo: String,
    pub summary: Option<RepoSummary>,
    pub spots: Vec<Spot>,
    pub working: i64,
    pub max_sessions: i64,
    pub queued: Vec<Issue>,
}

fn is_busy(s: &Session) -> bool {
    s.phase.tag == "working"
}

/// Peopled or waited on first, then the newest commit, then by name.
pub fn islands_of(repos: &[RepoSummary], frame: &Frame) -> Vec<Island> {
    let sessions: Vec<&Session> = frame.state.sessions.iter().filter(|s| s.is_worker()).collect();
    let mut names: Vec<String> = repos.iter().map(|r| r.name.clone()).collect();
    for s in &sessions {
        if let Some(r) = &s.repo
            && !names.contains(r)
        {
            names.push(r.clone());
        }
    }
    let busy_all = sessions.iter().filter(|s| is_busy(s)).count() as i64;
    let mut islands: Vec<Island> = names
        .into_iter()
        .map(|name| {
            let summary = repos.iter().find(|r| r.name == name).cloned();
            let mut mine: Vec<&Session> = sessions.iter().copied().filter(|s| s.repo.as_deref() == Some(&name)).collect();
            mine.sort_by(|a, b| a.hired_at.total_cmp(&b.hired_at));
            let working = mine.iter().filter(|s| is_busy(s)).count() as i64;
            let max_sessions = summary.as_ref().map(|s| s.max_sessions.round() as i64).unwrap_or(working);
            let left_repo = if max_sessions > 0 { (max_sessions - working).max(0) } else { i64::MAX };
            let left_farm = (MAX_RUNNING - busy_all).max(0);
            let room = (if max_sessions > 0 { left_repo } else { 0 }).min(MAX_RUNNING - mine.len() as i64).max(0);
            let open = room.min(left_farm);
            let mut spots: Vec<Spot> = mine
                .iter()
                .map(|s| Spot::Taken {
                    session: Box::new((*s).clone()),
                    pose: map_pose(
                        s,
                        frame.state.issues.iter().any(|i| {
                            Some(&i.id) == s.issue.as_ref()
                                && i.stage.as_ref().and_then(|stage| stage.stuck) == Some(vibevalley_protocol::StuckReason::Conflict)
                        }),
                    ),
                    plot: frame.plot_of(s).cloned().unwrap_or(PlotView {
                        crop: super::frame::Crop::Seeded,
                        badge: None,
                    }),
                })
                .collect();
            spots.extend((0..open).map(|_| Spot::Open));
            spots.extend((0..room - open).map(|_| Spot::Shut));
            let mut queued: Vec<Issue> = frame
                .state
                .issues
                .iter()
                .filter(|i| i.repo.as_deref() == Some(&name) && i.status == "todo" && i.queued_at.is_some())
                .cloned()
                .collect();
            queued.sort_by(|a, b| a.queued_at.unwrap_or(0.0).total_cmp(&b.queued_at.unwrap_or(0.0)));
            Island {
                repo: name,
                summary,
                spots,
                working,
                max_sessions,
                queued,
            }
        })
        .collect();
    let quiet = |i: &Island| {
        if i.spots.iter().any(|s| matches!(s, Spot::Taken { .. })) || !i.queued.is_empty() {
            0
        } else {
            1
        }
    };
    islands.sort_by(|a, b| {
        quiet(a)
            .cmp(&quiet(b))
            .then(
                b.summary
                    .as_ref()
                    .and_then(|s| s.last)
                    .unwrap_or(0.0)
                    .total_cmp(&a.summary.as_ref().and_then(|s| s.last).unwrap_or(0.0)),
            )
            .then(a.repo.to_lowercase().cmp(&b.repo.to_lowercase()))
    });
    islands
}

const PLOT_W: f32 = 34.0;
const PLOT_H: f32 = 26.0;
const HEAD: f32 = 15.0;
const ROW_PITCH: f32 = 36.0;
const MAX_COL_PITCH: f32 = 54.0;

/// Each returned point is a plot's foot, inside `yard`.
pub fn plots_in(yard: Box2, n: usize) -> Vec<Point> {
    if n == 0 {
        return Vec::new();
    }
    let rows = n.div_ceil(3);
    let per_row = n.div_ceil(rows);
    let width = yard.x1 - yard.x0;
    let height = yard.y1 - yard.y0;
    let pitch = if per_row == 1 {
        0.0
    } else {
        MAX_COL_PITCH.min((width - PLOT_W - 8.0) / (per_row - 1) as f32)
    };
    let block = HEAD + PLOT_H + (rows - 1) as f32 * ROW_PITCH;
    let cx = yard.x0 + width / 2.0;
    let first_bottom = yard.y0 + height / 2.0 - block / 2.0 + HEAD + PLOT_H;
    (0..n)
        .map(|i| {
            let row = i / per_row;
            let in_row = per_row.min(n - row * per_row);
            pt(
                cx + ((i % per_row) as f32 - (in_row as f32 - 1.0) / 2.0) * pitch,
                first_bottom + row as f32 * ROW_PITCH,
            )
        })
        .collect()
}

pub const ISLAND_LOOKS: [&str; 6] = [
    "island-meadow",
    "island-orchard",
    "island-pond",
    "island-pines",
    "island-windmill",
    "island-lavender",
];

pub fn island_look(repo: &str) -> &'static str {
    let h = repo.chars().fold(0u32, |h, c| (h.wrapping_mul(31).wrapping_add(c as u32)) & 0x7fff_ffff);
    ISLAND_LOOKS[h as usize % ISLAND_LOOKS.len()]
}

/// A helper on the map: the pose's sprite suffix.
fn map_pose(s: &Session, conflict: bool) -> &'static str {
    match s.phase.tag.as_str() {
        "failed" => "worry",
        "done" | "resting" if conflict => "worry",
        "working" => match s.doing() {
            Some("thinking") | Some("speaking_text") => "side",
            _ => "work",
        },
        "done" => "cheer",
        _ => "down",
    }
}

const GAP: f32 = 24.0;

/// What a tap on the map lands on.
#[derive(Debug, Clone, PartialEq)]
pub enum MapHit {
    Island(String),
    Sow(String),
    Plot {
        agent: String,
        worktree: Option<String>,
        issue: Option<String>,
    },
}

impl MapHit {
    pub fn route(&self) -> String {
        use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
        const COMPONENT: &percent_encoding::AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');
        match self {
            Self::Island(repo) => format!("/farm/{}", utf8_percent_encode(repo, COMPONENT)),
            Self::Sow(repo) => format!("/issues/new?repo={}", utf8_percent_encode(repo, COMPONENT)),
            Self::Plot { issue: Some(id), .. } => format!("/issues/{}", utf8_percent_encode(id, COMPONENT)),
            Self::Plot { agent, .. } => format!("/agents/{}", utf8_percent_encode(agent, COMPONENT)),
        }
    }
}

pub struct MapScene {
    pub atlas: Arc<Atlas>,
    frame: Frame,
    repos: Option<Vec<RepoSummary>>,
    pub islands: Vec<Island>,
    pub agent_looks: HashMap<String, (String, String)>,
    pub load_error: Option<String>,
    hits: Vec<(Box2, MapHit)>,
    pub hover: Option<MapHit>,
    t: f32,
}

impl MapScene {
    pub fn new(atlas: Arc<Atlas>) -> MapScene {
        MapScene {
            atlas,
            frame: Frame::default(),
            repos: None,
            islands: Vec::new(),
            agent_looks: HashMap::new(),
            load_error: None,
            hits: Vec::new(),
            hover: None,
            t: 0.0,
        }
    }

    pub fn tick(&mut self, dt: f32) {
        self.t += dt.min(0.1);
    }

    pub fn apply_frame(&mut self, frame: Frame) {
        self.frame = frame;
        self.islands = islands_of(self.repos.as_deref().unwrap_or_default(), &self.frame);
    }

    pub fn set_repos(&mut self, repos: Vec<RepoSummary>) {
        self.repos = Some(repos);
        self.islands = islands_of(self.repos.as_deref().unwrap_or_default(), &self.frame);
    }

    pub fn repo_path(&self, repo: &str) -> Option<&str> {
        self.repos.as_ref()?.iter().find(|r| r.name == repo).map(|r| r.path.as_str())
    }

    fn cell(&self) -> (f32, f32) {
        ISLAND_LOOKS
            .iter()
            .filter_map(|n| self.atlas.get(n))
            .fold((0.0f32, 0.0f32), |(w, h), s| (w.max(s.w), h.max(s.h)))
    }

    /// Lays the islands out in as many columns as suit a view of `aspect` (w / h).
    pub fn draw(&mut self, aspect: f32) -> DrawList {
        let atlas = self.atlas.clone();
        let (cw, ch) = self.cell();
        let n = self.islands.len().max(1);
        let label_h = 30.0;
        let cols = (1..=n)
            .min_by(|&a, &b| {
                let ratio = |c: usize| {
                    let rows = n.div_ceil(c);
                    let w = c as f32 * (cw + GAP) + GAP;
                    let h = rows as f32 * (ch + label_h + GAP) + GAP;
                    ((w / h).ln() - aspect.max(0.1).ln()).abs()
                };
                ratio(a).total_cmp(&ratio(b))
            })
            .unwrap_or(1);
        let rows = n.div_ceil(cols);
        let width = cols as f32 * (cw + GAP) + GAP;
        let height = rows as f32 * (ch + label_h + GAP) + GAP;
        let mut list = DrawList::new(width, height, rgba(0xcfe3d6, 1.0));
        list.fit = true;
        // The sea's grid, as the map paper's dashed lines.
        let grid = rgba(0xb7d2c4, 1.0);
        let mut x = 32.0;
        while x < width {
            list.rect(x, 0.0, 1.0, height, grid);
            x += 32.0;
        }
        let mut y = 32.0;
        while y < height {
            list.rect(0.0, y, width, 1.0, grid);
            y += 32.0;
        }
        self.hits.clear();
        if let Some(error) = &self.load_error {
            list.hud_art.push((width / 2., 3., error.clone()));
        } else if self.repos.is_some() && self.islands.is_empty() {
            list.hud_art.push((width / 2., height / 2., vibevalley_i18n::t("web.farm.sow.noRepos", &[])));
        }
        for (i, island) in self.islands.iter().enumerate() {
            let (col, row) = (i % cols, i / cols);
            let name = atlas.first(&[island_look(&island.repo), "island-meadow"]);
            let Some(info) = atlas.get(name) else { continue };
            let left = GAP + col as f32 * (cw + GAP) + (cw - info.w) / 2.0;
            let top = GAP + row as f32 * (ch + label_h + GAP) + (ch - info.h);
            let bob = ((self.t * 0.8 + i as f32).sin() * 1.0).round();
            list.ops.push(Op::Sprite {
                name: name.into(),
                x: left,
                y: top + bob,
                flip: false,
                alpha: 1.0,
            });
            self.hits.push((
                Box2 {
                    x0: left,
                    y0: top,
                    x1: left + info.w,
                    y1: top + info.h,
                },
                MapHit::Island(island.repo.clone()),
            ));
            let yard = atlas.yard(name).unwrap_or(Box2 {
                x0: info.w * 0.25,
                y0: info.h * 0.25,
                x1: info.w * 0.75,
                y1: info.h * 0.65,
            });
            let yard = Box2 {
                x0: left + yard.x0,
                y0: top + bob + yard.y0,
                x1: left + yard.x1,
                y1: top + bob + yard.y1,
            };
            for (spot, foot) in island.spots.iter().zip(plots_in(yard, island.spots.len())) {
                match spot {
                    Spot::Taken { session, plot, pose } => {
                        list.sprite(&atlas, &format!("plot-{}", plot.crop.name()), foot.x, foot.y, false, 1.0);
                        let configured = self.agent_looks.get(&session.agent).map(|(sp, outfit)| (sp.as_str(), outfit.as_str()));
                        let look = cast_prefix(configured, &session.agent, &atlas);
                        let pose = format!("{look}-{pose}");
                        let pose = if atlas.has(&pose) { pose } else { format!("{look}-down") };
                        list.sprite(&atlas, &pose, foot.x, foot.y - 10.0, false, 1.0);
                        self.hits.push((
                            Box2 {
                                x0: foot.x - PLOT_W / 2.0,
                                y0: foot.y - PLOT_H - 14.0,
                                x1: foot.x + PLOT_W / 2.0,
                                y1: foot.y,
                            },
                            MapHit::Plot {
                                agent: session.agent.clone(),
                                worktree: session.worktree.clone(),
                                issue: session.issue.clone(),
                            },
                        ));
                    }
                    Spot::Open => {
                        list.sprite(&atlas, "plot-empty", foot.x, foot.y, false, 1.0);
                        list.sprite(&atlas, "map-stake", foot.x + 9.0, foot.y - 12.0, false, 1.0);
                        self.hits.push((
                            Box2 {
                                x0: foot.x - PLOT_W / 2.0,
                                y0: foot.y - PLOT_H,
                                x1: foot.x + PLOT_W / 2.0,
                                y1: foot.y,
                            },
                            MapHit::Sow(island.repo.clone()),
                        ));
                    }
                    Spot::Shut => list.sprite(&atlas, "plot-locked", foot.x, foot.y, false, 1.0),
                }
            }
            let gate = pt((yard.x0 + yard.x1) / 2.0, yard.y1 + 6.0);
            for (k, _) in island.queued.iter().take(3).enumerate() {
                list.sprite(&atlas, "map-sack", gate.x + 20.0 + k as f32 * 12.0, gate.y + 8.0, false, 1.0);
            }
            let mut tally = if island.summary.is_some() {
                vibevalley_i18n::t(
                    "web.farm.native.islandWorking",
                    &[
                        ("repo", island.repo.as_str().into()),
                        ("count", island.working.into()),
                        ("limit", island.max_sessions.into()),
                    ],
                )
            } else {
                vibevalley_i18n::t("web.farm.native.islandGone", &[("repo", island.repo.as_str().into())])
            };
            if !island.queued.is_empty() {
                tally.push_str(&vibevalley_i18n::t(
                    "web.farm.native.islandQueued",
                    &[("count", (island.queued.len() as i64).into())],
                ));
            }
            list.hud_art.push((left + info.w / 2.0, top + info.h + 6.0, tally));
        }
        let cloud = atlas.get("map-cloud");
        if let Some(c) = cloud {
            for k in 0..2 {
                let x = ((self.t * 4.0 + k as f32 * width / 2.0) % (width + c.w)) - c.w;
                list.ops.push(Op::Sprite {
                    name: "map-cloud".into(),
                    x,
                    y: 10.0 + k as f32 * height / 2.0,
                    flip: false,
                    alpha: 0.75,
                });
            }
        }
        if let Some(c) = atlas.get("map-compass") {
            list.ops.push(Op::Sprite {
                name: "map-compass".into(),
                x: width - c.w - 8.0,
                y: height - c.h - 8.0,
                flip: false,
                alpha: 0.8,
            });
        }
        list
    }

    pub fn hit_at(&self, p: Point) -> Option<MapHit> {
        // Plots and stakes were pushed after their island: the last match is on top.
        self.hits.iter().rev().find(|(b, _)| b.contains(p)).map(|(_, h)| h.clone())
    }

    pub fn debug_state(&self) -> serde_json::Value {
        serde_json::json!({
            "repos": self.repos.as_ref().map_or(0, Vec::len),
            "islands": self.islands.iter().map(|i| serde_json::json!({
                "repo": i.repo, "look": island_look(&i.repo), "working": i.working, "max": i.max_sessions,
                "spots": i.spots.iter().map(|s| match s { Spot::Taken { session, .. } => session.id.clone(), Spot::Open => "open".into(), Spot::Shut => "shut".into() }).collect::<Vec<_>>(),
                "queued": i.queued.len(),
            })).collect::<Vec<_>>(),
            "hover": format!("{:?}", self.hover),
        })
    }
}

/// Labels of the map are text in the view, placed at art points.
pub fn label_ops(list: &DrawList, scale: f32) -> Vec<HudOp> {
    let ink = rgba(0x3b2a1a, 1.0);
    list.hud_art
        .iter()
        .map(|(x, y, text)| {
            let w = super::super::font::width(text, 12.0);
            HudOp::Text {
                x: x * scale - w / 2.0,
                y: y * scale,
                text: text.clone(),
                size: 12.0,
                color: ink,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plots_spread_in_rows_of_three() {
        let yard = Box2 {
            x0: 0.0,
            y0: 0.0,
            x1: 150.0,
            y1: 70.0,
        };
        let p = plots_in(yard, 4);
        assert_eq!(p.len(), 4);
        assert_eq!(p[0].y, p[1].y);
        assert_eq!(p[2].y, p[0].y + ROW_PITCH);
        assert!(plots_in(yard, 0).is_empty());
    }

    #[test]
    fn regression_map_targets_resolve_to_workbench_routes() {
        assert_eq!(MapHit::Island("tools.v2".into()).route(), "/farm/tools.v2");
        assert_eq!(MapHit::Sow("A&B".into()).route(), "/issues/new?repo=A%26B");
        let plot = |issue| MapHit::Plot {
            agent: "docs/1".into(),
            worktree: None,
            issue,
        };
        assert_eq!(plot(Some("i17".into())).route(), "/issues/i17");
        assert_eq!(plot(None).route(), "/agents/docs%2F1");
    }

    #[test]
    fn island_looks_hash_like_javascript() {
        // h = "a" = 97 → 97 % 6 = 1.
        assert_eq!(island_look("a"), "island-orchard");
    }
}
