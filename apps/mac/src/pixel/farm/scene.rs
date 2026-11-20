//! Draws the active repository from the latest frame and advances its helpers between frames.

use std::collections::HashMap;
use std::sync::Arc;

use indexmap::IndexMap;

use super::super::atlas::Atlas;
use super::super::draw::{DrawList, Op, rgba};
use super::super::level::{Box2, Point, pt};
use super::super::nav::{Facing, Walker, frame_at};
use super::super::projection::ground;
use super::super::sky::{DayClock, clock_text, flat_light, sky_at};
use super::frame::{Crop, Frame, Session};
use super::hud::{self, Panel};
use super::phone::Phone;
use super::world::{
    BEDS, Bed, Goal, GoalInput, LightSource, PLOT_H, Pose, PoseHold, REST_SPOTS, Stroll, StrollSpot, VillageHit, VillageWorld, Whereabouts, YARD_PLACES,
    bed_of_station, box_corners, place_of_action, plot_calls, pose_of, projected_box, spots_for,
};

const WALK_SPEED: f32 = 42.0;
const STRIDE_LENGTH: f32 = 15.0;
const FADE_S: f32 = 0.8;
const GONE_S: f32 = 3.6;
const WHERE_TICK: f32 = 0.3;
const STROLL_TICK: f32 = 0.6;
const HOP: [f32; 6] = [2.0, 4.0, 5.0, 4.0, 2.0, 1.0];
const HOP_S: f32 = 0.3;
const BACKGROUND: u32 = 0x2b3320;

const SPECIES: [&str; 7] = ["bear", "rabbit", "fox", "cat", "owl", "hedgehog", "raccoon"];

/// JavaScript's `charCodeAt` hash over the code points, as `cast.ts`.
fn cast_hash(s: &str) -> u32 {
    s.chars().fold(0u32, |h, c| h.wrapping_mul(31).wrapping_add(c as u32))
}

pub fn profile_looks(agents: &[vibevalley_protocol::Agent]) -> HashMap<String, (String, String)> {
    agents
        .iter()
        .filter_map(|agent| {
            let species = agent.look.species?.as_str();
            let outfit = agent.look.outfit.map(|o| o.as_str()).unwrap_or("farmer");
            Some((agent.id.clone(), (species.into(), outfit.into())))
        })
        .collect()
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
    pose: PoseHold,
    shown: Pose,
    stride: f32,
    travel_facing: Facing,
    arrived_at: f32,
    /// Last drawn sprite box, for hits.
    bx: Box2,
}

impl Actor {
    fn step(&mut self, goal: Goal, world: &VillageWorld, now: f32, dt: f32, pose: Pose) {
        let shown = self.pose.next(pose, now);
        let old = ground(pt(self.walker.x, self.walker.y));
        self.walker.go(goal.at, &world.nav);
        if self.walker.walking() || self.goal != goal || shown != self.shown {
            self.arrived_at = now;
        }
        self.walker.step(dt);
        let moved = ground(pt(self.walker.x, self.walker.y));
        let (dx, dy) = (moved.x - old.x, moved.y - old.y);
        let distance = dx.hypot(dy);
        if distance > 0.01 {
            self.stride = (self.stride + distance) % STRIDE_LENGTH;
            self.travel_facing = if dx.abs() > dy.abs() {
                if dx > 0. { Facing::Right } else { Facing::Left }
            } else if dy > 0. {
                Facing::Down
            } else {
                Facing::Up
            };
        }
        self.goal = goal;
        self.shown = shown;
    }

    fn lift(&self, now: f32) -> f32 {
        let since = now - self.hop_at;
        if since >= HOP_S {
            return 0.;
        }
        HOP[((since / HOP_S * HOP.len() as f32) as usize).min(HOP.len() - 1)]
    }

    fn stationary_frame(&self, now: f32, fps: f32) -> usize {
        frame_at(now - self.arrived_at, 8, fps)
    }
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
    pub(super) friend_arrows: Option<[Arc<image::RgbaImage>; 2]>,
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
    bed_pressed: Option<(usize, f64)>,
    pub toast: Option<(String, f64)>,
    actors: IndexMap<String, Actor>,
    pub(super) t: f64,
    where_at: f32,
    stroll_at: f32,
    pub hover: Option<VillageHit>,
    dog: super::dog::Dog,
    life: super::life::Life,
    capture: Option<super::capture::Motion>,
    pointer: Option<Point>,
    lean: Point,
    pressed: Option<Option<VillageHit>>,
    sounds: Vec<&'static str>,
    heard_seq: Option<u64>,
    rng: u64,
    /// The farm on the page: only this repo's helpers, when set.
    pub repo: Option<String>,
}

impl FarmScene {
    pub fn new(world: VillageWorld, atlas: Arc<Atlas>) -> FarmScene {
        let mut life = super::life::Life::new(&world, &atlas);
        let capture = super::capture::Motion::read();
        let mut clock = DayClock::default();
        if let Some(motion) = &capture {
            life.seed_fireflies(motion.firefly_seed);
            clock.tod = motion.tod;
            clock.speed = 0.;
        }
        let friend_arrows = atlas
            .image("button-next")
            .map(|image| [Arc::new(image::imageops::rotate90(&*image)), Arc::new(image::imageops::rotate270(&*image))]);
        FarmScene {
            life,
            friend_arrows,
            world,
            atlas,
            clock,
            capture,
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
            bed_pressed: None,
            toast: None,
            actors: IndexMap::new(),
            t: 0.0,
            where_at: 0.0,
            stroll_at: 0.0,
            hover: None,
            dog: super::dog::Dog::default(),
            pointer: None,
            lean: Point::default(),
            pressed: None,
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
                            self.life.coin(ground(self.world.plot_at(b.index) + pt(0., -PLOT_H / 2.)));
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
        a.left_at.is_none().then(|| ground(pt(a.walker.x, a.walker.y)))
    }

    pub fn show_toast(&mut self, text: impl Into<String>) {
        self.toast = Some((text.into(), self.t + 3.2));
    }

    pub fn play_bed_fx(&mut self, bed: usize) {
        self.bed_pressed = Some((bed, self.t + 0.15));
        self.life.bed(ground(self.world.plot_at(bed) + pt(0., -PLOT_H / 2.)), self.tool);
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

    pub(super) fn hovered_bed(&self) -> Option<usize> {
        match &self.hover {
            Some(VillageHit::Plot(index)) => Some(*index),
            Some(VillageHit::Session(id)) => self.actors.get(id).and_then(|actor| actor.bed.map(|bed| bed.index)),
            _ => None,
        }
    }

    pub(super) fn crop_of_bed(&self, bed: Bed, leaving: bool) -> Crop {
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
    pub fn tick(&mut self, dt: f64) {
        let dt = match &mut self.capture {
            Some(motion) => {
                let Some(step) = motion.next(self.frame.seq) else { return };
                step
            }
            None => dt.min(0.1),
        };
        self.t += dt;
        let t = self.t as f32;
        let dt = dt as f32;
        self.clock.advance(dt);
        let aim = self
            .pointer
            .map(|p| {
                pt(
                    (p.x / self.world.level.width * 2. - 1.).clamp(-1., 1.),
                    (p.y / self.world.level.height * 2. - 1.).clamp(-1., 1.),
                )
            })
            .unwrap_or_default();
        let k = (dt * 2.5).min(1.);
        self.lean.x += (aim.x * 0.7 + (t * 0.13).sin() * 0.3 - self.lean.x) * k;
        self.lean.y += (aim.y * 0.7 + (t * 0.09 + 1.3).sin() * 0.3 - self.lean.y) * k;
        let dog_random = self.life.random();
        self.dog.advance(t, self.frame.state.call == "live", dog_random);
        self.phone.tick(std::time::Instant::now());
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
            let pose = pose_of(s, crop, self.frame.stage_of(s));
            let calls = pose == Pose::Ask || plot_calls(crop);
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
                    pose: PoseHold::new(pose, t),
                    shown: pose,
                    stride: 0.,
                    travel_facing: Facing::Down,
                    arrived_at: t,
                    bx: Box2::default(),
                }
            });
            actor.look = look;
            actor.station = station;
            actor.bed = bed_of_station(station);
            actor.step(goal, world, t, dt, pose);
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
            let goal = Goal {
                key: "gate".into(),
                at: gate,
                facing: None,
            };
            a.step(goal, &self.world, t, dt, Pose::Idle);
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
            .map(|a| ground(pt(a.walker.x, a.walker.y)))
            .collect::<Vec<_>>();
        let ripe = BEDS
            .iter()
            .filter(|b| b.station >= 0 && super::world::is_ripe(self.crop_of_bed(**b, false)))
            .map(|b| projected_box(self.world.plot_box(b.index)))
            .collect::<Vec<_>>();
        let activity = super::life::Activity {
            walkers: &walkers,
            library: on_site("library"),
            workshop: on_site("workshop"),
            hammer_strike: self.actors.values().any(|a| {
                !a.walker.walking()
                    && a.shown == Pose::Work
                    && a.goal.key == "workshop"
                    && matches!(a.goal.facing, Some(Facing::Right | Facing::Left))
                    && a.stationary_frame(t, 8.) == 5
                    && a.stationary_frame(t - dt, 8.) != 5
            }),
            mast: on_site("mast"),
            bench: on_site("bench"),
            ripe: &ripe,
            sleeping: self.dog_picture() == "dog-sleep",
        };
        self.life.step(&self.world, t, dt, 1. - super::super::sky::sun_of(self.clock.tod), activity);
    }

    pub(super) fn plot_foot(&self, index: usize) -> Point {
        ground(self.world.plot_at(index))
    }

    fn sprite_contains(&self, name: &str, feet: Point, flip: bool, p: Point) -> bool {
        let Some((x, y)) = self.atlas.top_left(name, feet.x, feet.y, flip) else {
            return false;
        };
        let (u, v) = ((p.x - x) * self.atlas.density, (p.y - y) * self.atlas.density);
        let Some(info) = self.atlas.get(name) else { return false };
        if u < 0. || v < 0. || u >= info.w * self.atlas.density || v >= info.h * self.atlas.density {
            return false;
        }
        self.atlas.image(name).is_some_and(|image| {
            let x = if flip { image.width() - 1 - u as u32 } else { u as u32 };
            image.get_pixel_checked(x, v as u32).is_some_and(|pixel| pixel[3] >= 128)
        })
    }

    pub fn hit_at(&self, p: Point) -> Option<VillageHit> {
        let mut nearest = self.atlas.landmark_at(p).map(|(id, depth)| (depth, VillageHit::Spot(id)));
        let mut consider = |hit, depth: f32, inside: bool| {
            if inside && nearest.as_ref().is_none_or(|(last, _)| depth >= *last) {
                nearest = Some((depth, hit));
            }
        };
        for bed in BEDS {
            let b = self.world.plot_box(bed.index);
            let at = self.plot_foot(bed.index);
            let name = format!("plot-{}", self.crop_of_bed(bed, false).name());
            consider(
                VillageHit::Plot(bed.index),
                ground(pt((b.x0 + b.x1) * 0.5, (b.y0 + b.y1) * 0.5)).y,
                self.sprite_contains(&name, at, false, p),
            );
        }
        for prop in &self.world.props {
            let at = ground(prop.at);
            if let Some(place) = YARD_PLACES.iter().find(|place| place.id == prop.spot) {
                consider(VillageHit::Spot(place.id), at.y, self.sprite_contains(&prop.sprite, at, false, p));
            }
        }
        let manager = ground(self.world.orchestrator);
        consider(VillageHit::Spot("manager"), manager.y, self.sprite_contains("manager", manager, false, p));
        let dog = ground(self.world.dog);
        consider(VillageHit::Dog, dog.y, self.sprite_contains(self.dog_picture(), dog, false, p));
        for (id, a) in self.actors.iter().filter(|(_, a)| a.left_at.is_none() && a.bx.contains(p)) {
            let (name, flip) = actor_picture(a, self.t as f32);
            let at = ground(pt(a.walker.x, a.walker.y));
            let feet = pt(at.x.round(), at.y.round() - a.lift(self.t as f32));
            consider(VillageHit::Session(id.clone()), at.y, self.sprite_contains(&name, feet, flip, p));
        }
        nearest.map(|(_, hit)| hit)
    }

    /// The pointer moved to `p` (art pixels), or left.
    pub fn point(&mut self, p: Option<Point>) {
        self.hover = p.and_then(|p| self.hit_at(p));
        self.pointer = p;
        if p.is_none() {
            self.clear_press();
        }
    }

    pub fn press_at(&mut self, p: Point) {
        self.pressed = Some(self.hit_at(p));
    }
    pub fn release_at(&mut self, p: Point) -> bool {
        self.pressed.take() == Some(self.hit_at(p))
    }
    pub fn clear_press(&mut self) {
        self.pressed = None;
    }

    pub fn tap(&mut self, p: Point) -> FarmTap {
        match self.hit_at(p) {
            Some(VillageHit::Plot(bed)) => {
                self.bed_pressed = Some((bed, self.t + 0.15));
                self.tap_bed(bed)
            }
            Some(VillageHit::Session(id)) => {
                let bed = self.actors.get_mut(&id).map(|a| {
                    a.hop_at = self.t as f32;
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
                self.sounds.push(self.dog.pet(self.t as f32));
                self.life.heart(ground(self.world.dog) + pt(1., -20.));
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
        self.dog.look(self.t as f32, self.hover == Some(VillageHit::Dog)).sprite
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
        let mut layers: Vec<(f32, Vec<Op>)> = Vec::new();
        let hover_bed = self.hovered_bed();
        let hover_spot = match &self.hover {
            Some(VillageHit::Spot(s)) => Some(*s),
            _ => None,
        };
        let workers = self.workers();
        let leaving_stations: Vec<i32> = self.actors.values().filter(|a| a.left_at.is_some()).map(|a| a.station).collect();
        let attention_pulse = 0.45 + 0.45 * (self.t as f32 * 3.5).sin();
        for bed in BEDS {
            let footprint = w.plot_box(bed.index);
            let at = self.plot_foot(bed.index);
            let session = (bed.unlock_level.is_none() && bed.station >= 0)
                .then(|| workers.iter().find(|s| self.frame.station_of(s) == bed.station))
                .flatten();
            let leaving = bed.unlock_level.is_none() && leaving_stations.contains(&bed.station) && session.is_none();
            let crop = self.crop_of_bed(bed, leaving);
            let hot = hover_bed == Some(bed.index);
            let mut ops = Vec::new();
            let mut l = DrawList::default();
            let pressed =
                self.pressed == Some(Some(VillageHit::Plot(bed.index))) && hot || self.bed_pressed.is_some_and(|(i, until)| i == bed.index && self.t < until);
            l.sprite(
                &atlas,
                &format!("plot-{}", crop.name()),
                at.x,
                at.y + if pressed {
                    1.
                } else if hot {
                    -1.0
                } else {
                    0.0
                },
                false,
                1.0,
            );
            ops.extend(l.ops);
            let ring = if hot {
                Some(rgba(0xffe9a0, 1.0))
            } else if let Some(s) = session {
                let tone = self.frame.plot_of(s).and_then(|p| p.badge.as_ref()).map(|b| b.tone.as_str());
                let hex = match tone {
                    Some("wait") => Some(0xffa94d),
                    Some("ripe") => Some(0xffe066),
                    Some("bug") => Some(0xff6b57),
                    Some("stuck") => Some(0x7db7db),
                    _ if crop == Crop::Dry => Some(0xffa94d),
                    _ if super::world::is_ripe(crop) => Some(0xffe066),
                    _ if crop == Crop::Withered => Some(0xff6b57),
                    _ => None,
                };
                hex.map(|c| rgba(c, attention_pulse))
            } else {
                None
            };
            if let Some(ring) = ring {
                let corners = box_corners(footprint).map(ground);
                for (i, corner) in corners.iter().enumerate() {
                    let next = corners[(i + 1) % corners.len()];
                    let delta = pt(next.x - corner.x, next.y - corner.y);
                    let steps = delta.x.abs().max(delta.y.abs()).ceil().max(1.) as i32;
                    for step in 0..steps {
                        let f = step as f32 / steps as f32;
                        ops.push(Op::Rect {
                            x: (corner.x + f * delta.x).round(),
                            y: (corner.y + f * delta.y).round(),
                            w: 1.,
                            h: 1.,
                            color: ring,
                        });
                    }
                }
            }
            layers.push((ground(pt((footprint.x0 + footprint.x1) * 0.5, (footprint.y0 + footprint.y1) * 0.5)).y, ops));
        }
        for p in &w.props {
            if !atlas.has(&p.sprite) {
                continue;
            }
            let at = ground(p.at);
            let lift = if hover_spot == Some(p.spot.as_str()) { 1.0 } else { 0.0 };
            let mut l = DrawList::default();
            contact_shadow(
                &mut l,
                at + pt(0., -1.),
                (atlas.get(&p.sprite).map_or(10., |s| s.w * 0.9)).round().max(10.),
                5.,
                0.5,
                1.,
            );
            l.sprite(&atlas, &p.sprite, at.x, at.y - lift, false, 1.0);
            layers.push((at.y, l.ops));
        }
        {
            let mut l = DrawList::default();
            let at = ground(w.orchestrator);
            footing(&mut l, at, 14., self.clock.tod, 1.);
            let lift = if hover_spot == Some("manager") { 1.0 } else { 0.0 };
            self.manager_picture(&mut l, "orchestrator", at + pt(0., -lift));
            layers.push((at.y, l.ops));
        }
        for (i, profile) in self
            .profiles
            .iter()
            .filter(|p| p.role == vibevalley_protocol::AgentRole::Orchestrator && p.id != "orchestrator")
            .enumerate()
        {
            let at = ground(w.orchestrator + pt(if i % 2 == 0 { 1. } else { -1. } * 18. * (i / 2 + 1) as f32, 2.));
            let mut l = DrawList::default();
            footing(&mut l, at, 14., self.clock.tod, 1.);
            self.manager_picture(&mut l, &profile.id, at);
            layers.push((at.y, l.ops));
        }
        {
            let mut l = DrawList::default();
            let at = ground(w.dog);
            footing(&mut l, at, 16., self.clock.tod, 1.);
            let mut look = self.dog.look(self.t as f32, self.hover == Some(VillageHit::Dog));
            if self.pressed == Some(Some(VillageHit::Dog)) {
                look.grow = -1.;
            }
            let (x, y) = atlas.top_left(look.sprite, at.x, at.y - look.lift, false).unwrap_or((at.x, at.y));
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
            layers.push((at.y, l.ops));
        }
        let t = self.t as f32;
        let mut boxes = Vec::new();
        for (id, a) in &self.actors {
            let alpha = (1.0 - a.gone_for / FADE_S).max(0.0);
            if alpha <= 0.0 {
                continue;
            }
            let (name, flip) = actor_picture(a, t);
            let lift = a.lift(t);
            let feet = ground(pt(a.walker.x, a.walker.y));
            let (x, y) = (feet.x.round(), feet.y.round());
            let mut l = DrawList::default();
            footing(&mut l, pt(x, y), 12., self.clock.tod, alpha);
            l.sprite(&atlas, &name, x, y - lift, flip, alpha);
            if let Some(ink) = atlas.visible_box(&name, x, y - lift, flip) {
                boxes.push((id.clone(), ink));
            }
            layers.push((feet.y, l.ops));
        }
        for (id, b) in boxes {
            if let Some(a) = self.actors.get_mut(&id) {
                a.bx = b;
            }
        }
        layers.sort_by_key(|item| (item.0 * 10.).round() as i32);
        for (depth, ops) in layers {
            let start = list.ops.len();
            list.ops.extend(ops);
            list.occludable.push((start..list.ops.len(), depth));
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
        let lean = pt((self.lean.x * 3.).round(), (self.lean.y * 3.).round());
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
        // Sky grading applies before the emitters and HUD.
        let foreground_end = list.ops.len();
        let mut lamps = Vec::new();
        let sky = sky_at(self.clock.tod);
        let flat = flat_light(&sky);
        list.light = Some(flat);
        list.lit = list.ops.len();
        let night = sky.night;
        for light in &w.lights {
            let (color, intensity, halo) = match light.source {
                LightSource::Window => (0xffd399, 0.80 * night, 0.12),
                LightSource::Lamp => (0xffc579, 1.10 * night, 0.22),
                LightSource::Forge => {
                    let coals = 0.90 + 0.07 * (t * 7.).sin() + 0.03 * (t * 13.).sin();
                    (0xff974c, (0.22 + 0.60 * night) * coals, 0.16)
                }
            };
            if intensity > 0.02 {
                lamps.push(vibevalley_pixel::PointLight {
                    x: light.at.x,
                    y: light.at.y,
                    z: 5.,
                    radius: light.radius,
                    color: rgba(color, 1.)[..3].try_into().unwrap(),
                    intensity,
                });
                list.ops.push(Op::Glow {
                    x: light.at.x,
                    y: light.at.y,
                    r: (light.radius * 0.30).max(2.),
                    color: rgba(color, halo * intensity),
                });
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
                    "screenFeet": self.helper_feet(id).map(|p| [p.x.round(),p.y.round()]), "walking": a.walker.walking(), "pose": format!("{:?}", a.shown), "station": a.station,
                    "leaving": a.left_at.is_some(), "sprite": actor_picture(a, self.t as f32).0,
                })
            })
            .collect();
        actors.sort_by_key(|v| v["id"].as_str().unwrap_or_default().to_string());
        let beds: Vec<&str> = BEDS.iter().map(|b| self.crop_of_bed(*b, false).name()).collect();
        serde_json::json!({
            "seq": self.frame.seq, "t": self.t, "captureMotion": self.capture, "clock": clock_text(self.clock.tod), "actors": actors, "beds": beds,
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

fn actor_picture(a: &Actor, now: f32) -> (String, bool) {
    let facing = a.goal.facing.unwrap_or(a.travel_facing);
    let (clip, sample, flip) = if a.walker.walking() {
        let dir = match a.travel_facing {
            Facing::Left | Facing::Right => "walk-side",
            Facing::Up => "walk-up",
            Facing::Down => "walk-down",
        };
        (dir, (a.stride * 8. / STRIDE_LENGTH) as usize, a.travel_facing == Facing::Left)
    } else {
        let (clip, fps, flip) = match (a.goal.key.as_str(), a.shown) {
            ("library", _) => ("read", 4., false),
            ("bench", _) => ("sit", 3., false),
            ("workshop", Pose::Work) if matches!(facing, Facing::Left | Facing::Right) => ("hammer", 8., facing == Facing::Left),
            ("mast", _) => ("tinker", 6., false),
            (_, Pose::Ask) => ("ask", 5., false),
            (_, Pose::Cheer) => ("cheer", 6., false),
            (_, Pose::Worry) => ("worry", 4., false),
            (key, Pose::Hoe) if key.starts_with("bed:") => ("hoe", 7., facing == Facing::Left),
            _ => (side_of(facing), 3., facing == Facing::Left),
        };
        (clip, a.stationary_frame(now, fps), flip)
    };
    (format!("{}-{clip}@{sample}", a.look), flip)
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
        w,
        4.,
        fade * (0.33 + 0.10 * (1. - sky.night)),
        1. + reach.abs() / 15.,
    );
}
