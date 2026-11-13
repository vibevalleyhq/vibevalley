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
