//! Walkable Jiangnan town navigation graph & exact arched stone bridge deck elevation.
//!
//! Ensures paper-puppet helpers strictly follow real town stone paths and climb UP, OVER,
//! and DOWN every `p_bridge_arch` deck (`surface_height_at`) instead of walking through
//! stone bridges or cutting across canal water at `y = 0`.

use crate::math::Vec3;
use crate::world::{BuildingState, EntityKind, PlotState, PropState};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::f32::consts::FRAC_PI_2;

/// Exact local dimensions of `p_bridge_arch` matching `crates/compiler/src/mesh.rs::bake_prop_bridge_arch`.
const BRIDGE_SPAN: f32 = 2.52;
const BRIDGE_HALF_SPAN: f32 = BRIDGE_SPAN * 0.5; // 1.26
const BRIDGE_HALF_WIDTH: f32 = 0.50;
const BRIDGE_ARCH_H: f32 = 0.50;
const BRIDGE_BASE_Y: f32 = 0.04;
const BRIDGE_APPROACH_PAD: f32 = 0.14;

/// Disjoint land banks separated by the branching Jiangnan canal.
/// Edges ONLY cross between distinct `LandZone`s via `p_bridge_arch` bridge chains!
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LandZone {
    WestFarm,
    CentralPlaza,
    EastBank,
}

/// Classifies a world `(x, z)` coordinate into one of the 3 Jiangnan land banks.
#[inline]
pub fn land_zone_at(x: f32, z: f32) -> LandZone {
    let west_canal_x = -1.05 + 0.12 * z;
    let east_canal_x = 3.78;
    if x < west_canal_x {
        LandZone::WestFarm
    } else if x > east_canal_x {
        LandZone::EastBank
    } else {
        LandZone::CentralPlaza
    }
}

/// Returns `true` when world `(x, z)` falls inside the painted branching Jiangnan canal water.
#[inline]
pub fn is_in_canal(x: f32, z: f32) -> bool {
    // West north-south canal branch (runs from north edge through Bridge #1 to southern basin)
    let west_cx = -0.92 + 0.16 * z;
    if (x - west_cx).abs() < 0.72 && z > -6.5 && z < 6.2 {
        return true;
    }
    // East canal branch (runs north-south under Bridge #2 down past Boat #4)
    let east_cx = 3.88;
    if (x - east_cx).abs() < 0.68 && z > -5.5 && z < 4.4 {
        return true;
    }
    // Southern joining water basin (where Boat #3 cruises at [2.25, 4.80])
    if (3.2..=5.8).contains(&z) && (-0.4..=4.3).contains(&x) {
        return true;
    }
    false
}

/// Result of validating an editor brush placement at `(x, z)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlacementStatus {
    Valid(Option<String>),
    Warning(String),
    Blocked(String),
}

impl PlacementStatus {
    pub fn is_blocked(&self) -> bool {
        matches!(self, PlacementStatus::Blocked(_))
    }

    pub fn message(&self) -> Option<&str> {
        match self {
            PlacementStatus::Valid(m) => m.as_deref(),
            PlacementStatus::Warning(m) | PlacementStatus::Blocked(m) => Some(m.as_str()),
        }
    }
}

/// Validates terrain (canal vs dry land) and proximity collisions for Editor Mode placements.
pub fn validate_placement(kind: EntityKind, asset_id: &str, x: f32, z: f32, buildings: &[BuildingState], props: &[PropState]) -> PlacementStatus {
    let in_canal = is_in_canal(x, z);
    let on_bridge = surface_height_at(props, x, z) > 0.05;

    if asset_id == "p_boat" {
        return if in_canal {
            PlacementStatus::Valid(Some("运河水面：乌篷画舫落子后将随波摇曳".into()))
        } else {
            PlacementStatus::Blocked("乌篷画舫需停靠在运河水面".into())
        };
    }

    if asset_id == "p_bridge_arch" {
        return if in_canal {
            PlacementStatus::Valid(Some("跨河石拱桥：落子后自动连通两岸路网".into()))
        } else {
            PlacementStatus::Warning("当前位置不在运河主航道上，可继续摆放".into())
        };
    }

    if kind == EntityKind::Plot {
        return PlacementStatus::Valid(None);
    }

    if in_canal && !on_bridge {
        return PlacementStatus::Blocked("此处为江南运河水面，请放于陆地或使用石拱桥/画舫".into());
    }

    if kind == EntityKind::Building {
        for b in buildings {
            if (b.pos.x - x).hypot(b.pos.z - z) < 1.15 {
                return PlacementStatus::Warning("与邻近建筑较近，建议微调落点".into());
            }
        }
    }

    PlacementStatus::Valid(None)
}

/// Evaluates the exact local deck height of `p_bridge_arch` at local `(lx, lz)`.
fn bridge_local_deck_y(lx: f32, lz: f32) -> Option<f32> {
    if lz.abs() > BRIDGE_HALF_WIDTH + 0.10 {
        return None;
    }
    let ax = lx.abs();
    if ax <= BRIDGE_HALF_SPAN {
        let u = (lx / BRIDGE_HALF_SPAN).clamp(-1.0, 1.0);
        let c = (u * FRAC_PI_2).cos().max(0.0);
        Some(BRIDGE_BASE_Y + BRIDGE_ARCH_H * c.powf(1.32))
    } else if ax <= BRIDGE_HALF_SPAN + BRIDGE_APPROACH_PAD {
        let t = 1.0 - (ax - BRIDGE_HALF_SPAN) / BRIDGE_APPROACH_PAD;
        Some(BRIDGE_BASE_Y * t.clamp(0.0, 1.0))
    } else {
        None
    }
}

/// Converts a bridge-local `(lx, lz)` into world `(x, deck_y, z)`.
fn bridge_local_to_world(b: &PropState, lx: f32, lz: f32) -> Vec3 {
    let (sy, cy) = b.yaw_rad.sin_cos();
    let wx = b.pos.x + (lx * cy - lz * sy) * b.scale;
    let wz = b.pos.z + (lx * sy + lz * cy) * b.scale;
    let ly = bridge_local_deck_y(lx, lz).unwrap_or(0.0);
    Vec3::new(wx, b.pos.y + ly * b.scale, wz)
}

/// Evaluates the exact walkable surface elevation `y` at world `(x, z)` across all
/// `p_bridge_arch` props (base and dynamically placed). Returns `0.0` on flat ground.
pub fn surface_height_at(props: &[PropState], x: f32, z: f32) -> f32 {
    let mut best_y = 0.0f32;
    for p in props {
        if p.asset != "p_bridge_arch" || p.scale <= 0.05 {
            continue;
        }
        let dx = x - p.pos.x;
        let dz = z - p.pos.z;
        let (sy, cy) = p.yaw_rad.sin_cos();
        // Inverse of Mat4::rotation_y(yaw): x' = dx*c + dz*s, z' = -dx*s + dz*c
        let lx = (dx * cy + dz * sy) / p.scale;
        let lz = (-dx * sy + dz * cy) / p.scale;
        if let Some(ly) = bridge_local_deck_y(lx, lz) {
            best_y = best_y.max(p.pos.y + ly * p.scale);
        }
    }
    best_y
}

#[derive(Clone, Debug)]
pub struct NavNode {
    pub pos: Vec3,
    pub zone: LandZone,
    pub is_bridge: bool,
    pub tag: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavEdgeSummary {
    pub x1: f32,
    pub z1: f32,
    pub x2: f32,
    pub z2: f32,
    pub is_bridge: bool,
}

#[derive(Clone, Debug)]
pub struct NavGraph {
    pub nodes: Vec<NavNode>,
    pub adj: Vec<Vec<(usize, f32)>>,
    pub bridge_crests: Vec<usize>,
}

impl NavGraph {
    /// Rebuilds the connected Jiangnan town road & arched-bridge navigation graph from live scene state.
    pub fn build(plots: &[PlotState], buildings: &[BuildingState], props: &[PropState]) -> Self {
        let mut nodes: Vec<NavNode> = Vec::with_capacity(64);
        let mut adj: Vec<Vec<(usize, f32)>> = Vec::with_capacity(64);
        let mut bridge_crests: Vec<usize> = Vec::new();

        let add_node = |nodes: &mut Vec<NavNode>, adj: &mut Vec<Vec<(usize, f32)>>, pos: Vec3, zone: LandZone, is_bridge: bool, tag: Option<String>| -> usize {
            let idx = nodes.len();
            nodes.push(NavNode { pos, zone, is_bridge, tag });
            adj.push(Vec::new());
            idx
        };

        let connect = |nodes: &[NavNode], adj: &mut [Vec<(usize, f32)>], a: usize, b: usize| {
            if a == b || a >= nodes.len() || b >= nodes.len() {
                return;
            }
            if adj[a].iter().any(|(n, _)| *n == b) {
                return;
            }
            let d = nodes[a].pos.sub(nodes[b].pos).len().max(0.05);
            adj[a].push((b, d));
            adj[b].push((a, d));
        };

        // 1. Curated West Farmstead stone paths (strictly inside LandZone::WestFarm)
        let wf_n0 = add_node(&mut nodes, &mut adj, Vec3::new(-5.35, 0.0, -3.55), LandZone::WestFarm, false, None);
        let wf_n1 = add_node(&mut nodes, &mut adj, Vec3::new(-3.65, 0.0, -3.55), LandZone::WestFarm, false, None);
        let wf_n2 = add_node(&mut nodes, &mut adj, Vec3::new(-2.35, 0.0, -3.05), LandZone::WestFarm, false, None);
        let wf_m0 = add_node(&mut nodes, &mut adj, Vec3::new(-5.30, 0.0, -1.75), LandZone::WestFarm, false, None);
        let wf_m1 = add_node(&mut nodes, &mut adj, Vec3::new(-3.65, 0.0, -1.75), LandZone::WestFarm, false, None);
        let wf_m2 = add_node(&mut nodes, &mut adj, Vec3::new(-2.40, 0.0, -1.45), LandZone::WestFarm, false, None);
        let wf_l0 = add_node(&mut nodes, &mut adj, Vec3::new(-5.10, 0.0, 0.15), LandZone::WestFarm, false, None);
        let wf_l1 = add_node(&mut nodes, &mut adj, Vec3::new(-3.45, 0.0, 0.15), LandZone::WestFarm, false, None);
        let wf_l2 = add_node(
            &mut nodes,
            &mut adj,
            Vec3::new(-2.30, 0.0, 0.55),
            LandZone::WestFarm,
            false,
            Some("bridge1_west".into()),
        );
        let wf_s0 = add_node(&mut nodes, &mut adj, Vec3::new(-4.80, 0.0, 1.75), LandZone::WestFarm, false, None);
        let wf_s1 = add_node(&mut nodes, &mut adj, Vec3::new(-3.20, 0.0, 1.80), LandZone::WestFarm, false, None);

        for (a, b) in [
            (wf_n0, wf_n1),
            (wf_n1, wf_n2),
            (wf_m0, wf_m1),
            (wf_m1, wf_m2),
            (wf_l0, wf_l1),
            (wf_l1, wf_l2),
            (wf_s0, wf_s1),
            (wf_n0, wf_m0),
            (wf_m0, wf_l0),
            (wf_l0, wf_s0),
            (wf_n1, wf_m1),
            (wf_m1, wf_l1),
            (wf_l1, wf_s1),
            (wf_n2, wf_m2),
            (wf_m2, wf_l2),
            (wf_s1, wf_l2),
        ] {
            connect(&nodes, &mut adj, a, b);
        }

        // 2. Central Peninsula Plaza stone roads (strictly inside LandZone::CentralPlaza)
        let cp_b1 = add_node(
            &mut nodes,
            &mut adj,
            Vec3::new(0.65, 0.0, 0.48),
            LandZone::CentralPlaza,
            false,
            Some("bridge1_east".into()),
        );
        let cp_pav_w = add_node(&mut nodes, &mut adj, Vec3::new(0.55, 0.0, 1.55), LandZone::CentralPlaza, false, None);
        let cp_pav_e = add_node(&mut nodes, &mut adj, Vec3::new(2.30, 0.0, 1.00), LandZone::CentralPlaza, false, None);
        let cp_mid = add_node(
            &mut nodes,
            &mut adj,
            Vec3::new(1.30, 0.0, 0.05),
            LandZone::CentralPlaza,
            false,
            Some("plaza_center".into()),
        );
        let cp_board = add_node(&mut nodes, &mut adj, Vec3::new(1.55, 0.0, -1.30), LandZone::CentralPlaza, false, None);
        let cp_guild = add_node(&mut nodes, &mut adj, Vec3::new(1.35, 0.0, -2.55), LandZone::CentralPlaza, false, None);
        let cp_b2 = add_node(
            &mut nodes,
            &mut adj,
            Vec3::new(2.55, 0.0, -1.80),
            LandZone::CentralPlaza,
            false,
            Some("bridge2_west".into()),
        );

        for (a, b) in [
            (cp_b1, cp_mid),
            (cp_b1, cp_pav_w),
            (cp_mid, cp_pav_e),
            (cp_mid, cp_board),
            (cp_pav_w, cp_pav_e),
            (cp_board, cp_guild),
            (cp_board, cp_b2),
            (cp_guild, cp_b2),
            (cp_pav_e, cp_b2),
        ] {
            connect(&nodes, &mut adj, a, b);
        }

        // 3. East Bank Stone Quay (strictly inside LandZone::EastBank)
        let eb_n1 = add_node(&mut nodes, &mut adj, Vec3::new(5.15, 0.0, -4.45), LandZone::EastBank, false, None);
        let eb_n0 = add_node(&mut nodes, &mut adj, Vec3::new(5.05, 0.0, -3.10), LandZone::EastBank, false, None);
        let eb_b2 = add_node(
            &mut nodes,
            &mut adj,
            Vec3::new(5.15, 0.0, -1.55),
            LandZone::EastBank,
            false,
            Some("bridge2_east".into()),
        );
        let eb_mid = add_node(&mut nodes, &mut adj, Vec3::new(4.70, 0.0, -0.20), LandZone::EastBank, false, None);
        let eb_ws = add_node(&mut nodes, &mut adj, Vec3::new(4.65, 0.0, 1.25), LandZone::EastBank, false, None);
        let eb_s0 = add_node(&mut nodes, &mut adj, Vec3::new(5.10, 0.0, 2.75), LandZone::EastBank, false, None);

        for (a, b) in [(eb_n1, eb_n0), (eb_n0, eb_b2), (eb_b2, eb_mid), (eb_mid, eb_ws), (eb_ws, eb_s0)] {
            connect(&nodes, &mut adj, a, b);
        }

        // 4. Every `p_bridge_arch` prop becomes a 5-node elevated arch span connecting its two landing banks!
        let mut bridge_count = 0usize;
        for p in props {
            if p.asset != "p_bridge_arch" || p.scale <= 0.05 {
                continue;
            }
            bridge_count += 1;
            let w_entry = bridge_local_to_world(p, -1.42, 0.0);
            let w_ramp = bridge_local_to_world(p, -0.68, 0.0);
            let crest = bridge_local_to_world(p, 0.0, 0.0);
            let e_ramp = bridge_local_to_world(p, 0.68, 0.0);
            let e_entry = bridge_local_to_world(p, 1.42, 0.0);

            let wz = land_zone_at(w_entry.x, w_entry.z);
            let ez = land_zone_at(e_entry.x, e_entry.z);
            let cz = land_zone_at(crest.x, crest.z);

            let n_we = add_node(&mut nodes, &mut adj, w_entry, wz, true, Some(format!("bridge_{bridge_count}_w")));
            let n_wr = add_node(&mut nodes, &mut adj, w_ramp, cz, true, None);
            let n_cr = add_node(&mut nodes, &mut adj, crest, cz, true, Some(format!("bridge_{bridge_count}_crest")));
            let n_er = add_node(&mut nodes, &mut adj, e_ramp, cz, true, None);
            let n_ee = add_node(&mut nodes, &mut adj, e_entry, ez, true, Some(format!("bridge_{bridge_count}_e")));

            connect(&nodes, &mut adj, n_we, n_wr);
            connect(&nodes, &mut adj, n_wr, n_cr);
            connect(&nodes, &mut adj, n_cr, n_er);
            connect(&nodes, &mut adj, n_er, n_ee);
            bridge_crests.push(n_cr);

            // Connect each bridge landing to the 2 nearest non-bridge road nodes in its landing LandZone
            for (end_idx, end_pos, end_zone) in [(n_we, w_entry, wz), (n_ee, e_entry, ez)] {
                let mut candidates: Vec<(usize, f32)> = nodes
                    .iter()
                    .enumerate()
                    .filter(|(i, n)| *i != end_idx && !n.is_bridge && n.zone == end_zone)
                    .map(|(i, n)| (i, (n.pos.x - end_pos.x).hypot(n.pos.z - end_pos.z)))
                    .collect();
                candidates.sort_by(|a, b| a.1.total_cmp(&b.1));
                for (target, dist) in candidates.into_iter().take(2) {
                    if dist < 4.5 {
                        connect(&nodes, &mut adj, end_idx, target);
                    }
                }
            }
        }

        // 5. Attach walkable stand nodes for every farm plot (connected within its own LandZone)
        for pl in plots {
            let stand_x = pl.pos.x + 0.36;
            let stand_z = pl.pos.z + 0.66;
            let zone = land_zone_at(pl.pos.x, pl.pos.z);
            let y = surface_height_at(props, stand_x, stand_z);
            let pos = Vec3::new(stand_x, y, stand_z);
            let pid = add_node(&mut nodes, &mut adj, pos, zone, false, Some(format!("plot_{}", pl.index)));
            let mut candidates: Vec<(usize, f32)> = nodes
                .iter()
                .enumerate()
                .filter(|(i, n)| *i != pid && !n.is_bridge && n.zone == zone)
                .map(|(i, n)| (i, (n.pos.x - pos.x).hypot(n.pos.z - pos.z)))
                .collect();
            candidates.sort_by(|a, b| a.1.total_cmp(&b.1));
            for (target, dist) in candidates.into_iter().take(2) {
                if dist < 3.6 {
                    connect(&nodes, &mut adj, pid, target);
                }
            }
        }

        // 6. Attach walkable front-door stand nodes for every building (connected within its own LandZone)
        for b in buildings {
            let zone = land_zone_at(b.pos.x, b.pos.z);
            // Offset toward the town's walkable stone road side of each zone
            let (ox, oz) = match b.id.as_str() {
                "runtimes" => (-0.95, 0.35),   // front waterwheel quay side of Workshop
                "skills" => (-0.95, 0.35),     // front quay side of Library
                "warehouse" => (-0.95, -0.55), // front quay side of Warehouse
                "log" => (-0.55, 1.05),        // south path of Radio Kiosk
                "agents" => (-0.10, 1.15),     // south courtyard of Guild Hall
                "taskBoard" => (0.55, 0.55),   // plaza front of Task Board
                "shop" => (-0.65, 0.65),       // plaza front of Market Stall
                "manager" => (-0.65, 0.15),    // plaza side of Orchestrator Pavilion
                "tasks" => (0.0, 1.25),        // south road side of Paifang Arch
                _ => {
                    let dir = b.pos.scale(-1.0).normalize();
                    (dir.x * 1.15, dir.z * 1.15)
                }
            };
            let wx = (b.pos.x + ox).clamp(-6.8, 6.8);
            let wz = (b.pos.z + oz).clamp(-6.8, 6.8);
            let wy = surface_height_at(props, wx, wz);
            let pos = Vec3::new(wx, wy, wz);
            let bid = add_node(&mut nodes, &mut adj, pos, zone, false, Some(format!("bldg_{}", b.id)));
            let mut candidates: Vec<(usize, f32)> = nodes
                .iter()
                .enumerate()
                .filter(|(i, n)| *i != bid && !n.is_bridge && n.zone == zone)
                .map(|(i, n)| (i, (n.pos.x - pos.x).hypot(n.pos.z - pos.z)))
                .collect();
            candidates.sort_by(|a, b| a.1.total_cmp(&b.1));
            for (target, dist) in candidates.into_iter().take(2) {
                if dist < 4.5 {
                    connect(&nodes, &mut adj, bid, target);
                }
            }
        }

        Self { nodes, adj, bridge_crests }
    }

    pub fn node_by_tag(&self, tag: &str) -> Option<usize> {
        self.nodes.iter().position(|n| n.tag.as_deref() == Some(tag))
    }

    pub fn nearest_node_in_zone(&self, pos: Vec3, prefer_zone: LandZone) -> Option<usize> {
        let same_zone = self
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.zone == prefer_zone)
            .min_by(|(_, a), (_, b)| {
                let da = (a.pos.x - pos.x).hypot(a.pos.z - pos.z);
                let db = (b.pos.x - pos.x).hypot(b.pos.z - pos.z);
                da.total_cmp(&db)
            })
            .map(|(i, _)| i);
        same_zone.or_else(|| {
            self.nodes
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| {
                    let da = (a.pos.x - pos.x).hypot(a.pos.z - pos.z);
                    let db = (b.pos.x - pos.x).hypot(b.pos.z - pos.z);
                    da.total_cmp(&db)
                })
                .map(|(i, _)| i)
        })
    }

    /// Computes the shortest multi-hop road & bridge waypoint path from `start` to `goal_node`
    /// using Dijkstra's algorithm. Never cuts across canal water!
    pub fn find_path_to_node(&self, start_pos: Vec3, goal_node: usize) -> Vec<Vec3> {
        if self.nodes.is_empty() || goal_node >= self.nodes.len() {
            return Vec::new();
        }
        let start_zone = land_zone_at(start_pos.x, start_pos.z);
        let Some(start_node) = self.nearest_node_in_zone(start_pos, start_zone) else {
            return Vec::new();
        };
        self.dijkstra_indices(start_node, goal_node).into_iter().map(|i| self.nodes[i].pos).collect()
    }

    /// Computes the shortest multi-hop road & bridge path between two arbitrary world positions.
    pub fn find_path(&self, start_pos: Vec3, goal_pos: Vec3) -> Vec<Vec3> {
        let goal_zone = land_zone_at(goal_pos.x, goal_pos.z);
        let Some(goal_node) = self.nearest_node_in_zone(goal_pos, goal_zone) else {
            return vec![goal_pos];
        };
        self.find_path_to_node(start_pos, goal_node)
    }

    /// Returns node indices along the shortest path from `start` to `goal` (inclusive).
    pub fn dijkstra_indices(&self, start: usize, goal: usize) -> Vec<usize> {
        let n = self.nodes.len();
        if start >= n || goal >= n {
            return Vec::new();
        }
        if start == goal {
            return vec![goal];
        }

        #[derive(Clone, Copy)]
        struct State {
            cost: f32,
            node: usize,
        }
        impl PartialEq for State {
            fn eq(&self, other: &Self) -> bool {
                self.node == other.node && self.cost.to_bits() == other.cost.to_bits()
            }
        }
        impl Eq for State {}
        impl Ord for State {
            fn cmp(&self, other: &Self) -> Ordering {
                other.cost.total_cmp(&self.cost)
            }
        }
        impl PartialOrd for State {
            fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
                Some(self.cmp(other))
            }
        }

        let mut dist = vec![f32::INFINITY; n];
        let mut prev: Vec<Option<usize>> = vec![None; n];
        let mut heap = BinaryHeap::new();
        dist[start] = 0.0;
        heap.push(State { cost: 0.0, node: start });

        while let Some(State { cost, node }) = heap.pop() {
            if node == goal {
                break;
            }
            if cost > dist[node] + 1e-5 {
                continue;
            }
            for &(next, w) in &self.adj[node] {
                let nc = cost + w;
                if nc < dist[next] {
                    dist[next] = nc;
                    prev[next] = Some(node);
                    heap.push(State { cost: nc, node: next });
                }
            }
        }

        if !dist[goal].is_finite() {
            return Vec::new();
        }
        let mut path = Vec::new();
        let mut cur = Some(goal);
        while let Some(idx) = cur {
            path.push(idx);
            cur = prev[idx];
        }
        path.reverse();
        path
    }

    /// Compact undirected edge list for the bottom-left parchment minimap (`江南缩略图`).
    pub fn minimap_edges(&self) -> Vec<NavEdgeSummary> {
        let r2 = |v: f32| (v * 100.0).round() / 100.0;
        let mut out = Vec::new();
        for (a, nbrs) in self.adj.iter().enumerate() {
            for &(b, _) in nbrs {
                if a < b {
                    let na = &self.nodes[a];
                    let nb = &self.nodes[b];
                    out.push(NavEdgeSummary {
                        x1: r2(na.pos.x),
                        z1: r2(na.pos.z),
                        x2: r2(nb.pos.x),
                        z2: r2(nb.pos.z),
                        is_bridge: na.is_bridge && nb.is_bridge,
                    });
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spring::FlapSpring;

    fn make_bridge(id: &str, x: f32, z: f32, scale: f32, yaw_deg: f32) -> PropState {
        PropState {
            id: id.into(),
            asset: "p_bridge_arch".into(),
            pos: Vec3::new(x, 0.0, z),
            scale,
            yaw_rad: yaw_deg.to_radians(),
            is_lamp: false,
            spring: FlapSpring::new(1.0, 0.0, 0.0),
            is_dynamic: false,
        }
    }

    #[test]
    fn arch_bridge_surface_height_elevates_cleanly_at_crest_and_zero_off_bridge() {
        let props = vec![make_bridge("b1", -0.85, 0.55, 1.06, -4.0), make_bridge("b2", 3.92, -1.65, 0.94, 6.0)];
        // Exactly at Bridge #1 crest
        let y1 = surface_height_at(&props, -0.85, 0.55);
        assert!(y1 > 0.50 && y1 < 0.62, "expected Bridge #1 crest ~0.57m, got {y1}");

        // Exactly at Bridge #2 crest
        let y2 = surface_height_at(&props, 3.92, -1.65);
        assert!(y2 > 0.45 && y2 < 0.56, "expected Bridge #2 crest ~0.51m, got {y2}");

        // Mid-ramp lower than crest but strictly above ground
        let y_mid = surface_height_at(&props, -0.85 - 0.65, 0.55);
        assert!(y_mid > 0.18 && y_mid < y1, "expected mid-ramp between 0.18 and {y1}, got {y_mid}");

        // Off-bridge ground is strictly 0.0
        assert_eq!(surface_height_at(&props, -4.5, -2.0), 0.0);
        assert_eq!(surface_height_at(&props, 1.5, 1.5), 0.0);
    }

    #[test]
    fn west_farm_to_east_bank_routes_strictly_across_both_bridges_with_zero_canal_crossings() {
        let props = vec![make_bridge("b1", -0.85, 0.55, 1.06, -4.0), make_bridge("b2", 3.92, -1.65, 0.94, 6.0)];
        let plots = vec![PlotState {
            index: 0,
            pos: Vec3::new(-6.30, 0.0, -2.55),
            size: [1.26, 1.06],
            stage: crate::world::PlotStage::Reviewing,
            title: "Test".into(),
            crop_spring: FlapSpring::new(1.0, 0.0, 0.0),
            sign_spring: FlapSpring::new(1.0, 0.0, 0.0),
            locked: false,
        }];
        let buildings = vec![BuildingState {
            id: "runtimes".into(),
            label: "工坊".into(),
            opens: "/runtimes".into(),
            asset: "b_workshop".into(),
            pos: Vec3::new(5.45, 0.0, 0.95),
            scale: 2.35,
            yaw_rad: (-34.0f32).to_radians(),
            spring: FlapSpring::new(1.0, 0.0, 0.0),
            is_dynamic: false,
        }];

        let nav = NavGraph::build(&plots, &buildings, &props);
        let start = nav.node_by_tag("plot_0").expect("plot_0 node");
        let goal = nav.node_by_tag("bldg_runtimes").expect("bldg_runtimes node");
        let indices = nav.dijkstra_indices(start, goal);
        assert!(indices.len() >= 8, "expected multi-hop road + bridge path, got len={}", indices.len());

        // Must pass through BOTH bridge crests!
        let crest1 = nav.node_by_tag("bridge_1_crest").expect("bridge 1 crest");
        let crest2 = nav.node_by_tag("bridge_2_crest").expect("bridge 2 crest");
        assert!(indices.contains(&crest1), "path must cross Bridge #1 crest");
        assert!(indices.contains(&crest2), "path must cross Bridge #2 crest");

        // Verify NO consecutive edge jumps across distinct land zones without being a bridge segment!
        for pair in indices.windows(2) {
            let na = &nav.nodes[pair[0]];
            let nb = &nav.nodes[pair[1]];
            if na.zone != nb.zone {
                assert!(
                    na.is_bridge && nb.is_bridge,
                    "illegal canal crossing between non-bridge nodes {:?} -> {:?}",
                    na.pos,
                    nb.pos
                );
            }
        }
    }

    #[test]
    fn canal_validation_blocks_houses_in_water_and_boats_on_dry_land() {
        // Canal boats sit in water
        assert!(is_in_canal(-1.05, -2.85));
        assert!(is_in_canal(-0.15, 2.75));
        assert!(is_in_canal(2.25, 4.80));
        assert!(is_in_canal(3.95, 2.35));

        // Key town buildings & farm plots sit on dry land
        for (x, z) in [(-4.45, -1.00), (1.38, 1.45), (0.55, -1.60), (5.45, 0.95), (5.95, -2.55)] {
            assert!(!is_in_canal(x, z), "land coord ({x}, {z}) wrongly marked as canal");
        }

        // Building in canal -> Blocked; Boat on land -> Blocked; Boat in canal -> Valid
        assert!(validate_placement(EntityKind::Building, "b_workshop", -1.0, -2.5, &[], &[]).is_blocked());
        assert!(validate_placement(EntityKind::Prop, "p_boat", -4.5, -1.0, &[], &[]).is_blocked());
        assert!(!validate_placement(EntityKind::Prop, "p_boat", -1.0, -2.5, &[], &[]).is_blocked());
        assert!(!validate_placement(EntityKind::Prop, "p_bridge_arch", -0.85, 0.55, &[], &[]).is_blocked());
    }
}
