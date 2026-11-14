//! The village's places and the rules for where helpers go and how they
//! stand: VibeValley's `farm/world/world.ts` and `plots.ts`.

use std::collections::HashMap;

use super::super::level::{Box2, Level, Point, pt};
use super::super::nav::{Facing, NavMap};
use super::frame::{Crop, Session};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bed {
    pub index: usize,
    /// -1 for the locked ones.
    pub station: i32,
    pub unlock_level: Option<u32>,
}

pub const BEDS: [Bed; 9] = [
    Bed {
        index: 0,
        station: 0,
        unlock_level: None,
    },
    Bed {
        index: 1,
        station: 1,
        unlock_level: None,
    },
    Bed {
        index: 2,
        station: 2,
        unlock_level: None,
    },
    Bed {
        index: 3,
        station: 3,
        unlock_level: None,
    },
    Bed {
        index: 4,
        station: 4,
        unlock_level: None,
    },
    Bed {
        index: 5,
        station: 5,
        unlock_level: None,
    },
    Bed {
        index: 6,
        station: -1,
        unlock_level: Some(5),
    },
    Bed {
        index: 7,
        station: -1,
        unlock_level: Some(8),
    },
    Bed {
        index: 8,
        station: -1,
        unlock_level: Some(12),
    },
];

pub fn bed_of_station(station: i32) -> Option<Bed> {
    if station < 0 {
        None
    } else {
        BEDS.iter().copied().find(|b| b.station == station)
    }
}

pub fn is_ripe(crop: Crop) -> bool {
    matches!(crop, Crop::Wheat | Crop::Carrot)
}

/// What a click in the yard opens. Ids match the LDtk Prop and Area `spot` fields.
pub struct YardPlace {
    pub id: &'static str,
    pub label: &'static str,
    /// A panel of the farm, a workbench route, or the chat.
    pub opens: &'static str,
}

pub const YARD_PLACES: [YardPlace; 9] = [
    YardPlace {
        id: "shop",
        label: "web.farm.panel.shop",
        opens: "panel:shop",
    },
    YardPlace {
        id: "warehouse",
        label: "web.farm.panel.warehouse",
        opens: "panel:warehouse",
    },
    YardPlace {
        id: "tasks",
        label: "web.farm.panel.graphs",
        opens: "panel:graphs",
    },
    YardPlace {
        id: "log",
        label: "web.farm.panel.log",
        opens: "panel:log",
    },
    YardPlace {
        id: "taskBoard",
        label: "web.farm.menu.issues",
        opens: "/issues",
    },
    YardPlace {
        id: "agents",
        label: "web.farm.menu.agents",
        opens: "/agents",
    },
    YardPlace {
        id: "manager",
        label: "web.farm.panel.orchestrator",
        opens: "chat",
    },
    YardPlace {
        id: "runtimes",
        label: "web.farm.menu.runtimes",
        opens: "/runtimes",
    },
    YardPlace {
        id: "skills",
        label: "web.farm.menu.skills",
        opens: "/settings/skills",
    },
];

pub const PLOT_W: f32 = 34.0;
pub const PLOT_H: f32 = 26.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlotSpot {
    Front,
    Left,
    Right,
    Back,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrollSpot {
    Plot(PlotSpot),
    Rest,
}

fn around(s: PlotSpot) -> Point {
    match s {
        PlotSpot::Front => pt(0.0, 5.0),
        PlotSpot::Left => pt(-24.0, -10.0),
        PlotSpot::Right => pt(24.0, -10.0),
        PlotSpot::Back => pt(6.0, -29.0),
    }
}
fn in_bed(s: PlotSpot) -> Point {
    match s {
        PlotSpot::Front => pt(0.0, -9.0),
        PlotSpot::Left => pt(-7.0, -11.0),
        PlotSpot::Right => pt(7.0, -11.0),
        PlotSpot::Back => pt(0.0, -13.0),
    }
}
fn facing_at(s: PlotSpot) -> Facing {
    match s {
        PlotSpot::Front => Facing::Up,
        PlotSpot::Back => Facing::Down,
        PlotSpot::Left => Facing::Right,
        PlotSpot::Right => Facing::Left,
    }
}

fn facing_of(v: &str) -> Facing {
    match v {
        "down" => Facing::Down,
        "left" => Facing::Left,
        "right" => Facing::Right,
        _ => Facing::Up,
    }
}

pub struct Prop {
    pub spot: String,
    pub sprite: String,
    pub at: Point,
    pub bx: Box2,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Goal {
    pub key: String,
    pub at: Point,
    pub facing: Option<Facing>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pose {
    Cheer,
    Worry,
    Idle,
    Work,
    Think,
}

/// What a helper is reaching a goal with.
pub struct GoalInput<'a> {
    pub here: bool,
    pub station: i32,
    pub queue_index: usize,
    pub calls: bool,
    pub place: &'a str,
    pub stroll: Option<Stroll>,
    pub pose: Pose,
    pub crowd: usize,
}

const REACH: f32 = 15.0;

pub struct VillageWorld {
    pub level: Level,
    pub plots: HashMap<usize, Point>,
    pub gate: Point,
    pub queue: Point,
    pub orchestrator: Point,
    pub dog: Point,
    pub lawn: Vec<Point>,
    pub lights: Vec<(Point, f32)>,
    pub props: Vec<Prop>,
    pub spot_boxes: Vec<(&'static str, Box2)>,
    pub places: HashMap<String, (Point, Facing)>,
    pub nav: NavMap,
}

impl VillageWorld {
    pub fn new(level: Level) -> Result<VillageWorld, String> {
        let plots = level.things_of("Plot").iter().map(|t| (t.num("index") as usize, t.at)).collect();
        let mut rest: Vec<_> = level.things_of("Rest").iter().map(|t| (t.num("n"), t.at)).collect();
        rest.sort_by(|a, b| a.0.total_cmp(&b.0));
        let props: Vec<Prop> = level
            .things_of("Prop")
            .iter()
            .map(|t| Prop {
                spot: t.text("spot"),
                sprite: t.text("sprite"),
                at: t.at,
                bx: t.bx,
            })
            .collect();
        let mut spot_boxes = Vec::new();
        for p in &YARD_PLACES {
            let thing = level
                .things_of("Prop")
                .iter()
                .chain(level.things_of("Area"))
                .find(|t| t.text("spot") == p.id)
                .ok_or_else(|| format!("village.ldtk: no Prop or Area for {}", p.id))?;
            spot_boxes.push((p.id, thing.bx));
        }
        let places = level
            .things_of("Place")
            .iter()
            .map(|t| (t.text("place"), (t.at, facing_of(&t.text("facing")))))
            .collect();
        let mut world = VillageWorld {
            plots,
            gate: level.the_thing("Gate")?.at,
            queue: level.the_thing("Queue")?.at,
            orchestrator: level.the_thing("Manager")?.at,
            dog: level.the_thing("Dog")?.at,
            lawn: rest.into_iter().map(|r| r.1).collect(),
            lights: level.things_of("Light").iter().map(|t| (t.at, t.num("r") as f32)).collect(),
            props,
            spot_boxes,
            places,
            nav: NavMap::new(1.0, 1.0, 1.0, 1.0, |_| true),
            level,
        };
        let nav = NavMap::new(world.level.width + 16.0, world.level.height, 2.0, 2.0, |p| world.walkable(p));
        world.nav = nav;
        Ok(world)
    }

    pub fn plot_at(&self, index: usize) -> Point {
        self.plots.get(&index).copied().unwrap_or_default()
    }

    pub fn plot_box(&self, index: usize) -> Box2 {
        let p = self.plot_at(index);
        Box2 {
            x0: p.x - PLOT_W / 2.0,
            y0: p.y - PLOT_H + 2.0,
            x1: p.x + PLOT_W / 2.0,
            y1: p.y,
        }
    }

    pub fn queue_spot(&self, n: usize) -> Point {
        pt(self.queue.x - n as f32 * 13.0, self.queue.y + (n % 2) as f32 * 4.0)
    }

    /// The plots and the props' feet are left out of the level's ground.
    pub fn walkable(&self, p: Point) -> bool {
        self.level.ground1(p)
            && !self.props.iter().any(|s| {
                Box2 {
                    x0: s.bx.x0,
                    y0: s.bx.y1 - 7.0,
                    x1: s.bx.x1,
                    y1: s.bx.y1 + 1.0,
                }
                .contains(p)
            })
            && !(0..9).any(|i| self.plot_box(i).contains(p))
    }

    pub fn goal_of(&self, a: &GoalInput) -> Goal {
        if !a.here {
            return Goal {
                key: "gate".into(),
                at: self.gate,
                facing: None,
            };
        }
        let Some(bed) = bed_of_station(a.station) else {
            return Goal {
                key: format!("queue:{}", a.queue_index),
                at: self.queue_spot(a.queue_index),
                facing: None,
            };
        };
        let plot = self.plot_at(bed.index);
        if a.calls {
            return Goal {
                key: "plot:front".into(),
                at: pt(plot.x, plot.y + around(PlotSpot::Front).y),
                facing: Some(Facing::Down),
            };
        }
        if a.place != "plot"
            && let Some(&(at, facing)) = self.places.get(a.place)
        {
            let n = a.crowd;
            if matches!(facing, Facing::Left | Facing::Right) {
                return self.beside_it(a.place, at, facing, n);
            }
            let side = if !n.is_multiple_of(2) { 1.0 } else { -1.0 };
            return Goal {
                key: a.place.into(),
                at: pt(at.x + side * (n as f32 / 2.0).ceil() * 12.0, at.y + (n % 3) as f32),
                facing: Some(facing),
            };
        }
        let spot = a.stroll.map(|s| s.spot).unwrap_or(StrollSpot::Plot(PlotSpot::Right));
        let rest = a.stroll.map(|s| s.rest).unwrap_or(0);
        match spot {
            StrollSpot::Rest => Goal {
                key: format!("rest:{rest}"),
                at: self.lawn.get(rest % self.lawn.len().max(1)).copied().unwrap_or(self.gate),
                facing: None,
            },
            StrollSpot::Plot(s) if a.pose == Pose::Work => Goal {
                key: format!("bed:{s:?}"),
                at: plot + in_bed(s),
                facing: Some(Facing::Down),
            },
            StrollSpot::Plot(s) => Goal {
                key: format!("plot:{s:?}"),
                at: plot + around(s),
                facing: Some(facing_at(s)),
            },
        }
    }

    fn beside_it(&self, key: &str, at: Point, facing: Facing, n: usize) -> Goal {
        let dir = if facing == Facing::Right { 1.0 } else { -1.0 };
        if n == 0 {
            return Goal {
                key: key.into(),
                at,
                facing: Some(facing),
            };
        }
        if n == 1 {
            let back = if facing == Facing::Right { Facing::Left } else { Facing::Right };
            return Goal {
                key: key.into(),
                at: pt(at.x + dir * REACH * 2.0, at.y),
                facing: Some(back),
            };
        }
        let side = if !n.is_multiple_of(2) { -12.0 } else { 12.0 };
        Goal {
            key: key.into(),
            at: pt(at.x + dir * REACH + side * ((n - 1) as f32 / 2.0).ceil(), at.y + 12.0),
            facing: Some(Facing::Up),
        }
    }
}

/// How long one pose stays on screen.
pub const POSE_MIN_S: f32 = 0.8;

pub struct PoseHold {
    shown: Pose,
    since: f32,
}

impl PoseHold {
    pub fn new(pose: Pose, now: f32) -> PoseHold {
        PoseHold { shown: pose, since: now }
    }
    pub fn next(&mut self, want: Pose, now: f32) -> Pose {
        if want != self.shown && now - self.since >= POSE_MIN_S {
            self.shown = want;
            self.since = now;
        }
        self.shown
    }
}

const HANDS_ON: [&str; 4] = ["edit_file", "run_command", "mcp", "other"];

pub fn pose_of(s: &Session, crop: Crop) -> Pose {
    if is_ripe(crop) {
        return Pose::Cheer;
    }
    if matches!(crop, Crop::Withered | Crop::Dry) {
        return Pose::Worry;
    }
    match s.doing() {
        None | Some("none") => Pose::Idle,
        Some(a) if HANDS_ON.contains(&a) => Pose::Work,
        Some(_) => Pose::Think,
    }
}

pub fn place_of_action(action: &str) -> &'static str {
    match action {
        "read_file" | "search" => "library",
        "run_command" | "mcp" => "workshop",
        "web" => "mast",
        "wait" => "bench",
        _ => "plot",
    }
}

pub fn plot_calls(crop: Crop) -> bool {
    is_ripe(crop) || matches!(crop, Crop::Withered | Crop::Dry)
}

pub fn spots_for(s: &Session, crop: Crop, pose: Pose) -> Vec<StrollSpot> {
    use PlotSpot::*;
    use StrollSpot::*;
    if is_ripe(crop) || crop == Crop::Dry {
        return vec![Plot(Front)];
    }
    if crop == Crop::Withered {
        return vec![Plot(Front), Plot(Left), Plot(Right)];
    }
    match s.phase.tag.as_str() {
        "working" if pose == Pose::Work => vec![Plot(Front), Plot(Right), Plot(Left)],
        "working" => vec![Plot(Left), Plot(Back), Plot(Right)],
        "resting" => vec![Rest, Rest, Plot(Front), Plot(Back)],
        _ => vec![Plot(Front)],
    }
}

/// It sets off once it has wanted the new place for `SETTLE` seconds and been where it is for `DWELL`.
pub struct Whereabouts {
    pub place: String,
    since: f32,
    want: String,
    want_since: f32,
}

impl Whereabouts {
    pub const SETTLE: f32 = 1.2;
    pub const DWELL: f32 = 2.0;

    pub fn new(place: &str, now: f32, want: &str) -> Whereabouts {
        Whereabouts {
            place: place.into(),
            since: now,
            want: want.into(),
            want_since: now,
        }
    }

    pub fn move_on(&mut self, to: &str, now: f32, urgent: bool) {
        if to != self.want {
            self.want = to.into();
            self.want_since = now;
        }
        if self.want == self.place {
            return;
        }
        if urgent || (now - self.want_since >= Self::SETTLE && now - self.since >= Self::DWELL) {
            self.place = self.want.clone();
            self.since = now;
        }
    }
}

pub const REST_SPOTS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stroll {
    pub spot: StrollSpot,
    pub rest: usize,
    pub until: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum VillageHit {
    Session(String),
    Dog,
    Spot(&'static str),
    Plot(usize),
}

/// What a tap lands on, in order: helpers (last drawn on top), the dog, the
/// yard's places, the plots (a little taller than their box).
pub fn village_hit_at(sessions: &[(String, Box2)], dog: Option<Box2>, spots: &[(&'static str, Box2)], plots: &[(usize, Box2)], p: Point) -> Option<VillageHit> {
    if let Some((id, _)) = sessions.iter().rev().find(|(_, b)| b.contains(p)) {
        return Some(VillageHit::Session(id.clone()));
    }
    if dog.is_some_and(|d| d.contains(p)) {
        return Some(VillageHit::Dog);
    }
    if let Some((spot, _)) = spots.iter().rev().find(|(_, b)| b.contains(p)) {
        return Some(VillageHit::Spot(spot));
    }
    plots
        .iter()
        .rev()
        .find(|(_, b)| {
            Box2 {
                y0: b.y0 - 4.0,
                y1: b.y1 + 2.0,
                ..*b
            }
            .contains(p)
        })
        .map(|(i, _)| VillageHit::Plot(*i))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whereabouts_settle_then_dwell() {
        let mut w = Whereabouts::new("plot", 0.0, "plot");
        w.move_on("library", 0.5, false);
        assert_eq!(w.place, "plot");
        w.move_on("library", 2.1, false);
        assert_eq!(w.place, "library");
        w.move_on("plot", 2.2, true);
        assert_eq!(w.place, "plot");
    }

    #[test]
    fn poses_hold() {
        let mut h = PoseHold::new(Pose::Idle, 0.0);
        assert_eq!(h.next(Pose::Work, 0.5), Pose::Idle);
        assert_eq!(h.next(Pose::Work, 0.9), Pose::Work);
    }

    #[test]
    fn hits_in_order() {
        let b = Box2 {
            x0: 0.0,
            y0: 0.0,
            x1: 10.0,
            y1: 10.0,
        };
        assert_eq!(
            village_hit_at(&[("s".into(), b)], Some(b), &[], &[(0, b)], pt(5.0, 5.0)),
            Some(VillageHit::Session("s".into()))
        );
        assert_eq!(village_hit_at(&[], None, &[], &[(3, b)], pt(5.0, -3.0)), Some(VillageHit::Plot(3)));
        assert_eq!(village_hit_at(&[], None, &[], &[], pt(5.0, 5.0)), None);
    }
}
