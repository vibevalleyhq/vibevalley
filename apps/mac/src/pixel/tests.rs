//! Scenes run on the real art and the fake server's farm fixture. Skipped
//! when the repo's `assets/` is missing. `VIBEVALLEY_PIXEL_OUT=<dir>`
//! writes each scene's CPU raster there as PNG.

use std::path::PathBuf;

use super::draw::raster;
use super::farm::frame::Frame;
use super::farm::scene::FarmScene;
use super::*;

fn fixture(name: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../crates/vibevalley-bridge/fixtures/farm")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub(crate) fn save(name: &str, img: &image::RgbaImage) {
    if let Some(dir) = std::env::var_os("VIBEVALLEY_PIXEL_OUT") {
        let path = PathBuf::from(dir).join(format!("{name}.png"));
        img.save(&path).unwrap();
        eprintln!("wrote {}", path.display());
    }
}

#[test]
fn farm_walks_helpers_to_their_work() {
    if !assets_dir().join("village.ldtk").exists() {
        eprintln!("skipped: no assets");
        return;
    }
    let (world, atlas) = load_village().unwrap();
    assert_eq!((world.level.width, world.level.height), (384.0, 256.0));
    let mut scene = FarmScene::new(world, atlas.clone());
    scene.frame = Frame::parse(&fixture("state.json"));
    for _ in 0..(30 * 30) {
        scene.tick(1.0 / 30.0);
    }
    let state = scene.debug_state();
    let actors = state["actors"].as_array().unwrap();
    assert_eq!(actors.len(), 7, "{state:#}");
    let goal = |id: &str| actors.iter().find(|a| a["id"] == id).unwrap()["goal"].as_str().unwrap().to_string();
    assert_eq!(goal("s-read"), "library");
    assert_eq!(goal("s-cmd"), "workshop");
    assert_eq!(goal("s-ripe"), "plot:front");
    assert_eq!(goal("s-queue"), "queue:0");
    assert!(actors.iter().all(|a| a["walking"] == false), "{state:#}");
    assert_eq!(state["beds"][4], "wheat");
    assert_eq!(state["beds"][6], "flowering", "level 6 clears the first locked bed");
    assert_eq!(state["beds"][7], "locked");
    let list = scene.draw(3.0);
    assert!(list.ops.len() > 30);
    let img = raster(&list, Some(&atlas), 2.0);
    assert_eq!(img.dimensions(), (768, 512));
    save("farm-day", &img);
    scene.clock.set_time_of_day(0.95);
    save("farm-night", &raster(&scene.draw(3.0), Some(&atlas), 2.0));
}

#[test]
fn map_draws_an_island_per_repo() {
    if !assets_dir().join("pixel/sprites.json").exists() {
        return;
    }
    use super::farm::islands::{MapHit, MapScene, RepoSummary};
    let atlas = load_atlas().unwrap();
    let mut map = MapScene::new(atlas.clone());
    map.frame = Frame::parse(&fixture("state.json"));
    map.repos = serde_json::from_value::<Vec<RepoSummary>>(fixture("responses.json")["repo.list"].clone()).unwrap();
    map.tick(0.1);
    let state = map.debug_state();
    let islands = state["islands"].as_array().unwrap();
    assert_eq!(islands.len(), 4, "{state:#}");
    // Peopled islands first. Five helpers work, so the farm has room for one more: one open spot, the rest shut.
    assert_eq!(islands[0]["repo"], "vibevalley");
    assert_eq!(islands[3]["repo"], "site");
    assert_eq!(islands[3]["spots"], serde_json::json!(["open", "shut"]));
    let list = map.draw(1.6);
    assert!(list.fit);
    let img = raster(&list, Some(&atlas), 2.0);
    save("map", &img);
    // A click on the middle of the first island's picture finds something on it.
    let hit = map.hit_at(level::pt(list.width / 4.0, 24.0 + 120.0));
    assert!(
        matches!(hit, Some(MapHit::Island(_)) | Some(MapHit::Plot { .. }) | Some(MapHit::Sow(_))),
        "{hit:?}"
    );
}

#[test]
fn tree_grows_on_the_hill() {
    if !assets_dir().join("pixel/tree-hill.png").exists() {
        return;
    }
    let mut tree = super::tree::TreeScene::new(load_atlas().unwrap());
    tree.tick(0.05);
    let atlas = tree.atlas.clone();
    save("tree-dusk", &raster(&tree.draw(), Some(&atlas), 2.0));
    tree.clock.set_time_of_day(0.95);
    tree.rounds = 600.0;
    save("tree-night-full", &raster(&tree.draw(), Some(&atlas), 2.0));
    assert_eq!(tree.debug_state()["seeds"], 6);
}

#[test]
fn opening_draws_the_scene_of_the_hour() {
    if !assets_dir().join("brand/opening-day.webp").exists() {
        return;
    }
    let mut o = super::opening::OpeningScene::load(Some("morning"));
    o.demo = true;
    for _ in 0..60 {
        o.tick(0.1);
    }
    let state = o.debug_state();
    assert_eq!(state["frames"], 5, "{state}");
    assert_eq!(state["pictures"], true);
    assert_eq!(state["phase"], "Loading"); // six seconds in: 72%
    let list = o.draw();
    assert_eq!(list.hud_images.len(), 1);
    save("opening", &raster(&list, None, 2.0));
    save("opening-sprite", &list.hud_images[0].1);
}

#[test]
fn catalog_shelves_every_sprite() {
    if !assets_dir().join("pixel/sprites.json").exists() {
        return;
    }
    let atlas = load_atlas().unwrap();
    let mut c = super::catalog::CatalogScene::new(atlas.clone());
    let counts = c.debug_state()["counts"].clone();
    let total: u64 = counts.as_object().unwrap().values().map(|v| v.as_u64().unwrap()).sum();
    assert_eq!(total as usize, atlas.names().count());
    assert_eq!(counts["helpers"], 7 * 72);
    save("catalog-helpers", &raster(&c.draw(), Some(&atlas), 2.0));
    c.tap(level::pt(4.0 + 40.0 * 5.0 + 5.0, 8.0)); // the map shelf
    c.tap(level::pt(384.0 - 4.0 - 18.0 + 3.0, 8.0)); // night ground
    assert_eq!(c.debug_state()["shelf"], "map");
    assert_eq!(c.debug_state()["ground"], "夜里");
    save("catalog-map-night", &raster(&c.draw(), Some(&atlas), 2.0));
}

#[test]
fn regression_night_tints_ground_but_keeps_hud_readable() {
    let (world, atlas) = load_village().unwrap();
    let mut scene = FarmScene::new(world, atlas.clone());
    scene.frame = Frame::parse(&fixture("state.json"));
    scene.clock.set_time_of_day(0.50);
    let day = scene.draw(2.0);
    scene.clock.set_time_of_day(0.92);
    let night = scene.draw(2.0);
    assert!(night.lit > 0);
    assert!(night.ops[night.lit..].iter().any(|op| matches!(op, draw::Op::Glow { .. })));
    let energy = |img: image::RgbaImage| img.pixels().map(|p| p.0[..3].iter().map(|c| *c as u64).sum::<u64>()).sum::<u64>();
    assert!(energy(raster(&night, Some(&atlas), 1.0)) < energy(raster(&day, Some(&atlas), 1.0)));
    let paper = |list: &draw::DrawList| {
        list.hud
            .iter()
            .find_map(|op| match op {
                draw::HudOp::Rect { color, .. } => Some(*color),
                _ => None,
            })
            .unwrap()
    };
    assert_eq!(paper(&day), paper(&night));
    save("farm-hud-night", &draw::raster_view(&night, Some(&atlas), scene.view_size));
}

#[test]
fn regression_farm_controls_stay_in_the_pane_and_modal_blocks_the_ground() {
    use farm::hud::{Action, Layout, Panel, hit};
    let (world, atlas) = load_village().unwrap();
    let mut scene = FarmScene::new(world, atlas.clone());
    scene.frame = Frame::parse(&fixture("state.json"));
    for size in [(320.0, 400.0), (768.0, 512.0), (1200.0, 700.0)] {
        scene.view_size = size;
        let layout = Layout::new(&scene);
        for b in layout.nav.iter().map(|n| &n.bounds).chain(&layout.tools) {
            assert!(b.x >= 0.0 && b.y >= 0.0 && b.x + b.w <= size.0 && b.y + b.h <= size.1);
            assert!(hit(&scene, b.x + b.w / 2.0, b.y + b.h / 2.0).is_some());
        }
        scene.panel = Some(Panel::Chat);
        assert_eq!(hit(&scene, 0.0, 0.0), Some(Action::Block));
        let list = scene.draw(2.0);
        assert!(list.hud_view);
        save(&format!("farm-chat-{}", size.0 as u32), &draw::raster_view(&list, Some(&atlas), size));
        scene.panel = None;
        scene.phone.open = true;
        assert_eq!(hit(&scene, layout.phone.x + 40.0, layout.phone.y + 40.0), Some(Action::Block));
        scene.phone.open = false;
    }
}

#[test]
fn regression_tree_hud_is_anchored_to_the_pane() {
    let mut tree = tree::TreeScene::new(load_atlas().unwrap());
    tree.view_size = (320.0, 400.0);
    let list = tree.draw();
    assert!(list.hud_view);
    assert!(list.hud.iter().any(|op| matches!(op, draw::HudOp::TextIn { text, .. } if !text.is_empty())));
    for op in &list.hud {
        if let draw::HudOp::Rect { x, y, w, h, .. } = op {
            assert!(*x >= 0.0 && *y >= 0.0 && x + w <= 320.0 && y + h <= 400.0);
        }
    }
}

#[test]
fn regression_tools_only_choose_actions_supplied_by_the_server() {
    use farm::scene::FarmTool;
    use vibevalley_protocol::{IssueAct, IssueAction, IssueStage, IssueStageKind};
    let mut stage = IssueStage {
        state: IssueStageKind::Working,
        since: None,
        stuck: None,
        lead: None,
        acts: vec![],
    };
    assert!(FarmTool::Shovel.action(&stage).is_none());
    stage.acts.push(IssueAction::Stop { act: IssueAct::Stop });
    assert!(matches!(FarmTool::Shovel.action(&stage), Some(IssueAction::Stop { .. })));
    assert!(FarmTool::Bug.action(&stage).is_none());
    for tool in [FarmTool::Hand, FarmTool::Water, FarmTool::Weed, FarmTool::Harvest] {
        assert!(tool.action(&stage).is_none());
    }
}

#[test]
fn regression_helper_outfits_change_on_the_next_frame() {
    let (world, atlas) = load_village().unwrap();
    let mut scene = FarmScene::new(world, atlas);
    scene.frame = Frame::parse(&fixture("state.json"));
    let worker = scene.frame.state.sessions.iter().find(|s| s.is_worker()).unwrap().clone();
    scene.agent_looks.insert(worker.agent.clone(), ("fox".into(), "farmer".into()));
    scene.tick(0.1);
    let list = scene.draw(2.0);
    assert!(
        list.ops
            .iter()
            .any(|op| matches!(op, draw::Op::Sprite { name, .. } if name.starts_with("fox-farmer")))
    );
    scene.agent_looks.insert(worker.agent, ("rabbit".into(), "farmer".into()));
    scene.tick(0.1);
    assert!(
        scene
            .draw(2.0)
            .ops
            .iter()
            .any(|op| matches!(op, draw::Op::Sprite { name, .. } if name.starts_with("rabbit-farmer")))
    );
}

#[test]
fn regression_native_farm_labels_are_embedded_for_both_languages() {
    for locale in ["zh", "en"] {
        for key in ["web.farm.native.progress", "web.farm.native.treeCounts", "web.farm.tool.hand.hint"] {
            assert_ne!(vibevalley_i18n::t_in(locale, key, &[]), key);
        }
    }
}

#[test]
fn farm_fixture_supplies_typed_chat_and_profiles() {
    let frame = Frame::parse(&fixture("state.json"));
    assert!(!frame.state.chat.channels.is_empty());
    let replies = fixture("responses.json");
    let agents: Vec<vibevalley_protocol::Agent> = serde_json::from_value(replies["agent.list"].clone()).unwrap();
    let messages: Vec<vibevalley_protocol::ChatMessage> = serde_json::from_value(replies["channel.message.list"].clone()).unwrap();
    assert!(!agents.is_empty());
    assert_eq!(messages[0].channel, frame.state.chat.channels[0].id);
    let (world, atlas) = load_village().unwrap();
    let mut scene = FarmScene::new(world, atlas);
    scene.frame = frame;
    scene.panel = Some(farm::hud::Panel::Chat);
    let p = farm::hud::Layout::new(&scene).panel;
    assert_eq!(
        farm::hud::hit(&scene, p.x + 20.0, p.y + 50.0),
        Some(farm::hud::Action::Route(format!("/chat/{}", messages[0].channel)))
    );
}
