"""Build all 6 refined yard props, 9 farm machines (with emissive lantern & animated parts),
and 12 crop plots using the shared VoxelBuilder core.

Usage:
    blender --background --python design/voxel/world_props.py -- assets/models
"""
from math import cos, degrees, radians, sin, tau
from pathlib import Path
import sys

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from core import VoxelBuilder, export_glb, reset_scene

WOOD_PAL = {
    "wood": "b87a3d", "wood-dark": "804f22", "wood-light": "d99e5b",
    "paper": "f5e3b8", "paper-ink": "637345", "iron": "5a5d63", "iron-dark": "393c42",
    "red": "cc4429", "cream": "f7e5be", "green": "4e873b", "green-hi": "76b34d",
    "orange": "eb7528", "tomato": "d94029", "white": "f5efe4",
    "blue": "4878ab", "blue-hi": "7eadde", "gold": "f7c64d", "glow": "ffe680",
    "sack": "dbc08c", "sack-dark": "ad8c5a", "soil": "6e472b", "soil-dark": "472b19",
    "soil-dry": "a17950", "water": "4ca8f5", "water-hi": "a3dbff",
    "whale": "3d6ef0", "whale-belly": "f7ebd0", "pump": "4b8ab0", "yellow": "f2bd38",
    "bee": "f7c234", "bee-dark": "3b2820", "wing": "fff6d6",
    "wheat": "ebbf46", "flower": "f5768f", "flower-c": "ffe366", "weed": "5c803b",
}


def build_props(out_dir):
    # 1. prop-board: roofed wooden notice board with shingled roof & pinned notes
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("prop-board", (0, 0, 0))
    for sx in (-0.82, 0.82):
        vb.box(root, "Post", "wood", (sx, 0, 0.78), (0.18, 0.18, 1.56))
        vb.box(root, "Base", "wood-dark", (sx, 0, 0.08), (0.28, 0.28, 0.16))
        vb.box(root, "Finial", "wood-light", (sx, 0, 1.64), (0.16, 0.16, 0.18))
        vb.box(root, "Bolt", "iron", (sx, -0.10, 0.34), (0.08, 0.04, 0.08))
    vb.box(root, "Backing", "wood-dark", (0, 0.02, 0.82), (1.50, 0.10, 0.90))
    vb.box(root, "Rail", "wood", (0, 0, 0.34), (1.62, 0.14, 0.13))
    vb.tiled_roof(root, "RoofF", "wood-light", (0, -0.17, 1.40), 1.94, 0.52, 24, cols=6, rows=2, flip_y=False, thickness=0.09)
    vb.tiled_roof(root, "RoofB", "wood", (0, 0.17, 1.40), 1.94, 0.52, 24, cols=6, rows=2, flip_y=True, thickness=0.09)
    vb.box(root, "Ridge", "wood-dark", (0, 0, 1.54), (1.96, 0.16, 0.10))
    vb.box(root, "Map", "paper", (0, -0.05, 0.84), (0.64, 0.03, 0.56))
    vb.box(root, "MapInk", "paper-ink", (0.04, -0.07, 0.86), (0.36, 0.02, 0.28))
    for nx, nz in ((-0.52, 0.98), (-0.52, 0.64), (0.52, 0.98), (0.52, 0.64)):
        vb.box(root, "Note", "paper", (nx, -0.05, nz), (0.26, 0.03, 0.28))
        vb.box(root, "Pin", "red", (nx, -0.075, nz + 0.10), (0.06, 0.04, 0.06))
    export_glb(out_dir / "prop-board.glb", multi_clip=False)

    # 2. prop-crates: slatted wooden crates, iron-hooped barrel, grain sacks
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("prop-crates", (0, 0, 0))
    def crate(cx, cy, cz, sz):
        vb.box(root, "Crate", "wood", (cx, cy, cz + sz * 0.5), (sz, sz, sz))
        vb.box(root, "Inset", "wood-dark", (cx, cy - sz * 0.48, cz + sz * 0.5), (sz * 0.72, 0.06, sz * 0.72))
        vb.box(root, "Brace", "wood-light", (cx, cy - sz * 0.50, cz + sz * 0.5), (sz * 0.78, 0.06, 0.10), rot_deg=(0, 42, 0))
        for rx in (-0.36, 0.36):
            for rz in (-0.36, 0.36):
                vb.box(root, "Nail", "iron", (cx + rx * sz, cy - sz * 0.51, cz + (0.5 + rz) * sz), (0.06, 0.04, 0.06))
    crate(-0.48, -0.08, 0.0, 0.68)
    crate(0.06, 0.22, 0.0, 0.82)
    vb.box(root, "Barrel", "wood", (0.64, -0.10, 0.38), (0.54, 0.54, 0.76))
    vb.box(root, "BarrelLip", "wood-dark", (0.64, -0.10, 0.75), (0.44, 0.44, 0.06))
    for hz in (0.20, 0.56):
        vb.box(root, "Hoop", "iron", (0.64, -0.10, hz), (0.59, 0.59, 0.09))
    for sx, sy in ((-0.26, -0.46), (0.14, -0.44)):
        vb.box(root, "Sack", "sack", (sx, sy, 0.24), (0.34, 0.30, 0.44))
        vb.box(root, "Tie", "wood-dark", (sx, sy, 0.48), (0.16, 0.16, 0.07))
        vb.box(root, "Top", "sack-dark", (sx, sy, 0.55), (0.22, 0.20, 0.10))
    export_glb(out_dir / "prop-crates.glb", multi_clip=False)

    # 3. prop-mailbox
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("prop-mailbox", (0, 0, 0))
    vb.box(root, "Post", "wood", (0, 0, 0.52), (0.22, 0.22, 1.04))
    vb.box(root, "Brace", "wood-dark", (-0.14, 0, 0.88), (0.22, 0.16, 0.22), rot_deg=(0, 45, 0))
    vb.box(root, "Box", "wood-light", (-0.04, 0, 1.18), (0.68, 0.42, 0.38))
    vb.box(root, "Arch", "wood", (-0.04, 0, 1.40), (0.66, 0.34, 0.12))
    vb.box(root, "Door", "iron", (-0.39, 0, 1.18), (0.05, 0.38, 0.36))
    vb.box(root, "Latch", "gold", (-0.42, 0, 1.24), (0.05, 0.10, 0.06))
    flag = vb.pivot("Flag", (0.16, -0.23, 1.22), root)
    vb.box(flag, "Stem", "red", (0, 0, 0.16), (0.06, 0.04, 0.32))
    vb.box(flag, "Pennant", "red", (0.08, 0, 0.28), (0.18, 0.04, 0.12))
    export_glb(out_dir / "prop-mailbox.glb", multi_clip=False)

    # 4. prop-signpost
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("prop-signpost", (0, 0, 0))
    vb.box(root, "Post", "wood", (0, 0, 0.82), (0.18, 0.18, 1.64))
    vb.box(root, "Base", "wood-dark", (0, 0, 0.12), (0.28, 0.28, 0.24))
    for bz, side in ((1.36, -1), (1.02, 1), (0.68, -1)):
        vb.box(root, "Sign", "wood-light", (side * 0.28, -0.02, bz), (0.76, 0.08, 0.22))
        vb.box(root, "Tip", "wood", (side * 0.68, -0.02, bz), (0.14, 0.07, 0.14), rot_deg=(0, 45, 0))
        vb.box(root, "Nail", "iron", (0, -0.07, bz), (0.06, 0.03, 0.06))
    export_glb(out_dir / "prop-signpost.glb", multi_clip=False)

    # 5. prop-stall (with emissive lantern!)
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL, emissive_keys=("glow",))
    root = vb.pivot("prop-stall", (0, 0, 0))
    vb.plank_wall(root, "Counter", "wood", (0, 0, 0.34), 1.72, 0.82, 0.68, planks=4, trim_color="wood-dark")
    vb.box(root, "Top", "wood-light", (0, -0.04, 0.70), (1.84, 0.92, 0.10))
    for sx in (-0.78, 0.78):
        for sy in (-0.34, 0.34):
            vb.box(root, "Pillar", "wood-dark", (sx, sy, 1.18), (0.14, 0.14, 1.00))
    for i in range(7):
        col = "red" if i % 2 == 0 else "cream"
        ax = -0.84 + i * 0.28
        vb.box(root, "Awning", col, (ax, -0.04, 1.72), (0.28, 1.12, 0.10), rot_deg=(22, 0, 0))
        vb.box(root, "Valance", col, (ax, -0.54, 1.48), (0.28, 0.08, 0.18))
    vb.box(root, "Lantern arm", "wood-dark", (-0.96, -0.34, 1.46), (0.28, 0.10, 0.10))
    vb.box(root, "Lantern cap", "iron-dark", (-1.04, -0.34, 1.32), (0.18, 0.18, 0.08))
    vb.box(root, "Lantern glow", "glow", (-1.04, -0.34, 1.18), (0.16, 0.16, 0.20))
    for bx, vcol, leaf in ((-0.60, "green-hi", False), (-0.20, "tomato", False), (0.20, "orange", True), (0.60, "white", True)):
        vb.box(root, "Bin", "wood-dark", (bx, 0.06, 0.84), (0.34, 0.38, 0.18))
        vb.box(root, "Veggies", vcol, (bx, 0.06, 0.98), (0.28, 0.30, 0.16))
        if leaf:
            vb.box(root, "Leaves", "green", (bx, 0.08, 1.10), (0.26, 0.22, 0.12))
    export_glb(out_dir / "prop-stall.glb", multi_clip=False)

    # 6. prop-table
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("prop-table", (0, 0, 0))
    for sx in (-0.64, 0.64):
        for sy, lh in ((-0.36, 0.68), (0.36, 0.96)):
            vb.box(root, "Leg", "wood-dark", (sx, sy, lh * 0.5), (0.14, 0.14, lh))
        vb.box(root, "Strut", "wood", (sx, 0, 0.26), (0.10, 0.72, 0.10))
    top = vb.pivot("Top", (0, 0, 0.84), root, rot_deg=(22, 0, 0))
    vb.box(top, "Board", "wood-light", (0, 0, 0), (1.54, 1.02, 0.10))
    vb.box(top, "Blueprint", "blue", (-0.06, 0.02, 0.06), (1.06, 0.74, 0.03))
    vb.box(top, "Lines", "blue-hi", (-0.06, 0.02, 0.08), (0.72, 0.44, 0.015))
    for wx, wy in ((-0.54, 0.32), (0.40, 0.32), (-0.54, -0.28)):
        vb.box(top, "Weight", "iron", (wx, wy, 0.10), (0.14, 0.14, 0.08))
    vb.box(top, "Pencil", "gold", (0.04, -0.26, 0.09), (0.34, 0.06, 0.06), rot_deg=(0, 0, 18))
    vb.box(top, "Scroll", "paper", (0.58, 0.0, 0.10), (0.16, 0.66, 0.14))
    export_glb(out_dir / "prop-table.glb", multi_clip=False)


def build_machines(out_dir):
    # 1. machine-tractor
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL, emissive_keys=("glow",))
    root = vb.pivot("machine-tractor", (0, 0, 0))
    vb.box(root, "Chassis", "iron-dark", (0, 0.06, 0.44), (0.78, 1.24, 0.24))
    vb.box(root, "Hood", "orange", (0, -0.28, 0.76), (0.68, 0.74, 0.50))
    vb.box(root, "Grille", "cream", (0, -0.66, 0.74), (0.48, 0.06, 0.40))
    for sx in (-0.34, 0.34):
        vb.box(root, "Headlight", "glow", (sx, -0.66, 0.80), (0.14, 0.08, 0.14))
    vb.box(root, "Stack", "iron", (0.14, -0.36, 1.22), (0.16, 0.16, 0.48))
    vb.box(root, "Seat", "wood-dark", (0, 0.44, 0.94), (0.44, 0.38, 0.34))
    vb.box(root, "Wheel steer", "iron-dark", (0, 0.14, 1.02), (0.34, 0.08, 0.34), rot_deg=(52, 0, 0))
    for sx in (-0.48, 0.48):
        vb.box(root, "Front wheel", "iron-dark", (sx, -0.44, 0.28), (0.22, 0.52, 0.52))
        vb.box(root, "Front hub", "gold", (sx * 1.04, -0.44, 0.28), (0.20, 0.24, 0.24))
        vb.box(root, "Rear wheel", "iron-dark", (sx * 1.12, 0.42, 0.44), (0.32, 0.86, 0.86))
        vb.box(root, "Rear hub", "gold", (sx * 1.16, 0.42, 0.44), (0.30, 0.42, 0.42))
        vb.box(root, "Fender", "orange", (sx * 1.08, 0.42, 0.92), (0.36, 0.76, 0.12))
    export_glb(out_dir / "machine-tractor.glb", multi_clip=False)

    # 2. machine-windmill
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("machine-windmill", (0, 0, 0))
    for sx in (-0.34, 0.34):
        for sy in (-0.34, 0.34):
            vb.box(root, "Leg", "wood", (sx * 0.75, sy * 0.75, 0.62), (0.12, 0.12, 1.28), rot_deg=(sy * 28, -sx * 28, 0))
    vb.box(root, "Top cap", "wood-light", (0, 0, 1.26), (0.56, 0.56, 0.12))
    vb.box(root, "Tail fin", "wood", (0.52, 0.10, 1.54), (0.52, 0.08, 0.42))
    vb.box(root, "Barrel", "wood-light", (0.52, -0.18, 0.34), (0.56, 0.56, 0.68))
    for hz in (0.20, 0.48):
        vb.box(root, "Hoop", "iron", (0.52, -0.18, hz), (0.60, 0.60, 0.08))
    hub = vb.pivot("Blades", (-0.18, -0.30, 1.54), root)
    vb.box(hub, "Hub", "wood-dark", (0, 0, 0), (0.22, 0.18, 0.22))
    for k in range(8):
        blade = vb.pivot(f"Blade_{k}", (0, 0, 0), hub, rot_deg=(0, k * 45, 0))
        vb.box(blade, "Sail", "cream", (0, -0.02, 0.38), (0.16, 0.04, 0.44))
    scene.render.fps = 24
    scene.frame_start, scene.frame_end = 1, 49
    for f, deg in ((1, 0), (13, 90), (25, 180), (37, 270), (49, 360)):
        hub.rotation_euler.y = radians(deg)
        hub.keyframe_insert(data_path="rotation_euler", frame=f)
    scene.frame_set(1)
    export_glb(out_dir / "machine-windmill.glb", multi_clip=False)

    # 3. machine-lantern (emissive glow!)
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL, emissive_keys=("glow",))
    root = vb.pivot("machine-lantern", (0, 0, 0))
    vb.box(root, "Cart bed", "wood", (0, 0, 0.48), (0.86, 0.96, 0.42))
    vb.box(root, "Cart hollow", "wood-dark", (0, 0, 0.56), (0.68, 0.78, 0.30))
    vb.box(root, "Tongue", "wood-light", (-0.22, -0.74, 0.28), (0.16, 0.60, 0.14))
    for sx in (-0.48, 0.48):
        vb.box(root, "Wheel", "iron-dark", (sx, 0.08, 0.34), (0.16, 0.66, 0.66))
        vb.box(root, "Hub", "wood-light", (sx * 1.04, 0.08, 0.34), (0.14, 0.42, 0.42))
    vb.box(root, "Mast", "wood", (0.16, 0.30, 1.06), (0.16, 0.16, 1.18))
    vb.box(root, "Arm", "wood-light", (0.16, 0.04, 1.58), (0.14, 0.62, 0.14))
    lan = vb.pivot("Lantern", (0.16, -0.22, 1.50), root)
    vb.box(lan, "Cap", "iron-dark", (0, 0, -0.14), (0.34, 0.34, 0.12))
    vb.box(lan, "Glass", "glow", (0, 0, -0.34), (0.28, 0.28, 0.30))
    vb.box(lan, "Bottom", "iron-dark", (0, 0, -0.52), (0.32, 0.32, 0.10))
    scene.render.fps = 24
    scene.frame_start, scene.frame_end = 1, 25
    for f in (1, 7, 13, 19, 25):
        lan.rotation_euler.x = radians(7) * sin((f - 1) / 24.0 * tau)
        lan.keyframe_insert(data_path="rotation_euler", frame=f)
    scene.frame_set(1)
    export_glb(out_dir / "machine-lantern.glb", multi_clip=False)

    # 4. machine-beehive
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("machine-beehive", (0, 0, 0))
    vb.box(root, "Stand", "wood", (0, 0, 0.26), (0.94, 0.94, 0.14))
    for sx in (-0.36, 0.36):
        for sy in (-0.36, 0.36):
            vb.box(root, "Foot", "wood-dark", (sx, sy, 0.10), (0.18, 0.18, 0.20))
    vb.plank_wall(root, "Hive", "cream", (0, 0, 0.72), 0.76, 0.76, 0.80, planks=4)
    vb.box(root, "Slot", "wood-dark", (0, -0.39, 0.44), (0.28, 0.06, 0.09))
    vb.box(root, "Roof l", "sack-dark", (-0.24, 0, 1.24), (0.62, 0.94, 0.10), rot_deg=(0, -32, 0))
    vb.box(root, "Roof r", "sack-dark", (0.24, 0, 1.24), (0.62, 0.94, 0.10), rot_deg=(0, 32, 0))
    bees = vb.pivot("Bees", (0, 0, 0.86), root)
    for bx, by, bz in ((-0.70, -0.15, 0.10), (0.72, 0.10, -0.06)):
        vb.box(bees, "Bee", "bee", (bx, by, bz), (0.18, 0.14, 0.14))
        vb.box(bees, "Stripe", "bee-dark", (bx, by, bz), (0.06, 0.15, 0.15))
        vb.box(bees, "Wing", "wing", (bx, by, bz + 0.10), (0.14, 0.18, 0.04))
    scene.render.fps = 24
    scene.frame_start, scene.frame_end = 1, 25
    for f in (1, 7, 13, 19, 25):
        ph = (f - 1) / 24.0 * tau
        bees.location.z = 0.86 + 0.08 * sin(ph)
        bees.rotation_euler.z = radians(12) * sin(ph)
        bees.keyframe_insert(data_path="location", frame=f)
        bees.keyframe_insert(data_path="rotation_euler", frame=f)
    scene.frame_set(1)
    export_glb(out_dir / "machine-beehive.glb", multi_clip=False)

    # 5. machine-dsh (DeepSeek blue whale cart)
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("machine-dsh", (0, 0, 0))
    vb.box(root, "Cart", "wood", (0, 0, 0.40), (0.86, 1.12, 0.24))
    vb.box(root, "Tongue", "wood-light", (0, -0.82, 0.28), (0.16, 0.56, 0.14))
    for sx in (-0.48, 0.48):
        vb.box(root, "Wheel", "iron-dark", (sx, 0.12, 0.34), (0.18, 0.64, 0.64))
        vb.box(root, "Hub", "wood-light", (sx * 1.04, 0.12, 0.34), (0.16, 0.40, 0.40))
    vb.box(root, "Whale", "whale", (0, 0.04, 0.88), (0.82, 1.06, 0.72))
    vb.box(root, "Belly", "whale-belly", (0, -0.18, 0.66), (0.76, 0.64, 0.30))
    vb.box(root, "EyeL", "iron-dark", (-0.42, -0.22, 0.92), (0.04, 0.12, 0.12))
    vb.box(root, "EyeR", "iron-dark", (0.42, -0.22, 0.92), (0.04, 0.12, 0.12))
    vb.box(root, "Tail stem", "whale", (0, 0.68, 1.06), (0.28, 0.30, 0.34))
    vb.box(root, "Fluke", "whale", (0, 0.78, 1.28), (0.68, 0.18, 0.24))
    vb.box(root, "Spout", "water-hi", (0, -0.10, 1.44), (0.22, 0.22, 0.38))
    vb.box(root, "Splash", "water", (0, -0.10, 1.66), (0.46, 0.34, 0.16))
    vb.box(root, "Tap", "gold", (0, -0.58, 0.74), (0.14, 0.20, 0.22))
    export_glb(out_dir / "machine-dsh.glb", multi_clip=False)

    # 6. machine-pump
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("machine-pump", (0, 0, 0))
    vb.box(root, "Deck", "wood-light", (0, 0, 0.16), (0.96, 0.96, 0.18))
    vb.box(root, "Base", "pump", (0, 0, 0.32), (0.50, 0.50, 0.14))
    vb.box(root, "Body", "pump", (0, 0, 0.78), (0.34, 0.34, 0.80))
    vb.box(root, "Cap", "pump", (0, 0, 1.24), (0.42, 0.42, 0.14))
    vb.box(root, "Spout", "pump", (-0.32, 0, 0.96), (0.42, 0.18, 0.18))
    vb.box(root, "Nozzle", "gold", (-0.48, 0, 0.84), (0.18, 0.18, 0.14))
    vb.box(root, "Handle", "pump", (0.34, 0, 1.02), (0.14, 0.12, 0.76), rot_deg=(0, -28, 0))
    export_glb(out_dir / "machine-pump.glb", multi_clip=False)

    # 7. machine-seeder
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("machine-seeder", (0, 0, 0))
    vb.box(root, "Hopper", "yellow", (0, -0.06, 0.68), (0.58, 0.54, 0.48))
    vb.box(root, "Seeds", "wood-dark", (0, -0.06, 0.90), (0.46, 0.42, 0.10))
    for sx in (-0.40, 0.40):
        vb.box(root, "Wheel", "iron-dark", (sx, -0.06, 0.32), (0.16, 0.62, 0.62))
        vb.box(root, "Hub", "wood-light", (sx * 1.04, -0.06, 0.32), (0.14, 0.38, 0.38))
        vb.box(root, "Handle", "yellow", (sx * 0.72, 0.48, 1.04), (0.12, 0.12, 0.96), rot_deg=(-36, 0, 0))
    export_glb(out_dir / "machine-seeder.glb", multi_clip=False)

    # 8. machine-watercart
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("machine-watercart", (0, 0, 0))
    vb.box(root, "Frame", "green", (0, 0, 0.42), (0.86, 1.08, 0.20))
    vb.box(root, "Tongue", "green", (0, -0.80, 0.30), (0.16, 0.56, 0.14))
    vb.box(root, "Tank", "wood-light", (0, 0.04, 0.84), (0.76, 0.96, 0.68))
    for by in (-0.30, 0.04, 0.38):
        vb.box(root, "Band", "iron", (0, by, 0.84), (0.80, 0.10, 0.72))
    vb.box(root, "Spigot", "gold", (0, -0.52, 0.66), (0.14, 0.18, 0.22))
    for sx in (-0.48, 0.48):
        vb.box(root, "Wheel", "iron-dark", (sx, 0.12, 0.34), (0.18, 0.64, 0.64))
        vb.box(root, "Hub", "gold", (sx * 1.04, 0.12, 0.34), (0.16, 0.36, 0.36))
    export_glb(out_dir / "machine-watercart.glb", multi_clip=False)

    # 9. machine-wheelbarrow
    scene = reset_scene()
    vb = VoxelBuilder(scene, WOOD_PAL)
    root = vb.pivot("machine-wheelbarrow", (0, 0, 0))
    vb.box(root, "Tub", "wood-light", (0, -0.02, 0.58), (0.76, 0.88, 0.40))
    vb.box(root, "Dirt", "soil", (0, -0.02, 0.78), (0.64, 0.74, 0.18))
    vb.box(root, "Wheel", "iron-dark", (0, -0.62, 0.26), (0.18, 0.50, 0.50))
    for sx in (-0.30, 0.30):
        vb.box(root, "Handle", "wood", (sx, 0.56, 0.72), (0.12, 0.74, 0.12), rot_deg=(24, 0, 0))
        vb.box(root, "Leg", "wood-dark", (sx, 0.22, 0.22), (0.12, 0.12, 0.44))
    export_glb(out_dir / "machine-wheelbarrow.glb", multi_clip=False)


PLOT_PALETTE = {
    **WOOD_PAL,
    "earth": "a86b40",
    "loam": "8b5839",
    "clod": "b38050",
    "silt": "c29866",
    "crack": "7e583c",
    "shoot": "91ba52",
    "leaf": "527e45",
    "leaf-lit": "84a64d",
    "leaf-deep": "3c633e",
    "straw": "d99d41",
    "grain": "e5b650",
    "awn": "ffe08c",
    "carrot": "e27832",
    "carrot-lit": "f69b50",
    "stubble": "c3a067",
    "vine": "75553f",
    "petal": "f3dbb1",
    "rose": "d88a82",
}


def plot_mesh(vb, root, name, vertices, faces, color):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(vb.mat(color))
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    vb.scene.collection.objects.link(obj)
    obj.parent = root
    return obj


def soil_layer(vb, root, outline, z0, z1, color):
    n = len(outline)
    verts = [(x, y, z) for z in (z0, z1) for x, y in outline]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    faces.extend([tuple(reversed(range(n))), tuple(range(n, 2 * n))])
    plot_mesh(vb, root, "Soil", verts, faces, color)


def blade(vb, root, base, angle, reach, rise, width, color):
    # A raised midrib stays visible under both the island and farm cameras.
    shape = (
        (0, 0, 0),
        (0.42, -0.50, 0.46),
        (0.66, -0.39, 0.76),
        (1, 0, 1),
        (0.66, 0.39, 0.76),
        (0.42, 0.50, 0.46),
        (0.54, 0, 0.76),
    )
    c, s = cos(angle), sin(angle)
    x, y, z = base
    vertices = [
        (
            x + along * reach * c - side * width * s,
            y + along * reach * s + side * width * c,
            z + along_z * rise + (0.035 if i == 6 else 0),
        )
        for i, (along, side, along_z) in enumerate(shape)
    ]
    faces = [(i, (i + 1) % 6, 6) for i in range(6)]
    faces.append(tuple(reversed(range(6))))
    plot_mesh(vb, root, "Blade", vertices, faces, color)


def sowing_bed(vb, root, stage):
    outline = [
        (-0.89, -0.55),
        (-0.80, -0.55),
        (-0.80, -0.65),
        (-0.32, -0.65),
        (-0.32, -0.63),
        (0.54, -0.63),
        (0.54, -0.67),
        (0.78, -0.67),
        (0.78, -0.58),
        (0.88, -0.58),
        (0.88, 0.34),
        (0.85, 0.34),
        (0.85, 0.57),
        (0.75, 0.57),
        (0.75, 0.65),
        (0.18, 0.65),
        (0.18, 0.63),
        (-0.61, 0.63),
        (-0.61, 0.67),
        (-0.83, 0.67),
        (-0.83, 0.56),
        (-0.89, 0.56),
    ]
    dry = stage in ("dry", "withered")
    soil_layer(vb, root, outline, 0.005, 0.048, "clod")
    soil_layer(vb, root, [(x * 0.965, y * 0.955) for x, y in outline], 0.048, 0.079, "silt" if dry else "earth")
    for row, y in enumerate((-0.43, 0, 0.42)):
        offset = 0.055 * (row - 1)
        ridge = [
            (-0.78 + offset, y - 0.045),
            (-0.64, y - 0.085),
            (-0.19, y - 0.074),
            (0.23, y - 0.103),
            (0.68 - offset, y - 0.078),
            (0.76, y + 0.02),
            (0.50, y + 0.082),
            (0.06, y + 0.064),
            (-0.56, y + 0.092),
            (-0.73 + offset, y + 0.063),
        ]
        soil_layer(vb, root, ridge, 0.079, 0.096, "clod" if dry else "loam")
    for x, y in ((-0.72, -0.53), (-0.62, 0.55), (-0.12, -0.26), (0.12, 0.20), (0.69, 0.47), (0.73, -0.35)):
        vb.box(root, "Earth clod", "clod", (x, y, 0.090), (0.11, 0.066, 0.031), rot_deg=(0, 0, x * 18))
    if dry:
        for x, y, turn in ((-0.55, -0.25, 29), (0.09, 0.21, -34), (0.48, -0.29, 53), (-0.26, 0.43, 21)):
            vb.box(root, "Fissure", "crack", (x, y, 0.099), (0.32, 0.042, 0.014), rot_deg=(0, 0, turn))
            vb.box(
                root,
                "Fissure fork",
                "crack",
                (x + 0.082, y - 0.035, 0.101),
                (0.14, 0.032, 0.014),
                rot_deg=(0, 0, -55),
            )


def grow_plant(vb, root, stage, x, y, turn, size):
    floor = 0.094
    if stage == "seeded":
        vb.box(
            root, "Seed husk", "sack", (x, y, floor + 0.025), (0.12, 0.075, 0.055), rot_deg=(0, 0, degrees(turn))
        )
        return
    if stage == "wheat":
        for side, height in ((-1, 0.39), (1, 0.52)):
            sx, sy = x + side * 0.105, y + side * 0.045
            stem_top = floor + height * size
            vb.box(root, "Straw", "straw", (sx, sy, (floor + stem_top) / 2), (0.068, 0.059, stem_top - floor))
            blade(vb, root, (sx, sy, floor + 0.12), turn + side * 1.3, 0.23, 0.18, 0.115, "straw")
            for level in range(3):
                sx += 0.025 * side
                z = stem_top + level * 0.088 * size
                vb.box(root, "Grain", "grain", (sx, sy, z), (0.12, 0.106, 0.13), rot_deg=(0, side * 24, 0))
                blade(vb, root, (sx, sy, z), 0.25 + level * 2.6, 0.13, 0.135, 0.104, "awn")
            blade(vb, root, (sx, sy, z + 0.035), turn, 0.095, 0.16, 0.060, "awn")
        return
    if stage == "withered":
        vb.box(root, "Bent stem", "vine", (x, y, 0.24), (0.078, 0.070, 0.33), rot_deg=(0, 21, 0))
        for side in (-1, 1):
            blade(
                vb,
                root,
                (x + 0.060, y, 0.39),
                turn + side * 1.35,
                0.29,
                -0.20,
                0.17,
                "vine" if side < 0 else "stubble",
            )
        return
    if stage == "carrot":
        vb.box(root, "Carrot shoulder", "carrot", (x, y, 0.164), (0.22, 0.19, 0.15), rot_deg=(0, 0, degrees(turn)))
        vb.box(root, "Carrot crown", "carrot-lit", (x, y, 0.244), (0.15, 0.13, 0.06), rot_deg=(0, 0, degrees(turn)))
    origin = (x, y, 0.263 if stage == "carrot" else floor)
    leaves = {"sprout": 2, "leafy": 5, "flowering": 5, "carrot": 4, "weeds": 3}[stage]
    reach, rise, width = {
        "sprout": (0.16, 0.17, 0.105),
        "leafy": (0.29, 0.31, 0.19),
        "flowering": (0.27, 0.27, 0.16),
        "carrot": (0.17, 0.35, 0.105),
        "weeds": (0.24, 0.46, 0.085),
    }[stage]
    for k in range(leaves):
        angle = turn + tau * k / leaves
        tone = ("leaf-lit", "leaf-deep", "leaf", "shoot", "leaf")[k]
        blade(vb, root, origin, angle, reach * size, (rise + 0.045 * (k % 2)) * size, width * size, tone)
    if stage == "flowering":
        z = floor + 0.39 * size
        vb.box(root, "Flower stem", "leaf", (x, y, (floor + z) / 2), (0.047, 0.047, z - floor))
        for k in range(5):
            blade(vb, root, (x, y, z), turn + tau * k / 5, 0.125, 0.036, 0.109, "rose" if size < 0.98 else "petal")
        vb.box(root, "Pollen", "gold", (x, y, z + 0.036), (0.088, 0.088, 0.068))


def build_plots(out_dir):
    for stage in (
        "empty",
        "locked",
        "dry",
        "seeded",
        "sprout",
        "leafy",
        "flowering",
        "carrot",
        "wheat",
        "harvested",
        "weeds",
        "withered",
    ):
        scene = reset_scene()
        vb = VoxelBuilder(scene, PLOT_PALETTE)
        root = vb.pivot(f"plot-{stage}")
        root.scale.y = 1.16
        sowing_bed(vb, root, stage)
        if stage == "locked":
            for x in (-0.28, 0.28):
                vb.box(root, "Stake", "wood-dark", (x, 0.12, 0.28), (0.075, 0.09, 0.43))
            vb.box(root, "Gate bar", "wood", (0, 0.12, 0.41), (0.70, 0.085, 0.105))
            vb.box(root, "Lock", "iron-dark", (0.06, 0.057, 0.34), (0.18, 0.07, 0.18))
            vb.box(root, "Keyhole", "gold", (0.06, 0.017, 0.36), (0.038, 0.018, 0.061))
        elif stage == "harvested":
            for row, y in enumerate((-0.39, 0, 0.38)):
                for x in (-0.52, -0.20, 0.14, 0.46):
                    vb.box(
                        root,
                        "Cut stalk",
                        "stubble",
                        (x, y, 0.15),
                        (0.048, 0.048, 0.13),
                        rot_deg=(0, (-1) ** row * 14, 0),
                    )
            vb.box(root, "Sheaf", "grain", (0.27, 0.16, 0.23), (0.58, 0.21, 0.21), rot_deg=(0, 0, -16))
            vb.box(root, "Twine", "vine", (0.27, 0.16, 0.23), (0.072, 0.22, 0.22), rot_deg=(0, 0, -16))
        elif stage not in ("empty", "dry"):
            for col, x in enumerate((-0.53, 0, 0.51)):
                for row, y in enumerate((-0.39, 0.0, 0.40)):
                    if stage == "withered" and (col + row) % 2:
                        continue
                    grow_plant(
                        vb,
                        root,
                        stage,
                        x + 0.03 * (row - 1),
                        y + 0.027 * (col - 1),
                        0.29 + col * 0.81 + row * 1.98,
                        0.9 + ((col + 2 * row) % 3) * 0.09,
                    )
        parts = list(root.children)
        bpy.ops.object.select_all(action="DESELECT")
        for part in parts:
            part.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]
        bpy.ops.object.join()
        export_glb(out_dir / f"plot-{stage}.glb", multi_clip=False)


if __name__ == "__main__":
    out_dir = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
    build_props(out_dir)
    build_machines(out_dir)
    build_plots(out_dir)
    print(f"Exported 27 refined props/machines/plots to {out_dir}")
