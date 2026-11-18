//! Draws the active repository from the latest frame and advances its helpers between frames.

use std::collections::HashMap;
use std::sync::Arc;

use super::super::atlas::Atlas;
use super::super::draw::{DrawList, Op, rgba};
use super::super::level::{Box2, Point, pt};
use super::super::nav::{Facing, Walker, frame_at};
use super::super::sky::{DayClock, clock_text, flat_light, sky_at};
use super::frame::{Crop, Frame, Session};
use super::hud::{self, Panel};
use super::phone::Phone;
use super::world::{
    BEDS, Bed, Goal, GoalInput, PLOT_H, PLOT_W, Pose, PoseHold, REST_SPOTS, Stroll, StrollSpot, VillageHit, VillageWorld, Whereabouts, YARD_PLACES,
    bed_of_station, place_of_action, plot_calls, pose_of, spots_for, village_hit_at,
};

const WALK_SPEED: f32 = 42.0;
const WALK_FPS: f32 = 8.0;
const FADE_S: f32 = 0.8;
const GONE_S: f32 = 3.6;
const LANTERN_DARK: f32 = 0.35;
const WHERE_TICK: f32 = 0.3;
const STROLL_TICK: f32 = 0.6;
const HOP: [f32; 6] = [2.0, 4.0, 5.0, 4.0, 2.0, 1.0];
const HOP_S: f32 = 0.3;
const BACKGROUND: u32 = 0x2b3320;
const LAMP: u32 = 0xffc46e;
const LANTERN: u32 = 0xffd28c;

const SPECIES: [&str; 7] = ["bear", "rabbit", "fox", "cat", "owl", "hedgehog", "raccoon"];

/// JavaScript's `charCodeAt` hash over the code points, as `cast.ts`.
fn cast_hash(s: &str) -> u32 {
    s.chars().fold(0u32, |h, c| h.wrapping_mul(31).wrapping_add(c as u32))
}

/// The sprite prefix of a profile's animal and outfit (`castPrefix`).
pub fn cast_prefix(look: Option<(&str, &str)>, agent_id: &str, atlas: &Atlas) -> String {
    let species = look
        .map(|l| l.0.to_string())
        .unwrap_or_else(|| SPECIES[cast_hash(agent_id) as usize % SPECIES.len()].to_string());
    let outfit = look.map(|l| l.1).unwrap_or("farmer");
    [format!("{species}-{outfit}"), format!("{species}-farmer"), "bear-farmer".to_string()]
        .into_iter()
        .find(|p| atlas.has(&format!("{p}-down")))
        .unwrap_or_else(|| "bear-farmer".into())
}

fn side_of(f: Facing) -> &'static str {
    match f {
        Facing::Left | Facing::Right => "side",
        Facing::Up => "up",
        Facing::Down => "down",
    }
}

fn place_frames(key: &str) -> Option<(&'static [&'static str], f32)> {
    match key {
        "bench" => Some((&["sit"], 1.0)),
        "library" => Some((&["read"], 1.0)),
        "workshop" => Some((&["hammer-1", "hammer-2"], 3.0)),
        "mast" => Some((&["tinker-1", "tinker-2"], 1.5)),
        _ => None,
    }
}

struct Actor {
    walker: Walker,
    look: String,
    goal: Goal,
    bed: Option<Bed>,
    station: i32,
    left_at: Option<f32>,
    gone_for: f32,
    hop_at: f32,
    where_: Option<Whereabouts>,
    stroll: Option<Stroll>,
    pose: Option<PoseHold>,
    shown: Pose,
    /// Last drawn sprite box, for hits.
    bx: Box2,
}

/// The six farm tools (keys 1..6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FarmTool {
    #[default]
    Hand,
    Water,
    Bug,
    Weed,
    Harvest,
    Shovel,
}

impl FarmTool {
    pub const ALL: [FarmTool; 6] = [
        FarmTool::Hand,
        FarmTool::Water,
        FarmTool::Bug,
        FarmTool::Weed,
        FarmTool::Harvest,
        FarmTool::Shovel,
    ];

    pub fn from_index(i: usize) -> Option<FarmTool> {
        Self::ALL.get(i).copied()
    }

    pub fn label(self) -> String {
        vibevalley_i18n::t(
            match self {
                FarmTool::Hand => "web.farm.tool.hand.hint",
                FarmTool::Water => "web.farm.tool.water.hint",
                FarmTool::Bug => "web.farm.tool.bug.hint",
                FarmTool::Weed => "web.farm.tool.weed.hint",
                FarmTool::Harvest => "web.farm.tool.harvest.hint",
                FarmTool::Shovel => "web.farm.tool.shovel.hint",
            },
            &[],
        )
    }

    pub fn action(self, stage: &vibevalley_protocol::IssueStage) -> Option<&vibevalley_protocol::IssueAction> {
        use vibevalley_protocol::{IssueAct, IssueAction};
        let wanted = match self {
            Self::Bug => IssueAct::Cure,
            Self::Water => IssueAct::Tell,
            Self::Harvest => IssueAct::Complete,
            Self::Shovel if !stage.acts.iter().any(|a| matches!(a, IssueAction::Stop { act: IssueAct::Stop })) => IssueAct::Close,
            Self::Shovel => IssueAct::Stop,
            Self::Hand | Self::Weed => return None,
        };
        stage.acts.iter().find(|action| match action {
            IssueAction::Move { act, .. } | IssueAction::Say { act } | IssueAction::Stop { act } => *act == wanted,
        })
    }

    pub fn icon(self) -> &'static str {
        match self {
            FarmTool::Hand => "icon-hand",
            FarmTool::Water => "icon-water",
            FarmTool::Bug => "icon-bug",
            FarmTool::Weed => "icon-weed",
            FarmTool::Harvest => "icon-harvest",
            FarmTool::Shovel => "icon-shovel",
        }
    }
}

/// What a tap asks the app to do.
#[derive(Debug, Clone, PartialEq)]
pub enum FarmTap {
    /// A plot with a session: its issue (or the session when it has none).
    Plot {
        bed: usize,
        session: Option<String>,
        issue: Option<String>,
    },
    Spot {
        id: &'static str,
        opens: &'static str,
    },
    Dog,
    Ground,
}

pub struct FarmScene {
    pub world: VillageWorld,
    pub atlas: Arc<Atlas>,
    pub clock: DayClock,
    pub frame: Frame,
    pub profiles: Vec<vibevalley_protocol::Agent>,
    pub runtimes: Vec<vibevalley_protocol::RuntimeInfo>,
    pub reveal_names: bool,
    pub agent_looks: HashMap<String, (String, String)>,
    pub tool: FarmTool,
    pub panel: Option<Panel>,
    pub panel_page: usize,
    pub view_size: (f32, f32),
    pub achievements: Vec<vibevalley_protocol::Achievement>,
    pub phone: Phone,
    pub bed_fx: Option<(usize, u32, f32)>,
    pub toast: Option<(String, f32)>,
    actors: HashMap<String, Actor>,
    pub(super) t: f32,
    where_at: f32,
    stroll_at: f32,
    pub hover: Option<VillageHit>,
    dog: super::dog::Dog,
    life: super::life::Life,
    pointer: Option<Point>,
    sounds: Vec<&'static str>,
    heard_seq: Option<u64>,
    rng: u64,
    /// The farm on the page: only this repo's helpers, when set.
    pub repo: Option<String>,
}

impl FarmScene {
    pub fn new(world: VillageWorld, atlas: Arc<Atlas>) -> FarmScene {
        let life = super::life::Life::new(&world, &atlas);
        FarmScene {
            life,
            world,
            atlas,
            clock: DayClock::default(),
            frame: Frame::default(),
            profiles: Vec::new(),
            runtimes: Vec::new(),
            reveal_names: false,
            agent_looks: HashMap::new(),
            tool: FarmTool::Hand,
            panel: None,
            panel_page: 0,
            view_size: (768.0, 512.0),
            achievements: Vec::new(),
            phone: Phone::default(),
            bed_fx: None,
            toast: None,
            actors: HashMap::new(),
            t: 0.0,
            where_at: 0.0,
            stroll_at: 0.0,
            hover: None,
            dog: super::dog::Dog::default(),
            pointer: None,
            sounds: Vec::new(),
            heard_seq: None,
            rng: 0x9e3779b97f4a7c15,
            repo: None,
        }
    }

    pub fn drain_sounds(&mut self) -> impl Iterator<Item = &'static str> + '_ {
        self.sounds.drain(..)
    }

    pub fn apply_frame(&mut self, frame: Frame) {
        use vibevalley_protocol::{GameEffect, IssueStageKind, StuckReason};
        if self.heard_seq != Some(frame.seq) {
            if self.heard_seq.is_some() {
                for session in &frame.state.sessions {
                    if !self.frame.state.sessions.iter().any(|s| s.id == session.id) {
                        self.sounds.push("arrive");
                    }
                }
                for issue in &frame.state.issues {
                    let Some(now) = &issue.stage else {
                        continue;
                    };
                    let Some(was) = self.frame.state.issues.iter().find(|i| i.id == issue.id).and_then(|i| i.stage.as_ref()) else {
                        continue;
                    };
                    if now.state == IssueStageKind::Reviewing && was.state != now.state {
                        self.sounds.push("ripe");
                    }
                    if now.state == IssueStageKind::Stuck
                        && matches!(now.stuck, Some(StuckReason::Failed | StuckReason::Conflict))
                        && (was.state != now.state || was.stuck != now.stuck)
                    {
                        self.sounds.push("bug");
                    }
                }
                if self.frame.state.call != frame.state.call {
                    if frame.state.call == "live" {
                        self.sounds.push("voiceOn");
                    } else if frame.state.call == "idle" && matches!(self.frame.state.call.as_str(), "live" | "ending") {
                        self.sounds.push("voiceOff");
                    }
                }
            }
            for effect in &frame.effects {
                match effect {
                    GameEffect::Reward(r) => {
                        self.sounds.push("coin");
                        if let Some(s) = r.session_id.as_ref().and_then(|id| frame.state.sessions.iter().find(|s| &s.id == id))
                            && let Some(b) = bed_of_station(frame.station_of(s))
                        {
                            self.life.coin(self.world.plot_at(b.index) + pt(0., -PLOT_H / 2.));
                        }
                    }
                    GameEffect::LevelUp(_) => self.sounds.push("levelUp"),
                    GameEffect::Achievement(_) => self.sounds.push("achievement"),
                    GameEffect::Penalty(_) => {}
                }
            }
            self.heard_seq = Some(frame.seq);
        }
        self.frame = frame;
    }

    pub fn helper_feet(&self, id: &str) -> Option<Point> {
        let a = self.actors.get(id)?;
        a.left_at.is_none().then_some(pt(a.walker.x.round(), a.walker.y.round()))
    }

    pub fn show_toast(&mut self, text: impl Into<String>) {
        self.toast = Some((text.into(), self.t + 3.2));
    }

    pub fn play_bed_fx(&mut self, bed: usize, color: u32) {
        self.bed_fx = Some((bed, color, self.t + 0.15));
        self.life.bed(self.world.plot_at(bed) + pt(0., -PLOT_H / 2.), self.tool);
    }

    fn random(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        (self.rng >> 40) as f32 / (1u64 << 24) as f32
    }

    pub(super) fn workers(&self) -> Vec<Session> {
        let mut v: Vec<Session> = self
            .frame
            .state
            .sessions
            .iter()
            .filter(|s| s.is_worker() && (self.repo.is_none() || s.repo == self.repo))
            .cloned()
            .collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    fn crop_of(&self, s: &Session) -> Crop {
        self.frame.plot_of(s).map(|p| p.crop).unwrap_or(Crop::Sprout)
    }

    fn crop_of_bed(&self, bed: Bed, leaving: bool) -> Crop {
        if let Some(need) = bed.unlock_level {
            return if self.frame.view.level.level.round() as u32 >= need {
                Crop::Flowering
            } else {
                Crop::Locked
            };
        }
        match self.workers().into_iter().find(|s| self.frame.station_of(s) == bed.station) {
            None if leaving => Crop::Harvested,
            None => Crop::Empty,
            Some(s) => self.crop_of(&s),
        }
    }

    fn place_for(s: &Session, crop: Crop) -> &'static str {
        if plot_calls(crop) {
            return "plot";
        }
        s.doing().map(place_of_action).unwrap_or("plot")
    }

    /// Moves everything on by `dt` seconds.
    pub fn tick(&mut self, dt: f32) {
        let dt = dt.min(0.1);
        self.t += dt;
        self.clock.advance(dt);
        let dog_random = self.random();
        self.dog.advance(self.t, self.frame.state.call == "live", dog_random);
        self.phone.tick(std::time::Instant::now());
        let t = self.t;
        let move_on = t - self.where_at >= WHERE_TICK;
        if move_on {
            self.where_at = t;
        }
        let stroll = t - self.stroll_at >= STROLL_TICK;
        if stroll {
            self.stroll_at = t;
        }
        let workers = self.workers();
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut queued = 0usize;
        for s in &workers {
            let station = self.frame.station_of(s);
            let crop = self.crop_of(s);
            let pose = pose_of(s, crop);
            let calls = plot_calls(crop);
            let queue_index = if station < 0 {
                queued += 1;
                queued - 1
            } else {
                0
            };
            let configured_look = self.agent_looks.get(&s.agent).map(|(sp, out)| (sp.as_str(), out.as_str()));
            let look = cast_prefix(configured_look, &s.agent, &self.atlas);
            let place_want = Self::place_for(s, crop);
            let spots = spots_for(s, crop, pose);
            let working = s.phase.tag == "working";
            let (r1, r2, r3) = (self.random(), self.random(), self.random());
            if let Some(actor) = self.actors.get_mut(&s.id) {
                if actor.left_at.is_some() {
                    actor.left_at = None;
                    actor.gone_for = 0.0;
                }
                if station >= 0 {
                    let w = actor.where_.get_or_insert_with(|| Whereabouts::new("plot", t, place_want));
                    if move_on {
                        w.move_on(place_want, t, calls);
                    }
                    if stroll {
                        stroll_on(actor, &spots, working, t, (r1, r2, r3));
                    }
                } else {
                    actor.where_ = None;
                    actor.stroll = None;
                }
            }
            let actor = self.actors.get(&s.id);
            let place = actor.and_then(|a| a.where_.as_ref()).map(|w| w.place.clone()).unwrap_or_else(|| "plot".into());
            let crowd_key = place.clone();
            let crowd = counts.get(&crowd_key).copied().unwrap_or(0);
            let goal = self.world.goal_of(&GoalInput {
                here: true,
                station,
                queue_index,
                calls,
                place: &place,
                stroll: actor.and_then(|a| a.stroll),
                pose,
                crowd,
            });
            *counts.entry(goal.key.clone()).or_default() += 1;
            let world = &self.world;
            let actor = self.actors.entry(s.id.clone()).or_insert_with(|| {
                let mut walker = Walker::new(world.gate, WALK_SPEED);
                walker.go(goal.at, &world.nav);
                Actor {
                    walker,
                    look: look.clone(),
                    goal: goal.clone(),
                    bed: None,
                    station: -1,
                    left_at: None,
                    gone_for: 0.0,
                    hop_at: -10.0,
                    where_: (station >= 0).then(|| Whereabouts::new("plot", t, place_want)),
                    stroll: None,
                    pose: None,
                    shown: pose,
                    bx: Box2::default(),
                }
            });
            actor.look = look;
            actor.station = station;
            actor.bed = bed_of_station(station);
            actor.goal = goal.clone();
            actor.walker.go(goal.at, &world.nav);
            actor.walker.step(dt);
            let hold = actor.pose.get_or_insert_with(|| PoseHold::new(pose, t));
            actor.shown = hold.next(pose, t);
        }
        let present: Vec<&str> = workers.iter().map(|s| s.id.as_str()).collect();
        let gate = self.world.gate;
        self.actors.retain(|id, a| {
            if present.contains(&id.as_str()) {
                return true;
            }
            let left = *a.left_at.get_or_insert(t);
            if t - left >= GONE_S {
                return false;
            }
            a.goal = Goal {
                key: "gate".into(),
                at: gate,
                facing: None,
            };
            a.walker.go(gate, &self.world.nav);
            a.walker.step(dt);
            if let Some(h) = a.pose.as_mut() {
                a.shown = h.next(Pose::Idle, t);
            }
            if !a.walker.walking() {
                a.gone_for += dt;
            }
            true
        });
        let on_site = |place: &str| self.actors.values().any(|a| a.left_at.is_none() && !a.walker.walking() && a.goal.key == place);
        let walkers = self
            .actors
            .values()
            .filter(|a| a.walker.walking())
            .map(|a| pt(a.walker.x, a.walker.y))
            .collect::<Vec<_>>();
        let ripe = BEDS
            .iter()
            .filter(|b| b.station >= 0 && super::world::is_ripe(self.crop_of_bed(**b, false)))
            .map(|b| self.world.plot_box(b.index))
            .collect::<Vec<_>>();
        let activity = super::life::Activity {
            walkers: &walkers,
            library: on_site("library"),
            workshop: on_site("workshop"),
            mast: on_site("mast"),
            bench: on_site("bench"),
            ripe: &ripe,
            sleeping: self.dog_picture() == "dog-sleep",
        };
        self.life.step(&self.world, t, dt, 1. - super::super::sky::sun_of(self.clock.tod), activity);
    }

    fn sessions_hit_boxes(&self) -> Vec<(String, Box2)> {
        let mut v: Vec<(String, Box2, f32)> = self
            .actors
            .iter()
            .filter(|(_, a)| a.left_at.is_none())
            .map(|(id, a)| (id.clone(), a.bx, a.walker.y))
            .collect();
        v.sort_by(|a, b| a.2.total_cmp(&b.2));
        v.into_iter().map(|(id, b, _)| (id, b)).collect()
    }

    fn dog_box(&self) -> Option<Box2> {
        let name = self.dog_picture();
        let info = self.atlas.get(name)?;
        let (x, y) = self.atlas.top_left(name, self.world.dog.x, self.world.dog.y, false)?;
        Some(Box2 {
            x0: x,
            y0: y,
            x1: x + info.w,
            y1: y + info.h,
        })
    }

    pub fn hit_at(&self, p: Point) -> Option<VillageHit> {
        let plots: Vec<(usize, Box2)> = BEDS.iter().map(|b| (b.index, self.world.plot_box(b.index))).collect();
        village_hit_at(&self.sessions_hit_boxes(), self.dog_box(), &self.world.spot_boxes, &plots, p)
    }

    /// The pointer moved to `p` (art pixels), or left.
    pub fn point(&mut self, p: Option<Point>) {
        self.hover = p.and_then(|p| self.hit_at(p));
        self.pointer = p;
    }

    pub fn tap(&mut self, p: Point) -> FarmTap {
        match self.hit_at(p) {
            Some(VillageHit::Plot(bed)) => self.tap_bed(bed),
            Some(VillageHit::Session(id)) => {
                let bed = self.actors.get_mut(&id).map(|a| {
                    a.hop_at = self.t;
                    a.bed
                });
                match bed.flatten() {
                    Some(b) => self.tap_bed(b.index),
                    None => FarmTap::Ground,
                }
            }
            Some(VillageHit::Spot(id)) => FarmTap::Spot {
                id,
                opens: YARD_PLACES.iter().find(|p| p.id == id).map(|p| p.opens).unwrap_or(""),
            },
            Some(VillageHit::Dog) => {
                self.sounds.push(self.dog.pet(self.t));
                self.life.heart(self.world.dog + pt(1., -20.));
                FarmTap::Dog
            }
            None => {
                if let Some(sound) = self.life.poke(p) {
                    self.sounds.push(sound);
                }
                FarmTap::Ground
            }
        }
    }

    fn tap_bed(&self, bed: usize) -> FarmTap {
        let station = BEDS[bed].station;
        let s = self.workers().into_iter().find(|s| self.frame.station_of(s) == station && station >= 0);
        FarmTap::Plot {
            bed,
            session: s.as_ref().map(|s| s.id.clone()),
            issue: s.and_then(|s| s.issue),
        }
    }

    fn dog_picture(&self) -> &'static str {
        self.dog.look(self.t, self.hover == Some(VillageHit::Dog)).sprite
    }

    fn manager_picture(&self, list: &mut DrawList, id: &str, at: Point) {
        let pose = self.frame.state.sessions.iter().find(|s| s.role == "orchestrator" && s.agent == id);
        let speaking = pose.is_some_and(|s| s.doing() == Some("speaking_text"));
        let listening = pose.is_some_and(|s| !matches!(s.phase.tag.as_str(), "working" | "closed"));
        let look = self
            .profiles
            .iter()
            .find(|p| p.id == id)
            .and_then(|p| p.look.orchestrator)
            .map(|l| l.as_str())
            .unwrap_or("farmer");
        let candidate = format!("manager-{look}");
        let base = if look != "farmer" && self.atlas.has(&candidate) {
            candidate.as_str()
        } else {
            "manager"
        };
        let suffix = if speaking {
            "-talk"
        } else if listening {
            "-listen"
        } else {
            ""
        };
        let named = format!("{base}{suffix}");
        let name = if self.atlas.has(&named) { named.as_str() } else { base };
        if let (Some(image), Some(info), Some((x, y))) = (self.atlas.image(name), self.atlas.get(name), self.atlas.top_left(name, at.x, at.y, false)) {
            let breathe = frame_at(self.t, 2, if speaking { 4. } else { 0.6 }) as f32;
            list.ops.push(Op::Image {
                key: name.into(),
                image,
                x,
                y: y - breathe,
                w: info.w,
                h: info.h + breathe,
                alpha: 1.,
            });
        }
    }
    /// The scene's draw list; `scale` is view pixels per art pixel (for the HUD).
    pub fn draw(&mut self, scale: f32) -> DrawList {
        let w = &self.world;
        let atlas = self.atlas.clone();
        let mut list = DrawList::new(w.level.width, w.level.height, rgba(BACKGROUND, 1.0));
        list.sprite(&atlas, "map", 0.0, 0.0, false, 1.0);
        if let Some(Op::Sprite { x, y, .. }) = list.ops.last_mut() {
            *x = 0.0;
            *y = 0.0;
        }
        // Everything standing on the ground, drawn by the y of its feet.
        let mut ground: Vec<(f32, Vec<Op>)> = Vec::new();
        let hover_bed = match &self.hover {
            Some(VillageHit::Plot(b)) => Some(*b),
            Some(VillageHit::Session(id)) => self.actors.get(id).and_then(|a| a.bed.map(|b| b.index)),
            _ => None,
        };
        let hover_spot = match &self.hover {
            Some(VillageHit::Spot(s)) => Some(*s),
            _ => None,
        };
        let leaving_stations: Vec<i32> = self.actors.values().filter(|a| a.left_at.is_some()).map(|a| a.station).collect();
        for bed in BEDS {
            let at = w.plot_at(bed.index);
            let leaving = bed.unlock_level.is_none()
                && leaving_stations.contains(&bed.station)
                && !self.workers().iter().any(|s| self.frame.station_of(s) == bed.station);
            let crop = self.crop_of_bed(bed, leaving);
            let hot = hover_bed == Some(bed.index);
            let mut ops = Vec::new();
            let mut l = DrawList::default();
            l.sprite(&atlas, &format!("plot-{}", crop.name()), at.x, at.y + if hot { -1.0 } else { 0.0 }, false, 1.0);
            ops.extend(l.ops);
            if hot {
                let (x0, y0) = (at.x - PLOT_W / 2.0 - 1.0, at.y - PLOT_H - 4.0);
                let ring = rgba(0xffe9a0, 1.0);
                ops.push(Op::Rect {
                    x: x0,
                    y: y0,
                    w: PLOT_W + 2.0,
                    h: 1.0,
                    color: ring,
                });
                ops.push(Op::Rect {
                    x: x0,
                    y: y0 + PLOT_H + 4.0,
                    w: PLOT_W + 2.0,
                    h: 1.0,
                    color: ring,
                });
                ops.push(Op::Rect {
                    x: x0,
                    y: y0,
                    w: 1.0,
                    h: PLOT_H + 5.0,
                    color: ring,
                });
                ops.push(Op::Rect {
                    x: x0 + PLOT_W + 1.0,
                    y: y0,
                    w: 1.0,
                    h: PLOT_H + 5.0,
                    color: ring,
                });
            }
            ground.push((at.y - PLOT_H, ops));
        }
        for p in &w.props {
            if !atlas.has(&p.sprite) {
                continue;
            }
            let lift = if hover_spot == Some(p.spot.as_str()) { 1.0 } else { 0.0 };
            let mut l = DrawList::default();
            contact_shadow(
                &mut l,
                p.at + pt(0., -1.),
                (atlas.get(&p.sprite).map_or(10., |s| s.w * 0.9)).round().max(10.),
                5.,
                0.5,
                1.,
            );
            l.sprite(&atlas, &p.sprite, p.at.x, p.at.y - lift, false, 1.0);
            ground.push((p.at.y, l.ops));
        }
        {
            let mut l = DrawList::default();
            footing(&mut l, w.orchestrator, 14., self.clock.tod, 1.);
            let lift = if hover_spot == Some("manager") { 1.0 } else { 0.0 };
            self.manager_picture(&mut l, "orchestrator", w.orchestrator + pt(0., -lift));
            ground.push((w.orchestrator.y, l.ops));
        }
        for (i, profile) in self
            .profiles
            .iter()
            .filter(|p| p.role == vibevalley_protocol::AgentRole::Orchestrator && p.id != "orchestrator")
            .enumerate()
        {
            let at = w.orchestrator + pt(if i % 2 == 0 { 1. } else { -1. } * 18. * (i / 2 + 1) as f32, 2.);
            let mut l = DrawList::default();
            self.manager_picture(&mut l, &profile.id, at);
            ground.push((at.y, l.ops));
        }
        {
            let mut l = DrawList::default();
            footing(&mut l, w.dog, 16., self.clock.tod, 1.);
            let look = self.dog.look(self.t, self.hover == Some(VillageHit::Dog));
            let (x, y) = atlas.top_left(look.sprite, w.dog.x, w.dog.y - look.lift, false).unwrap_or((w.dog.x, w.dog.y));
            if let (Some(info), Some(image)) = (atlas.get(look.sprite), atlas.image(look.sprite)) {
                l.ops.push(Op::Image {
                    key: look.sprite.into(),
                    image,
                    x,
                    y: y - look.grow,
                    w: info.w,
                    h: info.h + look.grow,
                    alpha: 1.,
                });
            }
            ground.push((w.dog.y, l.ops));
        }
        let t = self.t;
        let mut boxes = Vec::new();
        for (id, a) in &self.actors {
            let alpha = (1.0 - a.gone_for / FADE_S).max(0.0);
            if alpha <= 0.0 {
                continue;
            }
            let (name, flip, mut lift) = actor_picture(a, t, &atlas);
            let since = t - a.hop_at;
            if since < HOP_S {
                lift += HOP[((since / HOP_S * HOP.len() as f32) as usize).min(HOP.len() - 1)];
            }
            let (x, y) = (a.walker.x.round(), a.walker.y.round());
            let mut l = DrawList::default();
            footing(&mut l, pt(x, y), 12., self.clock.tod, alpha);
            l.sprite(&atlas, &name, x, y - lift, flip, alpha);
            if let (Some(info), Some((x0, y0))) = (atlas.get(&name), atlas.top_left(&name, x, y - lift, flip)) {
                boxes.push((
                    id.clone(),
                    Box2 {
                        x0,
                        y0,
                        x1: x0 + info.w,
                        y1: y0 + info.h,
                    },
                ));
            }
            ground.push((a.walker.y, l.ops));
        }
        for (id, b) in boxes {
            if let Some(a) = self.actors.get_mut(&id) {
                a.bx = b;
            }
        }
        ground.sort_by(|a, b| a.0.total_cmp(&b.0));
        for (_, ops) in ground {
            list.ops.extend(ops);
        }
        self.life.draw_ground(&mut list, &atlas, t, 1. - super::super::sky::sun_of(self.clock.tod));
        let w = &self.world;
        let foreground_start = list.ops.len();
        let near = [
            ("fg-branch-left", -20.0, -30.0, 0.0, 0.0),
            ("fg-branch-right", w.level.width + 20.0, -32.0, 1.0, 0.0),
            ("fg-bush-left", -30.0, w.level.height + 26.0, 0.0, 1.0),
            ("fg-bush-right", w.level.width + 34.0, w.level.height + 32.0, 1.0, 1.0),
            ("fg-grass", w.level.width * 0.34, w.level.height + 16.0, 0.5, 1.0),
            ("fg-fern", w.level.width * 0.6, w.level.height + 24.0, 0.5, 1.0),
        ];
        let lean = self
            .pointer
            .map(|p| {
                pt(
                    ((p.x / w.level.width * 2. - 1.).clamp(-1., 1.) * 3.).round(),
                    ((p.y / w.level.height * 2. - 1.).clamp(-1., 1.) * 3.).round(),
                )
            })
            .unwrap_or_default();
        for (name, x, y, ax, ay) in near {
            if let Some(info) = atlas.get(name) {
                list.ops.push(Op::Sprite {
                    name: name.into(),
                    x: x - ax * info.w + lean.x,
                    y: y - ay * info.h + lean.y,
                    flip: false,
                    alpha: 1.0,
                });
            }
        }
        // Light: the sky darkens the picture, lamps and lanterns shine through.
        let foreground_end = list.ops.len();
        let mut lamps = Vec::new();
        let sky = sky_at(self.clock.tod);
        let flat = flat_light(&sky);
        list.light = Some(flat);
        list.lit = list.ops.len();
        let night = sky.night;
        if night > 0.02 {
            for (i, (at, r)) in w.lights.iter().enumerate() {
                let flicker = 0.9 + 0.1 * frame_at(t + i as f32 * 0.37, 2, 3.0) as f32;
                lamps.push(vibevalley_pixel::PointLight {
                    x: at.x,
                    y: at.y,
                    z: 14.,
                    radius: r * 2.6,
                    color: rgba(LAMP, 1.)[..3].try_into().unwrap(),
                    intensity: 1.3 * night * flicker,
                });
                list.ops.push(Op::Glow {
                    x: at.x,
                    y: at.y,
                    r: (r * 0.8).round().max(4.0),
                    color: rgba(LAMP, 0.55 * night * flicker),
                });
            }
        }
        if night > LANTERN_DARK {
            let shine = (night - LANTERN_DARK) / (1.0 - LANTERN_DARK);
            for a in self.actors.values() {
                let alpha = (1.0 - a.gone_for / FADE_S).max(0.0) * shine;
                let side = if a.walker.facing == Facing::Left { -5.0 } else { 5.0 };
                let (x, y) = (a.walker.x.round() + side, a.walker.y.round() - 11.0);
                lamps.push(vibevalley_pixel::PointLight {
                    x,
                    y,
                    z: 10.,
                    radius: 34.,
                    color: rgba(LANTERN, 1.)[..3].try_into().unwrap(),
                    intensity: 0.6 * alpha,
                });
                list.ops.push(Op::Glow {
                    x,
                    y,
                    r: 9.0,
                    color: rgba(LANTERN, 0.5 * alpha),
                });
                list.rect(x - 1.0, y - 1.0, 2.0, 3.0, rgba(0xffb347, alpha));
                list.rect(x - 1.0, y, 2.0, 1.0, rgba(0xfff1c2, alpha));
            }
        }
        self.life.draw_lights(&mut list, &atlas, t, night, &mut lamps);
        lamps.sort_by(|a, b| (b.intensity * b.radius).total_cmp(&(a.intensity * a.radius)));
        list.farm_light = Some(super::super::draw::FarmLight {
            lighting: vibevalley_pixel::Lighting {
                ambient: sky.ambient,
                sun: sky.sun,
                dir: sky.sun_dir,
                clouds: sky.clouds,
                mist: sky.mist,
                grade: sky.grade,
                time: t,
                lamps,
            },
            foreground: foreground_start..foreground_end,
        });
        hud::draw(self, &mut list, scale);
        list
    }

    pub fn debug_state(&self) -> serde_json::Value {
        let mut actors: Vec<_> = self
            .actors
            .iter()
            .map(|(id, a)| {
                serde_json::json!({
                    "id": id, "look": a.look, "goal": a.goal.key, "at": [a.walker.x.round(), a.walker.y.round()],
                    "walking": a.walker.walking(), "pose": format!("{:?}", a.shown), "station": a.station,
                    "leaving": a.left_at.is_some(),
                })
            })
            .collect();
        actors.sort_by_key(|v| v["id"].as_str().unwrap_or_default().to_string());
        let beds: Vec<&str> = BEDS.iter().map(|b| self.crop_of_bed(*b, false).name()).collect();
        serde_json::json!({
            "seq": self.frame.seq, "t": self.t, "clock": clock_text(self.clock.tod), "actors": actors, "beds": beds,
            "hover": format!("{:?}", self.hover), "level": self.frame.view.level.level,
            "panel": format!("{:?}", self.panel), "page": self.panel_page, "tool": format!("{:?}", self.tool),
            "hud": [self.view_size.0, self.view_size.1], "toast": self.toast,
        })
    }
}

fn stroll_on(actor: &mut Actor, allowed: &[StrollSpot], working: bool, t: f32, r: (f32, f32, f32)) {
    if let Some(cur) = actor.stroll
        && allowed.contains(&cur.spot)
        && t < cur.until
    {
        return;
    }
    let options: Vec<StrollSpot> = match actor.stroll {
        Some(cur) if allowed.len() > 1 => allowed.iter().copied().filter(|x| *x != cur.spot || *x == StrollSpot::Rest).collect(),
        _ => allowed.to_vec(),
    };
    let spot = options.get((r.0 * options.len() as f32) as usize).copied().unwrap_or(allowed[0]);
    let (lo, hi) = if working { (5.0, 11.0) } else { (7.0, 15.0) };
    actor.stroll = Some(Stroll {
        spot,
        rest: (r.1 * REST_SPOTS as f32) as usize,
        until: t + lo + r.2 * (hi - lo),
    });
}

fn actor_picture(a: &Actor, t: f32, atlas: &Atlas) -> (String, bool, f32) {
    let look = &a.look;
    let has = |n: &str| atlas.has(n);
    let (name, flip, lift) = if a.walker.walking() {
        let dir = side_of(a.walker.facing);
        let cycle = [format!("{dir}-1"), dir.to_string(), format!("{dir}-2"), dir.to_string()];
        (format!("{look}-{}", cycle[frame_at(t, 4, WALK_FPS)]), a.walker.facing == Facing::Left, 0.0)
    } else if let Some((frames, fps)) = place_frames(&a.goal.key).filter(|(f, _)| has(&format!("{look}-{}", f[0]))) {
        (
            format!("{look}-{}", frames[frame_at(t, frames.len(), fps)]),
            a.goal.facing == Some(Facing::Left),
            0.0,
        )
    } else {
        let facing = a.goal.facing.unwrap_or(a.walker.facing);
        match a.shown {
            Pose::Work if place_frames(&a.goal.key).is_some() => (format!("{look}-{}", side_of(facing)), facing == Facing::Left, 0.0),
            Pose::Work => (format!("{look}-work"), false, 0.0),
            Pose::Cheer => (format!("{look}-cheer"), false, frame_at(t, 2, 2.0) as f32 * 2.0),
            Pose::Worry => (format!("{look}-worry"), false, 0.0),
            _ => (format!("{look}-{}", side_of(facing)), facing == Facing::Left, 0.0),
        }
    };
    if has(&name) {
        (name, flip, lift)
    } else {
        (format!("{look}-down"), false, lift)
    }
}

fn contact_shadow(list: &mut DrawList, at: Point, w: f32, h: f32, alpha: f32, stretch: f32) {
    let width = w as u32;
    let height = h as u32;
    let image = image::RgbaImage::from_fn(width, height, |x, y| {
        let dx = (x as f32 + 0.5) / w * 2. - 1.;
        let dy = (y as f32 + 0.5) / h * 2. - 1.;
        let d = dx.hypot(dy);
        image::Rgba([
            0x1f,
            0x16,
            0x0c,
            if d < 0.6 {
                255
            } else if d < 1. {
                140
            } else {
                0
            },
        ])
    });
    list.ops.push(Op::Image {
        key: format!("footing:{width}:{height}"),
        image: Arc::new(image),
        x: at.x - w * stretch / 2.,
        y: at.y - h / 2.,
        w: w * stretch,
        h,
        alpha,
    });
}
fn footing(list: &mut DrawList, at: Point, w: f32, tod: f32, fade: f32) {
    let sky = sky_at(tod);
    let reach = (-sky.sun_dir[0] / sky.sun_dir[2].max(0.35) * 2.5).clamp(-6., 6.);
    contact_shadow(
        list,
        at + pt((reach / 2.).round(), 0.),
        w + 4.,
        4.,
        fade * 0.3 * (0.35 + 0.65 * (1. - sky.night)),
        1. + reach.abs() / 8.,
    );
    contact_shadow(list, at, w, 4., fade * 0.5, 1.);
}
