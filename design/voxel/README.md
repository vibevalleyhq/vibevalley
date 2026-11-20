# Voxel 3D Asset Pipeline

Procedural Blender voxel builders for VibeValley's 3D characters, companions, props, machines, crop plots, farm scene, and floating islands.

## Structure

- `core.py` — `VoxelBuilder` (palette shading, emissive materials, shingled roofs, plank walls, windows, layered trees) and `ClipRecorder` (multi-clip NLA export to glTF 2.0).
- `character_rig.py` — Switchable expressions, four held tools, and ten helper clips, including the hoe stroke and the raised hand used when a question needs an answer.
- `helpers.py` — 7 helper species (`fox`, `cat`, `bear`, `rabbit`, `owl`, `hedgehog`, `raccoon`) × 4 outfits (`farmer`, `gardener`, `rain`, `winter`) = 28 multi-clip `.glb` models.
- `companions.py` — 3 pets (`dog`, `bluecat`, `ragdoll`, 6 clips each) and 6 orchestrator managers (`farmer`, `auntie`, `foreman`, `gardener`, `grandpa`, `robot`, 3 clips each).
- `world_props.py` — 6 yard props, 9 farm machines, and 12 crop plot states.
- `scenes.py` — The village, six floating islands, and foreground foliage. The bake and the app share the [camera specification](assets/village-camera.json). Exporting the village also writes the building silhouettes and ground depths used for picking and occlusion.
- `kaykit.py` — Imports the [vendored KayKit models](design/voxel/kaykit_assets/README.md) and maps their palette cells to the farm's oak, slate, kiln brick, and stone. The four ImageGen albedo tiles in `design/voxel/materials/` are build inputs. Each tile repeats on its own and can be replaced independently. Keep the grain and courses horizontal in the source images. The model UVs orient them along beams, roof slopes, and the kiln circumference.
- `build_all.py` — Unified CLI entrypoint.

## Build

Scene baking uses Blender and a `python3` installation with Pillow for palette reduction and nearest-neighbour enlargement.
The kit geometry and source textures are included in the repository. Rebuilds run offline. The exported scene GLBs embed their textures. The app draws the baked village and island PNGs.

```bash
# Rebuild all 77 models and baked scenes
blender --background --python design/voxel/build_all.py -- assets/models

# Rebuild specific groups only (helpers | companions | props | scenes)
blender --background --python design/voxel/build_all.py -- assets/models --only helpers,scenes
```

Runtime loading and rasterization live in [glb.rs](apps/mac/src/pixel/glb.rs) and [atlas.rs](apps/mac/src/pixel/atlas.rs).
