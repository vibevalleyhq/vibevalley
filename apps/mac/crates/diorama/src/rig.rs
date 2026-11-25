//! Paper-Mario-style hierarchical rigid-part skeleton & articulated machine animation rigs.
//!
//! Each vertex packs its material flag in `flags & 0xFF` and rigid `bone_id` (`0..15`) in
//! `(flags >> 8) & 0xFF`. Evaluating a [`SkeletonPose`] against a mesh's [`BoneDesc`] table
//! produces a 16-bone column-major GPU matrix palette where every child bone rotates and
//! translates strictly around its rest-pose `pivot` inside its parent's frame (zero joint gaps).

use crate::asset::BoneDesc;
use crate::math::{Mat4, Vec3};
use crate::world::PlotStage;
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;

pub const MAX_BONES: usize = 16;

/// GPU-ready column-major 16-bone palette (`[[[f32; 4]; 4]; 16]`).
pub type BonePalette = [[[f32; 4]; 4]; MAX_BONES];

// Standard Paper-Mario Puppet Bone IDs (`h_bear`, `h_fox`, `h_owl`, `h_shiba`, `h_cat`, `h_rabbit`)
pub const BONE_ROOT: usize = 0;
pub const BONE_TORSO: usize = 1;
pub const BONE_HEAD: usize = 2;
pub const BONE_ARM_L: usize = 3;
pub const BONE_ARM_R: usize = 4;
pub const BONE_LEG_L: usize = 5;
pub const BONE_LEG_R: usize = 6;
pub const BONE_TAIL: usize = 7;

// Standard Articulated Architecture / Machine Bone IDs
pub const BONE_WATERWHEEL: usize = 1;
pub const BONE_LANTERN_SWING: usize = 2;
pub const BONE_ROOF_LID: usize = 3;

pub fn identity_palette() -> BonePalette {
    [Mat4::IDENTITY.0; MAX_BONES]
}

/// Local rigid-joint animation offset applied around a bone's rest-pose pivot.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct JointTransform {
    pub rot_x: f32,
    pub rot_y: f32,
    pub rot_z: f32,
    pub translate: Vec3,
}

impl JointTransform {
    pub const ZERO: Self = Self {
        rot_x: 0.0,
        rot_y: 0.0,
        rot_z: 0.0,
        translate: Vec3::ZERO,
    };

    pub fn lerp(self, other: Self, t: f32) -> Self {
        Self {
            rot_x: self.rot_x + (other.rot_x - self.rot_x) * t,
            rot_y: self.rot_y + (other.rot_y - self.rot_y) * t,
            rot_z: self.rot_z + (other.rot_z - self.rot_z) * t,
            translate: self.translate.lerp(other.translate, t),
        }
    }

    /// Pivot-centered local rigid matrix: `T(pivot + translate) * Ry * Rx * Rz * T(-pivot)`.
    pub fn local_matrix(self, pivot: Vec3) -> Mat4 {
        let rot = Mat4::rotation_y(self.rot_y).mul(Mat4::rotation_x(self.rot_x)).mul(Mat4::rotation_z(self.rot_z));
        Mat4::translation(pivot.add(self.translate)).mul(rot).mul(Mat4::translation(pivot.scale(-1.0)))
    }
}

/// Complete local joint pose for up to 16 rigid bones.
#[derive(Clone, Copy, Debug)]
pub struct SkeletonPose {
    pub joints: [JointTransform; MAX_BONES],
}

impl Default for SkeletonPose {
    fn default() -> Self {
        Self::identity()
    }
}

impl SkeletonPose {
    pub fn identity() -> Self {
        Self {
            joints: [JointTransform::ZERO; MAX_BONES],
        }
    }

    pub fn set(&mut self, bone_id: usize, tf: JointTransform) {
        if bone_id < MAX_BONES {
            self.joints[bone_id] = tf;
        }
    }

    pub fn lerp(&self, other: &Self, t: f32) -> Self {
        let mut out = Self::identity();
        for i in 0..MAX_BONES {
            out.joints[i] = self.joints[i].lerp(other.joints[i], t);
        }
        out
    }

    /// Evaluates hierarchical parent->child rigid-joint transforms around each bone's `pivot`,
    /// returning a GPU-ready 16-bone column-major matrix palette.
    pub fn evaluate(&self, bones: &[BoneDesc]) -> BonePalette {
        if bones.is_empty() {
            return identity_palette();
        }
        let count = bones.len().min(MAX_BONES);
        let mut resolved: [Option<Mat4>; MAX_BONES] = [None; MAX_BONES];

        fn resolve(idx: usize, bones: &[BoneDesc], joints: &[JointTransform; MAX_BONES], resolved: &mut [Option<Mat4>; MAX_BONES], depth: usize) -> Mat4 {
            if let Some(m) = resolved[idx] {
                return m;
            }
            let b = &bones[idx];
            let pivot = Vec3::new(b.pivot[0], b.pivot[1], b.pivot[2]);
            let local = joints[idx].local_matrix(pivot);
            let global = if b.parent >= 0 && (b.parent as usize) < bones.len() && (b.parent as usize) != idx && depth < MAX_BONES {
                let parent_m = resolve(b.parent as usize, bones, joints, resolved, depth + 1);
                parent_m.mul(local)
            } else {
                local
            };
            resolved[idx] = Some(global);
            global
        }

        let mut palette = identity_palette();
        for (i, slot) in palette.iter_mut().enumerate().take(count) {
            *slot = resolve(i, bones, &self.joints, &mut resolved, 0).0;
        }
        palette
    }
}

/// Paper-Mario animal helper behavioral animation states.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PuppetAnimState {
    Idle,
    Walk,
    TendCrop,
    WaveAsk,
    Celebrate,
}

impl PuppetAnimState {
    pub fn label(self) -> &'static str {
        match self {
            PuppetAnimState::Idle => "歇息",
            PuppetAnimState::Walk => "巡游",
            PuppetAnimState::TendCrop => "照料农田",
            PuppetAnimState::WaveAsk => "挥手询问",
            PuppetAnimState::Celebrate => "丰收欢呼",
        }
    }

    /// Maps an assigned farm plot's workflow stage to the puppet's expressive action state.
    pub fn for_plot_stage(stage: PlotStage) -> Self {
        match stage {
            PlotStage::Asking | PlotStage::Conflict | PlotStage::Failed => PuppetAnimState::WaveAsk,
            PlotStage::Reviewing | PlotStage::Flowering => PuppetAnimState::Celebrate,
            PlotStage::Seeded | PlotStage::Sprout | PlotStage::Leafy | PlotStage::Weeds => PuppetAnimState::TendCrop,
            PlotStage::Empty => PuppetAnimState::Idle,
        }
    }
}

/// Per-helper Paper-Mario puppet animation controller with smooth state blending,
/// signature crisp 180° cardboard flip-turn spring, stride-synced limbs, and spring-lag tail.
#[derive(Clone, Debug)]
pub struct PuppetRig {
    pub state: PuppetAnimState,
    pub prev_state: PuppetAnimState,
    pub state_blend: f32,
    pub phase: f32,
    pub stride_phase: f32,
    pub facing_sign: f32,
    /// Current Paper-Mario cardboard flip angle around Y (radians).
    pub flip_angle_rad: f32,
    pub flip_target_rad: f32,
    pub flip_vel: f32,
    /// Spring-lag tail sway angle (radians) trailing torso momentum.
    pub tail_angle: f32,
    pub tail_vel: f32,
    pub seed: f32,
}

impl PuppetRig {
    pub fn new(initial: PuppetAnimState, seed: f32) -> Self {
        Self {
            state: initial,
            prev_state: initial,
            state_blend: 1.0,
            phase: seed * 1.7,
            stride_phase: 0.0,
            facing_sign: 1.0,
            flip_angle_rad: 0.0,
            flip_target_rad: 0.0,
            flip_vel: 0.0,
            tail_angle: 0.0,
            tail_vel: 0.0,
            seed,
        }
    }

    pub fn set_state(&mut self, next: PuppetAnimState) {
        if self.state == next {
            return;
        }
        self.prev_state = self.state;
        self.state = next;
        self.state_blend = 0.0;
    }

    /// Updates horizontal travel sign without fighting world `heading_yaw`;
    /// only kicks tail momentum on sharp reversals (full 3D turning is driven by `HelperState.yaw_rad`).
    pub fn set_facing_dir(&mut self, dx: f32) {
        if dx > 0.08 && self.facing_sign < 0.0 {
            self.facing_sign = 1.0;
            self.tail_vel += 3.5;
        } else if dx < -0.08 && self.facing_sign > 0.0 {
            self.facing_sign = -1.0;
            self.tail_vel -= 3.5;
        }
    }

    /// Triggers an interactive celebratory Paper-Mario flip-turn (e.g. when clicked!).
    pub fn trigger_cardboard_flip(&mut self) {
        self.flip_angle_rad = -PI;
        self.flip_target_rad = 0.0;
        self.flip_vel = 5.2;
        self.tail_vel += 6.0;
    }

    pub fn step(&mut self, dt: f32, walk_speed: f32) {
        let dt = dt.min(0.05);
        self.phase += dt;

        if self.state_blend < 1.0 {
            self.state_blend = (self.state_blend + dt / 0.24).min(1.0);
        }

        if walk_speed > 0.02 {
            self.stride_phase += dt * (7.5 + walk_speed * 2.8);
        } else {
            // Gently settle stride toward neutral
            let target_stride = (self.stride_phase / PI).round() * PI;
            self.stride_phase += (target_stride - self.stride_phase) * (dt * 7.0).min(1.0);
        }

        // Underdamped Paper-Mario 180° cardboard flip spring
        let flip_stiffness = 210.0;
        let flip_damping = 19.5;
        for _ in 0..2 {
            let h = dt * 0.5;
            let acc = (self.flip_target_rad - self.flip_angle_rad) * flip_stiffness - self.flip_vel * flip_damping;
            self.flip_vel += acc * h;
            self.flip_angle_rad += self.flip_vel * h;
        }
        if (self.flip_target_rad - self.flip_angle_rad).abs() < 0.002 && self.flip_vel.abs() < 0.01 {
            self.flip_angle_rad = self.flip_target_rad;
            self.flip_vel = 0.0;
        }

        // Spring-lag tail driven by active state wag + stride recoil
        let tail_target = match self.state {
            PuppetAnimState::Walk => (self.stride_phase - 0.65).sin() * 0.42,
            PuppetAnimState::Celebrate => (self.phase * 12.5 + self.seed).sin() * 0.52,
            PuppetAnimState::WaveAsk => (self.phase * 7.5 + self.seed).sin() * 0.34,
            PuppetAnimState::TendCrop => (self.phase * 5.2 + self.seed).sin() * 0.28,
            PuppetAnimState::Idle => (self.phase * 2.4 + self.seed).sin() * 0.20,
        };
        let tail_k = 95.0;
        let tail_c = 11.5;
        let t_acc = (tail_target - self.tail_angle) * tail_k - self.tail_vel * tail_c;
        self.tail_vel += t_acc * dt;
        self.tail_angle += self.tail_vel * dt;
    }

    fn pose_for_state(&self, st: PuppetAnimState) -> SkeletonPose {
        let mut p = SkeletonPose::identity();
        let t = self.phase + self.seed * 0.85;

        // Interactive click-flip spin on root (world travel heading is driven cleanly by HelperState.yaw_rad)
        p.set(
            BONE_ROOT,
            JointTransform {
                rot_y: self.flip_angle_rad,
                ..JointTransform::ZERO
            },
        );

        match st {
            PuppetAnimState::Idle => {
                let breathe = (t * 2.3).sin();
                p.set(
                    BONE_TORSO,
                    JointTransform {
                        rot_x: breathe * 0.035,
                        rot_z: (t * 1.15).sin() * 0.03,
                        translate: Vec3::new(0.0, breathe * 0.014, 0.0),
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_HEAD,
                    JointTransform {
                        rot_x: (t * 2.3 - 0.4).sin() * 0.045,
                        rot_y: (t * 0.9).sin() * 0.18,
                        rot_z: (t * 1.4).sin() * 0.06,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_ARM_L,
                    JointTransform {
                        rot_x: -0.22 + (t * 1.9).sin() * 0.07,
                        rot_z: -0.04 + breathe * 0.025,
                        ..JointTransform::ZERO
                    },
                );
                // Frame held artisan tools & Rabbit's mini lantern warmly forward in front of torso
                p.set(
                    BONE_ARM_R,
                    JointTransform {
                        rot_x: -0.34 + (t * 2.1 + 0.5).sin() * 0.08,
                        rot_z: 0.05 - breathe * 0.025,
                        ..JointTransform::ZERO
                    },
                );
            }
            PuppetAnimState::Walk => {
                let s = self.stride_phase.sin();
                let bounce = self.stride_phase.sin().abs();
                p.set(
                    BONE_TORSO,
                    JointTransform {
                        rot_x: 0.09 + bounce * 0.04,
                        rot_z: s * 0.075,
                        translate: Vec3::new(0.0, bounce * 0.034, 0.0),
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_HEAD,
                    JointTransform {
                        rot_x: -0.05 + (self.stride_phase * 2.0 - 0.5).sin() * 0.05,
                        rot_y: s * 0.09,
                        rot_z: -s * 0.06,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_LEG_L,
                    JointTransform {
                        rot_x: s * 0.54,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_LEG_R,
                    JointTransform {
                        rot_x: -s * 0.54,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_ARM_L,
                    JointTransform {
                        rot_x: -s * 0.45,
                        rot_z: -0.08,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_ARM_R,
                    JointTransform {
                        rot_x: s * 0.42 - 0.15,
                        rot_z: 0.08,
                        ..JointTransform::ZERO
                    },
                );
            }
            PuppetAnimState::TendCrop => {
                let work = (t * 5.2).sin();
                p.set(
                    BONE_TORSO,
                    JointTransform {
                        rot_x: 0.16 + work * 0.05,
                        rot_z: work * 0.04,
                        translate: Vec3::new(0.0, work.abs() * 0.016, 0.0),
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_HEAD,
                    JointTransform {
                        rot_x: 0.12 + (t * 5.2 - 0.4).sin() * 0.09,
                        rot_y: (t * 1.6).sin() * 0.12,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_ARM_L,
                    JointTransform {
                        rot_x: -0.25 - work * 0.14,
                        rot_z: -0.14,
                        ..JointTransform::ZERO
                    },
                );
                // Held craft tool (hoe / brush / lantern) dips rhythmically
                p.set(
                    BONE_ARM_R,
                    JointTransform {
                        rot_x: -0.78 + work * 0.46,
                        rot_z: 0.16 + work * 0.08,
                        ..JointTransform::ZERO
                    },
                );
            }
            PuppetAnimState::WaveAsk => {
                let wave = (t * 8.6).sin();
                let hop = (t * 4.3).sin().abs();
                p.set(
                    BONE_TORSO,
                    JointTransform {
                        rot_x: -0.04,
                        rot_z: (t * 4.3).sin() * 0.06,
                        translate: Vec3::new(0.0, hop * 0.028, 0.0),
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_HEAD,
                    JointTransform {
                        rot_x: -0.08,
                        rot_y: (t * 2.2).sin() * 0.14,
                        rot_z: (t * 4.3 - 0.3).sin() * 0.16,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_ARM_L,
                    JointTransform {
                        rot_x: -0.22,
                        rot_z: -0.18,
                        ..JointTransform::ZERO
                    },
                );
                // High enthusiastic Paper-Mario wave (within ±70° shoulder envelope)
                p.set(
                    BONE_ARM_R,
                    JointTransform {
                        rot_x: -1.18,
                        rot_z: 0.34 + wave * 0.26,
                        ..JointTransform::ZERO
                    },
                );
            }
            PuppetAnimState::Celebrate => {
                let jump = (t * 6.4).sin().abs();
                let pump = (t * 6.4).sin();
                p.set(
                    BONE_TORSO,
                    JointTransform {
                        rot_x: -0.05,
                        rot_z: pump * 0.06,
                        translate: Vec3::new(0.0, jump * 0.062, 0.0),
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_HEAD,
                    JointTransform {
                        rot_x: -0.08 + pump * 0.07,
                        rot_z: -pump * 0.09,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_ARM_L,
                    JointTransform {
                        rot_x: -1.04 + pump * 0.18,
                        rot_z: -0.20 - jump * 0.10,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_ARM_R,
                    JointTransform {
                        rot_x: -1.04 - pump * 0.18,
                        rot_z: 0.20 + jump * 0.10,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_LEG_L,
                    JointTransform {
                        rot_x: jump * 0.28,
                        ..JointTransform::ZERO
                    },
                );
                p.set(
                    BONE_LEG_R,
                    JointTransform {
                        rot_x: -jump * 0.28,
                        ..JointTransform::ZERO
                    },
                );
            }
        }

        // Spring-lag tail follows torso & momentum cleanly
        p.set(
            BONE_TAIL,
            JointTransform {
                rot_x: 0.12 + self.tail_angle.abs() * 0.18,
                rot_y: self.tail_angle,
                rot_z: self.tail_angle * 0.35,
                ..JointTransform::ZERO
            },
        );

        p
    }

    /// Evaluates the blended Paper-Mario skeleton pose into a 16-bone GPU palette.
    pub fn evaluate_palette(&self, bones: &[BoneDesc]) -> BonePalette {
        let cur = self.pose_for_state(self.state);
        if self.state_blend >= 0.999 || self.prev_state == self.state {
            return cur.evaluate(bones);
        }
        let prev = self.pose_for_state(self.prev_state);
        let t = self.state_blend;
        let smooth = t * t * (3.0 - 2.0 * t);
        prev.lerp(&cur, smooth).evaluate(bones)
    }
}

/// Evaluates articulated mechanical / architectural bone palettes (`waterwheel`, `lantern_swing`, `roof_lid`).
pub struct MachineRig;

impl MachineRig {
    /// Produces a 16-bone GPU palette for any building or prop whose `bones` table is non-empty.
    ///
    /// - `bone_id == 1` (`waterwheel`): steady continuous rotation around its X axle.
    /// - `bone_id == 2` (`lantern_swing`): gentle organic dual-frequency wind pendulum around its hook.
    /// - `bone_id == 3` (`roof_lid`): hinged rear-eave cutaway flip driven by `roof_cutaway_pos` (`0..1`).
    pub fn evaluate_palette(bones: &[BoneDesc], elapsed: f32, seed: f32, roof_cutaway_pos: f32) -> BonePalette {
        if bones.is_empty() {
            return identity_palette();
        }
        let mut pose = SkeletonPose::identity();
        for (idx, b) in bones.iter().enumerate().take(MAX_BONES) {
            if idx == BONE_ROOT {
                continue;
            }
            let name = b.name.as_str();
            if name.starts_with("waterwheel") || name.contains("wheel") || (name.is_empty() && idx == BONE_WATERWHEEL) {
                pose.set(
                    idx,
                    JointTransform {
                        rot_x: elapsed * 1.45 + seed * 0.4,
                        ..JointTransform::ZERO
                    },
                );
            } else if name.starts_with("lantern_swing") || name.contains("lantern") || name.contains("swing") || (name.is_empty() && idx == BONE_LANTERN_SWING)
            {
                // Independent organic phase per hanging lantern bone (e.g. lantern_swing, lantern_swing_2..6)
                let bone_phase = seed + (idx as f32) * 1.13;
                let sway_z = (elapsed * 1.85 + bone_phase).sin() * 0.115 + (elapsed * 3.15 + bone_phase * 1.7).sin() * 0.042;
                let sway_x = (elapsed * 1.45 + bone_phase * 0.6).cos() * 0.048;
                pose.set(
                    idx,
                    JointTransform {
                        rot_x: sway_x,
                        rot_z: sway_z,
                        ..JointTransform::ZERO
                    },
                );
            } else if name.starts_with("roof_lid") || name.contains("roof") || name.contains("lid") || (name.is_empty() && idx == BONE_ROOF_LID) {
                // Hinge front of roof UP and BACK around rear-eave crease (rot_x < 0 lifts +Z upward)
                let open_rad = -roof_cutaway_pos.clamp(-0.08, 1.15) * 1.18;
                pose.set(
                    idx,
                    JointTransform {
                        rot_x: open_rad,
                        ..JointTransform::ZERO
                    },
                );
            }
        }
        pose.evaluate(bones)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_puppet_bones() -> Vec<BoneDesc> {
        vec![
            BoneDesc {
                name: "root".into(),
                parent: -1,
                pivot: [0.0, 0.0, 0.0],
            },
            BoneDesc {
                name: "torso".into(),
                parent: 0,
                pivot: [0.0, 0.25, 0.0],
            },
            BoneDesc {
                name: "head".into(),
                parent: 1,
                pivot: [0.0, 0.55, 0.0],
            },
            BoneDesc {
                name: "arm_l".into(),
                parent: 1,
                pivot: [-0.22, 0.48, 0.0],
            },
            BoneDesc {
                name: "arm_r".into(),
                parent: 1,
                pivot: [0.22, 0.48, 0.0],
            },
            BoneDesc {
                name: "leg_l".into(),
                parent: 0,
                pivot: [-0.10, 0.22, 0.0],
            },
            BoneDesc {
                name: "leg_r".into(),
                parent: 0,
                pivot: [0.10, 0.22, 0.0],
            },
            BoneDesc {
                name: "tail".into(),
                parent: 1,
                pivot: [0.0, 0.26, -0.12],
            },
        ]
    }

    #[test]
    fn hierarchical_child_pivot_stays_attached_to_parent_with_zero_gap() {
        let bones = test_puppet_bones();
        let mut pose = SkeletonPose::identity();
        // Translate + tilt torso, then nod head independently around neck pivot
        pose.set(
            BONE_TORSO,
            JointTransform {
                rot_x: 0.35,
                rot_z: -0.22,
                translate: Vec3::new(0.0, 0.08, 0.0),
                ..JointTransform::ZERO
            },
        );
        pose.set(
            BONE_HEAD,
            JointTransform {
                rot_x: -0.45,
                rot_y: 0.30,
                ..JointTransform::ZERO
            },
        );

        let pal = pose.evaluate(&bones);
        let torso_m = Mat4(pal[BONE_TORSO]);
        let head_m = Mat4(pal[BONE_HEAD]);
        let neck_pivot = Vec3::new(0.0, 0.55, 0.0);

        // Neck joint transformed by parent (torso) MUST exactly equal neck joint transformed by child (head)!
        let p_torso = torso_m.transform_point(neck_pivot);
        let p_head = head_m.transform_point(neck_pivot);
        assert!(p_torso.sub(p_head).len() < 1e-5, "joint gap detected: torso={p_torso:?} vs head={p_head:?}");

        // Top of head (above neck) must actually move differently from torso-only transform
        let head_top = Vec3::new(0.0, 0.85, 0.0);
        assert!(torso_m.transform_point(head_top).sub(head_m.transform_point(head_top)).len() > 0.05);
    }

    #[test]
    fn puppet_rig_blends_states_and_executes_cardboard_flip_spring() {
        let bones = test_puppet_bones();
        let mut rig = PuppetRig::new(PuppetAnimState::Idle, 1.0);
        rig.set_state(PuppetAnimState::Walk);
        rig.trigger_cardboard_flip();
        assert!(rig.flip_angle_rad.abs() > 2.5, "expected crisp 180° flip start");

        for _ in 0..90 {
            rig.step(1.0 / 60.0, 1.15);
        }
        assert!(rig.state_blend >= 0.99);
        assert!(rig.flip_angle_rad.abs() < 0.05, "flip spring should settle cleanly");

        let pal = rig.evaluate_palette(&bones);
        // Walking leg_l and leg_r matrices should differ from identity
        let leg_tip = Vec3::new(-0.10, 0.0, 0.0);
        let moved_l = Mat4(pal[BONE_LEG_L]).transform_point(leg_tip);
        let moved_r = Mat4(pal[BONE_LEG_R]).transform_point(Vec3::new(0.10, 0.0, 0.0));
        assert!(moved_l.z.abs() + moved_r.z.abs() > 0.01);
    }

    #[test]
    fn machine_rig_spins_waterwheel_sways_lantern_and_hinges_roof_lid_upward() {
        let bones = vec![
            BoneDesc {
                name: "root".into(),
                parent: -1,
                pivot: [0.0, 0.0, 0.0],
            },
            BoneDesc {
                name: "waterwheel".into(),
                parent: 0,
                pivot: [0.55, 0.42, 0.0],
            },
            BoneDesc {
                name: "lantern_swing".into(),
                parent: 0,
                pivot: [0.0, 0.85, 0.45],
            },
            BoneDesc {
                name: "roof_lid".into(),
                parent: 0,
                pivot: [0.0, 0.78, -0.42],
            },
        ];
        let pal_closed = MachineRig::evaluate_palette(&bones, 1.2, 0.5, 0.0);
        let pal_open = MachineRig::evaluate_palette(&bones, 1.2, 0.5, 1.0);

        // Front roof eave (+Z relative to rear hinge) must lift UP (+Y) when cutaway opens!
        let front_eave = Vec3::new(0.0, 0.78, 0.42);
        let y_closed = Mat4(pal_closed[BONE_ROOF_LID]).transform_point(front_eave).y;
        let y_open = Mat4(pal_open[BONE_ROOF_LID]).transform_point(front_eave).y;
        assert!(
            y_open > y_closed + 0.55,
            "roof lid should lift front eave upward: closed={y_closed}, open={y_open}"
        );

        // Waterwheel spoke rotates around X axle (remains at same X, changes Y/Z)
        let spoke = Vec3::new(0.55, 0.82, 0.0);
        let p_rot = Mat4(pal_closed[BONE_WATERWHEEL]).transform_point(spoke);
        assert!((p_rot.x - 0.55).abs() < 1e-5);
        assert!(p_rot.z.abs() > 0.1);
    }
}
