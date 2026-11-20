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
fn regression_overlapping_helpers_draw_and_hit_in_arrival_order_at_the_same_animation_step() {
    let (world, atlas) = load_village().unwrap();
    let mut scene = FarmScene::new(world, atlas);
    let mut frame = Frame::parse(&fixture("state.json"));
    let mut first = frame.state.sessions.iter().find(|s| s.id == "s-ripe").unwrap().clone();
    first.id = "z-first".into();
    first.agent = "owl".into();
    let mut last = first.clone();
    last.id = "a-last".into();
    last.agent = "fox".into();
    for species in ["owl", "fox"] {
        scene.agent_looks.insert(species.into(), (species.into(), "farmer".into()));
    }
    frame.view.plays.insert(first.id.clone(), farm::frame::Play { station: 0. });
    frame.view.plays.insert(last.id.clone(), farm::frame::Play { station: 1. });
    frame.state.sessions = vec![first];
    scene.apply_frame(frame.clone());
    scene.tick(0.);
    frame.seq += 1;
    frame.state.sessions.push(last);
    scene.apply_frame(frame);
    for _ in 0..30 {
        scene.tick(1. / 60.);
    }
    let list = scene.draw(3.);
    let bodies: Vec<_> = list
        .ops
        .iter()
        .filter_map(|op| match op {
            draw::Op::Sprite { name, .. } if name.starts_with("owl-farmer-") || name.starts_with("fox-farmer-") => Some(name.as_str()),
            _ => None,
        })
        .collect();
    let [first, last] = &bodies[..] else {
        panic!("expected two helpers: {bodies:?}")
    };
    let stride = first.strip_prefix("owl-farmer-walk-side@").unwrap();
    assert_eq!(last.strip_prefix("fox-farmer-walk-side@"), Some(stride));
    let at = scene.helper_feet("a-last").unwrap();
    assert_eq!(scene.helper_feet("z-first"), Some(at));
    assert_eq!(scene.hit_at(at + level::pt(0., -8.)), Some(farm::world::VillageHit::Session("a-last".into())));
}

#[test]
fn regression_blacksmith_fire_and_anvil_land_on_the_baked_workshop() {
    let (world, atlas) = load_village().unwrap();
    let forge = world.lights.iter().find(|l| matches!(l.source, farm::world::LightSource::Forge)).unwrap().at;
    let anvil = world.emitter("anvil").unwrap();
    for point in [forge, anvil] {
        assert_eq!(atlas.landmark_at(point).map(|(id, _)| id), Some("runtimes"));
    }

    let map = atlas.image("map").unwrap();
    let (x, y) = ((forge.x * atlas.density).round() as u32, (forge.y * atlas.density).round() as u32);
    let r = atlas.density.ceil() as u32;
    let on_live_coals = (y.saturating_sub(r)..=y + r).any(|y| {
        (x.saturating_sub(r)..=x + r).any(|x| {
            map.get_pixel_checked(x, y).is_some_and(|p| {
                let [red, green, blue, _] = p.0;
                red >= 220 && red.saturating_sub(green) >= 25 && green.saturating_sub(blue) >= 40
            })
        })
    });
    assert!(on_live_coals, "forge light {forge:?} missed the baked coals");
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
    for (id, clip) in [
        ("s-read", "read"),
        ("s-cmd", "hammer"),
        ("s-edit", "hoe"),
        ("s-ask", "ask"),
        ("s-stuck", "worry"),
    ] {
        let actor = actors.iter().find(|a| a["id"] == id).unwrap();
        assert!(actor["sprite"].as_str().unwrap().contains(&format!("-{clip}@")), "{actor:#}");
    }
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
fn regression_fox_starts_each_station_clip_after_its_feet_stop() {
    use farm::frame::Crop;
    use vibevalley_protocol::IssueStageKind;

    let (world, atlas) = load_village().unwrap();
    let mut scene = FarmScene::new(world, atlas.clone());
    let mut frame = Frame::parse(&fixture("state.json"));
    frame.state.sessions.retain(|s| s.id == "s-edit");
    let worker = &frame.state.sessions[0];
    let issue_id = worker.issue.clone().unwrap();
    scene.agent_looks.insert(worker.agent.clone(), ("fox".into(), "farmer".into()));
    for (action, stage, crop, clip) in [
        ("edit_file", IssueStageKind::Working, Crop::Leafy, "hoe"),
        ("run_command", IssueStageKind::Working, Crop::Leafy, "hammer"),
        ("wait", IssueStageKind::Asking, Crop::Dry, "ask"),
        ("wait", IssueStageKind::Stuck, Crop::Dry, "worry"),
    ] {
        frame.seq += 1;
        frame.state.sessions[0].phase.doing.as_mut().unwrap().action = action.into();
        frame.state.issues.iter_mut().find(|i| i.id == issue_id).unwrap().stage.as_mut().unwrap().state = stage;
        frame.view.plots.get_mut(&issue_id).unwrap().crop = crop;
        scene.apply_frame(frame.clone());
        let mut samples = [false; 8];
        for _ in 0..600 {
            scene.tick(1. / 30.);
            let state = scene.debug_state();
            let actor = &state["actors"][0];
            let name = actor["sprite"].as_str().unwrap();
            if actor["walking"] == true {
                assert!(name.starts_with("fox-farmer-walk-"), "{name}");
            } else if let Some(sample) = name.strip_prefix(&format!("fox-farmer-{clip}@")) {
                let index: usize = sample.parse().unwrap();
                if !samples[index] && matches!(index, 2 | 5) && std::env::var_os("VIBEVALLEY_PIXEL_OUT").is_some() {
                    save(&format!("fox-{clip}-{index}"), &raster(&scene.draw(2.), Some(&atlas), 2.));
                }
                samples[index] = true;
                if samples.iter().all(|seen| *seen) {
                    break;
                }
            }
        }
        assert_eq!(samples, [true; 8], "{clip}");
    }
}

#[test]
fn regression_oblique_soil_accepts_clicks_only_on_its_visible_pixels() {
    let (world, atlas) = load_village().unwrap();
    let mut scene = FarmScene::new(world, atlas.clone());
    let center_bed = 4;
    let foot = projection::ground(scene.world.plot_at(center_bed));
    let (left, top) = atlas.top_left("plot-empty", foot.x, foot.y, false).unwrap();
    let sprite = atlas.image("plot-empty").unwrap();
    let mut opaque = 0;
    let mut clear = 0;
    for (x, y, pixel) in sprite.enumerate_pixels() {
        let point = level::pt(left + (x as f32 + 0.5) / atlas.density, top + (y as f32 + 0.5) / atlas.density);
        let selected = scene.hit_at(point) == Some(farm::world::VillageHit::Plot(center_bed));
        assert_eq!(selected, pixel[3] >= 128, "mismatch at {point:?}");
        if selected { opaque += 1 } else { clear += 1 }
    }
    assert!(opaque > 100 && clear > 100);
    scene.point(Some(level::pt(left + 1., top + 1.)));
    assert_ne!(scene.hover, Some(farm::world::VillageHit::Plot(center_bed)));
}

#[test]
fn map_draws_an_island_per_repo() {
    if !assets_dir().join("pixel/sprites.json").exists() {
        return;
    }
    use super::farm::islands::{MapHit, MapScene, RepoSummary};
    let atlas = load_atlas().unwrap();
    let mut map = MapScene::new(atlas.clone());
    map.apply_frame(Frame::parse(&fixture("state.json")));
    map.set_repos(serde_json::from_value::<Vec<RepoSummary>>(fixture("responses.json")["repo.list"].clone()).unwrap());
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
    let label_rows: Vec<_> = list.hud_art.iter().map(|(_, y, _)| *y).collect();
    assert_eq!(label_rows.len(), 4);
    assert!(label_rows[0] == label_rows[1] && label_rows[2] == label_rows[3] && label_rows[0] < label_rows[2]);
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
fn regression_map_fills_wide_pane_without_letterbox_seam() {
    if !assets_dir().join("pixel/sprites.json").exists() {
        return;
    }
    use super::farm::islands::{MapScene, RepoSummary};
    let atlas = load_atlas().unwrap();
    let mut map = MapScene::new(atlas.clone());
    map.apply_frame(Frame::parse(&fixture("state.json")));
    map.set_repos(serde_json::from_value::<Vec<RepoSummary>>(fixture("responses.json")["repo.list"].clone()).unwrap());
    let view = (1278.0, 848.0);
    map.view_size = Some(view);
    map.tick(0.1);
    let list = map.draw(view.0 / view.1);
    let f = sky::fit_framing(view, (list.width, list.height));
    assert!(f.bx.x > 40.0, "expected horizontal margin to test wide pane: {f:?}");
    let img = draw::raster_view(&list, Some(&atlas), view);
    save("map-wide", &img);
    let sea = [0xcf, 0xe3, 0xd6, 255];
    let grid = [0xb7, 0xd2, 0xc4, 255];
    // Margins and centre share the exact same sea colour (no 0.7x dark pillarbox / bright inner highlight).
    for (x, y) in [(4, 4), (1273, 4), (4, 843), (639, 4)] {
        let px = img.get_pixel(x, y).0;
        assert!(px == sea || px == grid, "unexpected pixel at ({x},{y}): {px:?}");
    }
    let left_margin_grid = (0..f.bx.x as u32).any(|x| img.get_pixel(x, 840).0 == grid);
    let right_margin_grid = ((f.bx.x + f.bx.w) as u32..img.width()).any(|x| img.get_pixel(x, 840).0 == grid);
    assert!(left_margin_grid && right_margin_grid, "grid must continue across margins");
}

#[test]
fn regression_farm_fills_standard_pane_without_dark_border() {
    if !assets_dir().join("village.ldtk").exists() {
        return;
    }
    let (world, atlas) = load_village().unwrap();
    let mut scene = FarmScene::new(world, atlas.clone());
    scene.frame = Frame::parse(&fixture("state.json"));
    scene.clock.set_time_of_day(0.50);
    let view = (1278.0, 848.0);
    scene.view_size = view;
    scene.tick(0.1);
    let list = scene.draw(3.0);
    let f = sky::frame_cover(view, (list.width, list.height), sky::FARM_CUT);
    assert_eq!((f.shown.x, f.shown.y, f.shown.w, f.shown.h), (0.0, 0.0, view.0, view.1));
    let img = draw::raster_view(&list, Some(&atlas), view);
    save("farm-wide", &img);
    // Corners are lit grass/river from the village rather than a darkened #1b2318 veil border.
    let dark_bg = [0x1b, 0x23, 0x18];
    for (x, y) in [(2, 2), (1275, 2), (2, 845), (1275, 845)] {
        let p = img.get_pixel(x, y).0;
        let diff: u32 = (0..3).map(|c| p[c].abs_diff(dark_bg[c]) as u32).sum();
        assert!(diff > 40, "dark border pixel at ({x},{y}): {p:?}");
    }
}

#[test]
fn regression_map_uses_the_helpers_outfit_and_the_issues_conflict() {
    let mut state = fixture("state.json");
    let worker = &mut state["state"]["sessions"][0];
    worker["phase"] = serde_json::json!({"_tag":"resting"});
    state["state"]["issues"][0]["stage"] = serde_json::json!({"state":"stuck","stuck":"conflict","acts":[]});
    let (_, atlas) = load_village().unwrap();
    let mut map = farm::islands::MapScene::new(atlas);
    map.apply_frame(Frame::parse(&state));
    map.agent_looks.insert("agent-owl".into(), ("fox".into(), "farmer".into()));
    assert!(
        map.draw(1.5)
            .ops
            .iter()
            .any(|op| matches!(op, draw::Op::Sprite { name, .. } if name == "fox-farmer-worry"))
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
        scene.panel = Some(Panel::Log);
        assert_eq!(hit(&scene, 0.0, 0.0), Some(Action::Block));
        let list = scene.draw(2.0);
        assert!(list.hud_view);
        save(&format!("farm-log-{}", size.0 as u32), &draw::raster_view(&list, Some(&atlas), size));
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
        for key in [
            "web.farm.native.progress",
            "web.farm.native.treeCounts",
            "web.farm.tool.hand.hint",
            "web.farm.native.islandWorking",
            "web.farm.native.islandGone",
            "web.farm.native.islandQueued",
        ] {
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
    scene.panel = Some(farm::hud::Panel::Log);
    let p = farm::hud::Layout::new(&scene).panel;
    assert_eq!(
        farm::hud::hit(&scene, p.x + 20.0, p.y + 50.0),
        Some(farm::hud::Action::Route(format!("/chat/{}", messages[0].channel)))
    );
}

#[test]
fn regression_plot_hover_tracks_the_current_tool_and_offered_action() {
    use farm::{scene::FarmTool, world::VillageHit};
    use vibevalley_i18n::t;
    let (world, atlas) = load_village().unwrap();
    let mut scene = FarmScene::new(world, atlas);
    scene.frame = Frame::parse(&fixture("state.json"));
    scene.hover = Some(VillageHit::Plot(4));
    scene.tool = FarmTool::Harvest;
    let can_harvest = t("web.farm.overlay.click", &[("text", t("web.farm.aim.harvestRipe", &[]).into())]);
    let offered = serde_json::from_value(serde_json::json!({"act":"complete","does":"move","status":"done","words":"none"})).unwrap();
    scene
        .frame
        .state
        .issues
        .iter_mut()
        .find(|i| i.id == "i-105")
        .unwrap()
        .stage
        .as_mut()
        .unwrap()
        .acts
        .push(offered);
    for size in [(568., 720.), (1208., 800.)] {
        scene.view_size = size;
        assert!(
            scene
                .draw(1.)
                .hud
                .iter()
                .any(|item| matches!(item, draw::HudOp::Text{text,..} if text==&can_harvest))
        );
    }
    scene
        .frame
        .state
        .issues
        .iter_mut()
        .find(|i| i.id == "i-105")
        .unwrap()
        .stage
        .as_mut()
        .unwrap()
        .acts
        .clear();
    let unavailable = t("web.farm.aim.unavailable", &[("state", t("shared.stage.reviewing", &[]).to_lowercase().into())]);
    let list = scene.draw(1.);
    assert!(list.hud.iter().any(|item| matches!(item,draw::HudOp::Text{text,..} if text==&unavailable)));
    assert!(!list.hud.iter().any(|item| matches!(item,draw::HudOp::Text{text,..} if text==&can_harvest)));
}

#[test]
fn regression_unread_channel_badge_stays_inside_the_chat_hit_area() {
    use farm::hud::{Action, Layout, hit};
    let (world, atlas) = load_village().unwrap();
    let mut scene = FarmScene::new(world, atlas);
    scene.frame = Frame::parse(&fixture("state.json"));
    for channel in &mut scene.frame.state.chat.channels {
        channel.unread = None;
    }
    let chat = |f: &FarmScene| {
        Layout::new(f)
            .nav
            .into_iter()
            .find(|c| c.action == Action::Route("/chat".into()))
            .unwrap()
            .bounds
    };
    for size in [(568., 720.), (1208., 800.)] {
        scene.view_size = size;
        let plain = chat(&scene);
        scene.frame.state.chat.channels[0].unread = Some(12);
        let with_badge = chat(&scene);
        assert!(with_badge.w > plain.w + 10.);
        assert_eq!(
            hit(&scene, with_badge.x + with_badge.w - 4., with_badge.y + 10.),
            Some(Action::Route("/chat".into()))
        );
        scene.frame.state.chat.channels[0].unread = None;
    }
}
