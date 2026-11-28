use super::*;
use crate::asset::{BoneDesc, BuildingSpec, HelperSpec, PlotSpec, PropSpec, SceneSpec};
use crate::foley::SoundKind;
use crate::math::Vec3;
use crate::rig::PuppetAnimState;

fn sample_world() -> DioramaWorld {
    DioramaWorld::from_scene(
        SceneSpec {
            plots: vec![
                PlotSpec {
                    index: 0,
                    station: 0,
                    pos: [-3.0, 0.0, -3.0],
                    size: [2.1, 2.1],
                    unlock_level: None,
                },
                PlotSpec {
                    index: 1,
                    station: 1,
                    pos: [0.0, 0.0, -3.0],
                    size: [2.1, 2.1],
                    unlock_level: None,
                },
            ],
            buildings: vec![
                BuildingSpec {
                    id: "runtimes".into(),
                    label: "工坊".into(),
                    opens: "/runtimes".into(),
                    asset: "b_workshop".into(),
                    pos: [-6.0, 0.0, -2.5],
                    scale: 2.2,
                    yaw_deg: 20.0,
                },
                BuildingSpec {
                    id: "skills".into(),
                    label: "书屋".into(),
                    opens: "/settings/skills".into(),
                    asset: "b_library".into(),
                    pos: [6.0, 0.0, -2.5],
                    scale: 2.1,
                    yaw_deg: -20.0,
                },
            ],
            props: vec![PropSpec {
                asset: "p_lantern".into(),
                pos: [-4.0, 0.0, -4.0],
                scale: 1.05,
                yaw_deg: 0.0,
                is_lamp: true,
            }],
            helpers: vec![HelperSpec {
                id: "coder".into(),
                name: "Fox Coder".into(),
                role: "程序员".into(),
                asset: "h_fox".into(),
                home_plot: 0,
                default_spot: "runtimes".into(),
            }],
        },
        16.0,
    )
}

#[test]
fn regression_lighting_finishes_after_an_idle_gap_without_advancing_physics_by_seconds() {
    let mut world = sample_world();
    world.set_time_of_day(TimeOfDay::Night, true);
    world.set_time_of_day(TimeOfDay::Noon, false);
    let before = world.elapsed;
    world.step(2.0);
    assert_eq!(world.tod_blend, 1.0);
    assert!((world.elapsed - before - 0.05).abs() < 1e-5);
}

#[test]
fn regression_reduced_motion_paints_the_destination_light_and_folds() {
    let mut world = sample_world();
    world.set_time_of_day(TimeOfDay::Night, true);
    world.set_time_of_day(TimeOfDay::Noon, false);
    world.toggle_roof_cutaway();
    world.plots[0].sign_spring.fold_down_and_rise(0.2);
    world.settle_view();
    assert_eq!(world.tod_blend, 1.0);
    assert!(world.roof_cutaway_open() && !world.roof_cutaway_spring.is_moving());
    assert!(!world.camera.is_moving());
    assert_eq!(world.plots[0].sign_spring.pos, 1.0);
}

#[test]
fn place_nudge_rotate_scale_undo_and_redo_lifecycle() {
    let mut w = sample_world();
    let init_bldgs = w.buildings.len();
    let hit = w.place_entity(EntityKind::Building, "b_stall", 1.12, 2.38, 15.0, 1.85).expect("place building");
    assert_eq!(w.buildings.len(), init_bldgs + 1);
    assert_eq!(w.dynamic_entity_count(), 1);
    assert_eq!(w.redo_count(), 0);
    let placed = w.buildings.last().unwrap();
    assert!((placed.pos.x - 1.0).abs() < 1e-4);
    assert!((placed.pos.z - 2.5).abs() < 1e-4);
    assert!(placed.spring.pos < 0.05);
    assert_eq!(placed.spring.target, 1.0);

    assert!(w.nudge_selected(0.5, -0.5));
    assert!(w.rotate_selected(15.0));
    assert!(w.scale_selected(0.2));
    let tf = w.selected_transform().expect("selected transform");
    assert!((tf.x - 1.5).abs() < 1e-3);
    assert!((tf.z - 2.0).abs() < 1e-3);
    assert!((tf.yaw_deg - 30.0).abs() < 1e-2);
    assert!((tf.scale - 2.05).abs() < 1e-2);

    assert!(w.undo_last_edit());
    assert_eq!(w.redo_count(), 1);
    assert!((w.selected_transform().unwrap().scale - 1.85).abs() < 1e-2);
    assert!(w.redo_last_edit());
    assert_eq!(w.redo_count(), 0);
    assert!((w.selected_transform().unwrap().scale - 2.05).abs() < 1e-2);

    assert!(w.remove_entity_at_or_selected(Some(&hit)));
    assert_eq!(w.buildings.len(), init_bldgs);
    assert!(w.undo_last_edit());
    assert_eq!(w.buildings.len(), init_bldgs + 1);
    assert!(w.redo_last_edit());
    assert_eq!(w.buildings.len(), init_bldgs);
    assert!(w.undo_last_edit());
    assert_eq!(w.buildings.len(), init_bldgs + 1);

    assert!(w.clear_dynamic_edits());
    assert_eq!(w.dynamic_entity_count(), 0);
}

#[test]
fn cursor_gizmo_emits_only_when_active() {
    let mut w = sample_world();
    let base_count = w.collect_instances().len();
    w.set_editor_cursor(Some(EditorCursor {
        x: 1.5,
        z: -2.0,
        kind: EntityKind::Prop,
        asset_id: "p_lantern".into(),
        yaw_deg: 45.0,
        scale: 1.1,
        valid: true,
        reason: None,
    }));
    let with_cursor = w.collect_instances();
    assert_eq!(with_cursor.len(), base_count + 2);
    assert_eq!(with_cursor[with_cursor.len() - 2].mesh_id, "plot_frame");
    assert_eq!(with_cursor[with_cursor.len() - 1].mesh_id, "p_lantern");

    let mini: serde_json::Value = serde_json::from_str(&w.minimap_snapshot_json()).expect("valid minimap json");
    assert_eq!(mini["cursor"]["x"], 1.5);
    assert_eq!(mini["cursor"]["z"], -2.0);

    w.clear_editor_cursor();
    assert_eq!(w.collect_instances().len(), base_count);
}

#[test]
fn atlas_persistence_and_json_export_import_roundtrip() {
    let mut w = sample_world();
    w.place_entity(EntityKind::Prop, "p_willow", 2.0, 2.0, 0.0, 2.0);
    assert_eq!(w.dynamic_entity_count(), 1);

    assert!(w.switch_atlas_map("starterFarm"));
    assert_eq!(w.active_preset, "starterFarm");
    assert_eq!(w.dynamic_entity_count(), 0);
    assert!(w.atlas_saved_keys().contains(&"fullTown".to_string()));

    w.place_entity(EntityKind::Building, "b_stall", 1.5, 1.0, 30.0, 1.9);
    assert!(w.switch_atlas_map("fullTown"));
    assert_eq!(w.dynamic_entity_count(), 1);
    assert!(w.props.iter().any(|p| p.asset == "p_willow" && p.is_dynamic));

    assert!(w.switch_atlas_map("starterFarm"));
    assert!(w.buildings.iter().any(|b| b.asset == "b_stall" && b.is_dynamic));

    let exported = w.export_scene_json();
    assert!(w.apply_map_preset("fullTown"));
    assert!(!w.buildings.iter().any(|b| b.asset == "b_stall" && b.is_dynamic));

    let imported_count = w.import_scene_json(&exported).expect("import valid json");
    assert!(imported_count >= 5);
    assert_eq!(w.active_preset, "starterFarm");
    assert!(w.buildings.iter().any(|b| b.asset == "b_stall" && b.is_dynamic));

    assert!(w.import_scene_json("{not valid").is_err());
    assert!(w.import_scene_json("{}").is_err());
}

#[test]
fn presets_export_and_minimap_snapshot_are_valid_json() {
    let mut w = sample_world();
    assert!(w.apply_map_preset("starterFarm"));
    assert_eq!(w.active_preset, "starterFarm");
    assert!(w.buildings.iter().any(|b| b.id == "runtimes"));
    assert!(!w.buildings.iter().any(|b| b.id == "skills"));

    assert!(w.apply_map_preset("busyFactory"));
    assert_eq!(w.active_preset, "busyFactory");
    assert!(w.dynamic_entity_count() >= 4);

    w.pan_camera_to(2.5, -1.5);
    let mini: serde_json::Value = serde_json::from_str(&w.minimap_snapshot_json()).expect("valid minimap json");
    assert_eq!(mini["groundSize"], 16.0);
    assert!(mini["plots"].as_array().unwrap().len() == 2);
    assert!((mini["camera"]["x"].as_f64().unwrap() - 2.5).abs() < 0.1);

    let exported: serde_json::Value = serde_json::from_str(&w.export_scene_json()).expect("valid export json");
    assert_eq!(exported["preset"], "busyFactory");
    assert!(exported["props"].as_array().unwrap().len() >= 5);
}

#[test]
fn roof_cutaway_and_puppet_anim_state_follow_plot_stage() {
    let mut w = sample_world();
    w.mesh_bones.insert(
        "b_workshop".into(),
        vec![
            BoneDesc {
                name: "root".into(),
                parent: -1,
                pivot: [0.0, 0.0, 0.0],
            },
            BoneDesc {
                name: "waterwheel".into(),
                parent: 0,
                pivot: [-0.54, 0.40, 0.14],
            },
            BoneDesc {
                name: "lantern_swing".into(),
                parent: 0,
                pivot: [0.0, 0.80, 0.45],
            },
            BoneDesc {
                name: "roof_lid".into(),
                parent: 0,
                pivot: [0.0, 0.78, -0.42],
            },
        ],
    );
    assert!(!w.roof_cutaway_open());
    assert!(w.toggle_roof_cutaway());
    assert!(w.roof_cutaway_open());
    for _ in 0..80 {
        w.step(1.0 / 60.0);
    }
    assert!(w.roof_cutaway_spring.pos > 0.95);

    w.set_plot_stage(0, PlotStage::Asking);
    w.helpers[0].target_pos = w.helpers[0].pos;
    w.helpers[0].wait_timer = 10.0;
    w.step(1.0 / 60.0);
    assert_eq!(w.helpers[0].rig.state, PuppetAnimState::WaveAsk);

    let instances = w.collect_instances();
    let ws = instances.iter().find(|i| i.mesh_id == "b_workshop").expect("workshop instance");
    assert!(ws.bone_base > 0);
    assert!(ws.bone_palette.is_some());
}

#[test]
fn helper_climbs_over_bridge_arch_and_rabbit_emits_moving_lantern_pool() {
    let scene = SceneSpec {
        plots: vec![PlotSpec {
            index: 5,
            station: 5,
            pos: [-2.80, 0.0, -0.55],
            size: [1.22, 1.04],
            unlock_level: None,
        }],
        buildings: vec![BuildingSpec {
            id: "shop".into(),
            label: "小摊".into(),
            opens: "panel:shop".into(),
            asset: "b_stall".into(),
            pos: [2.25, 0.0, -0.45],
            scale: 1.68,
            yaw_deg: -24.0,
        }],
        props: vec![PropSpec {
            asset: "p_bridge_arch".into(),
            pos: [-0.85, 0.0, 0.55],
            scale: 1.06,
            yaw_deg: -4.0,
            is_lamp: false,
        }],
        helpers: vec![
            HelperSpec {
                id: "designer".into(),
                name: "Cat Designer".into(),
                role: "设计师".into(),
                asset: "h_cat".into(),
                home_plot: 0,
                default_spot: "shop".into(),
            },
            HelperSpec {
                id: "orchestrator".into(),
                name: "Rabbit Lead".into(),
                role: "主助手".into(),
                asset: "h_rabbit".into(),
                home_plot: 0,
                default_spot: "shop".into(),
            },
        ],
    };
    let mut w = DioramaWorld::from_scene(scene, 16.0);
    assert!(!w.helpers[0].path.is_empty(), "Cat should have an active bridge route");
    let base_insts = w.collect_instances().len();
    w.set_show_routes(true);
    assert!(w.collect_instances().len() > base_insts, "show_routes should emit 3D route markers");

    let mut max_y = 0.0f32;
    for _ in 0..160 {
        w.step(1.0 / 60.0);
        max_y = max_y.max(w.helpers[0].pos.y);
    }
    assert!(max_y > 0.50, "Cat must climb UP over Bridge #1 arch crest (~0.57m), only reached y={max_y}");

    let r_lamp = w.rabbit_lantern_pos().expect("rabbit lantern position");
    assert!(w.lamp_positions().first().copied() == Some(r_lamp));

    let mini: serde_json::Value = serde_json::from_str(&w.minimap_snapshot_json()).expect("valid minimap json");
    assert!(!mini["navEdges"].as_array().unwrap().is_empty());
}

#[test]
fn walking_helper_faces_true_north_back_and_south_front_headings() {
    let mut w = sample_world();
    w.helpers[0].pos = Vec3::new(0.0, 0.0, 2.0);
    w.helpers[0].yaw_rad = 0.0;
    w.helpers[0].yaw_vel = 0.0;
    w.helpers[0].path = vec![Vec3::new(0.0, 0.0, -4.0)];
    for _ in 0..45 {
        w.step(1.0 / 60.0);
    }
    let cos_north = w.helpers[0].yaw_rad.cos();
    assert!(
        cos_north < -0.5,
        "walking north must show puppet back (cos(yaw) < -0.5), got yaw={} cos={cos_north}",
        w.helpers[0].yaw_rad
    );

    w.helpers[0].path = vec![Vec3::new(0.0, 0.0, 5.0)];
    for _ in 0..45 {
        w.step(1.0 / 60.0);
    }
    let cos_south = w.helpers[0].yaw_rad.cos();
    assert!(
        cos_south > 0.5,
        "walking south must show puppet front (cos(yaw) > 0.5), got yaw={} cos={cos_south}",
        w.helpers[0].yaw_rad
    );
}

#[test]
fn phase_a_interact_plot_domain_sync_focus_and_dynamic_repath() {
    use crate::domain::{DecorationSync, PlotTicketSync, YardSnapshotSync};

    let mut w = sample_world();
    assert_eq!(w.plots[0].stage, PlotStage::Reviewing);
    let outcome = w.interact_plot(0).expect("harvest reviewing plot");
    assert_eq!(outcome.harvest_delta, 1);
    assert_eq!(outcome.harvest_count, 1);
    assert_eq!(outcome.next_stage, PlotStage::Empty);
    assert_eq!(outcome.sound, SoundKind::HarvestChime);
    assert_eq!(w.helpers[0].rig.state, PuppetAnimState::Celebrate);

    w.apply_domain_sync(YardSnapshotSync {
        plots: vec![PlotTicketSync {
            index: 1,
            stage: PlotStage::Asking,
            title: "#200 Sync Ticket".into(),
            locked: Some(false),
        }],
        helpers: vec![],
        decorations: vec![DecorationSync {
            id: "deco_stone_lantern".into(),
            asset: "p_lantern".into(),
            x: 2.15,
            z: -1.85,
            yaw_deg: 12.0,
            scale: 1.15,
        }],
        time_of_day: Some(TimeOfDay::Dusk),
    });
    assert_eq!(w.plots[1].stage, PlotStage::Asking);
    assert_eq!(w.plots[1].title, "#200 Sync Ticket");
    assert_eq!(w.time_of_day, TimeOfDay::Dusk);
    assert_eq!(w.props.iter().filter(|p| p.id == "shop_deco_deco_stone_lantern").count(), 1);

    w.apply_domain_sync(YardSnapshotSync {
        decorations: vec![DecorationSync {
            id: "deco_stone_lantern".into(),
            asset: "p_lantern".into(),
            x: 2.15,
            z: -1.85,
            yaw_deg: 12.0,
            scale: 1.15,
        }],
        ..Default::default()
    });
    assert_eq!(w.props.iter().filter(|p| p.id == "shop_deco_deco_stone_lantern").count(), 1);

    let anchors = w.project_screen_anchors(16.0 / 10.0);
    assert!(anchors.iter().any(|a| a.plot_index == Some(1) && a.urgent));

    assert!(w.focus_building_interior("runtimes"));
    assert!(w.roof_cutaway_open());
    assert!(w.camera.is_focused());
    assert_eq!(w.focused_building.as_deref(), Some("runtimes"));
    assert!(w.exit_interior_focus());
    assert!(!w.roof_cutaway_open());
    assert!(!w.camera.is_focused());
    assert!(w.focused_building.is_none());

    w.pending_sounds.clear();
    let blocked = w.try_place_entity(EntityKind::Building, "b_stall", -0.8, 0.5, 0.0, 1.9);
    assert!(blocked.is_err());
    assert_eq!(w.pending_sounds.last().copied(), Some(SoundKind::AlertSoft));

    w.plots[0].stage = PlotStage::Leafy;
    w.helpers[0].pos = Vec3::new(5.2, 0.0, 0.8);
    w.helpers[0].path.clear();
    w.helpers[0].celebrate_timer = 0.0;
    w.helpers[0].wait_timer = 5.0;
    w.helpers[0].rig.set_state(PuppetAnimState::Idle);
    w.step(1.0 / 60.0);
    assert_eq!(
        w.helpers[0].rig.state,
        PuppetAnimState::Idle,
        "helper far from home plot must stay Idle instead of hoeing air"
    );

    let bridge_hit = w
        .try_place_entity(EntityKind::Prop, "p_bridge_arch", -0.85, 0.55, 0.0, 1.0)
        .expect("place bridge over canal");
    w.helpers[0].pos = Vec3::new(-0.85, 0.54, 0.55);
    w.helpers[0].path = vec![Vec3::new(0.5, 0.0, 0.55)];
    assert!(w.remove_entity_at_or_selected(Some(&bridge_hit)));
    assert!(w.helpers[0].path.is_empty());
    assert!(w.helpers[0].pos.y.abs() < 1e-4);
}
