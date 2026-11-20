"""Build refined 3D voxel farm scene (`map`), 6 sculpted floating islands (`island-*`),
and 6 layered foreground foliage props (`fg-*`).

Usage:
    blender --background --python design/voxel/scenes.py -- assets
"""

import json
import math
from pathlib import Path
import random
import subprocess
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from core import VoxelBuilder, export_glb, reset_scene
from kaykit import prop, texture_objects

SCENE_PAL = {
    "grass": "729554",
    "grass-hi": "97af62",
    "grass-lo": "456d40",
    "meadow-shade": "5a7b4c",
    "pine-shadow": "304e44",
    "porch-shade": "594735",
    "ridge-low": "557f66",
    "ridge-far": "72927b",
    "grass-moss": "75924c",
    "grass-shade": "648746",
    "grass-tip": "91a753",
    "dirt-grain": "ba9769",
    "dirt-lit": "d2b487",
    "ink": "313b3a",
    "charcoal": "342e2c",
    "ember": "ffbd4f",
    "brick": "934c39",
    "brick-hi": "b66d4d",
    "iron-dark": "3a4246",
    "dirt": "c7a97c",
    "dirt-edge": "b39568",
    "dirt-lo": "a58560",
    "pebble": "a8a090",
    "cliff": "757063",
    "cliff-hi": "948e7e",
    "cliff-lo": "545047",
    "pine": "3b6639",
    "pine-hi": "528547",
    "pine-lo": "2a4a2a",
    "leaf": "58913d",
    "leaf-hi": "7bb54e",
    "leaf-lo": "3b662a",
    "trunk": "784e2d",
    "wood": "b57a40",
    "wood-hi": "d4995b",
    "wood-lo": "754922",
    "wall": "ebd09b",
    "wall-lo": "cfa96f",
    "roof-orange": "c4632f",
    "roof-orange-hi": "db7b42",
    "roof-teal": "32828a",
    "roof-teal-hi": "479ea6",
    "roof-teal-lo": "235e66",
    "roof-rust": "786a61",
    "roof-rust-hi": "a35a38",
    "door-teal": "3b8a8c",
    "win-glow": "ffe07d",
    "win-frame": "5e3b20",
    "forge": "e86b29",
    "beacon": "ff4538",
    "stone": "9c978d",
    "stone-lo": "737067",
    "iron": "575a61",
    "iron-hi": "888c96",
    "water": "477f81",
    "water-hi": "679c9a",
    "water-deep": "3a6a73",
    "lily": "5a943e",
    "lotus": "f58ca8",
    "reed": "6b8c3b",
    "flower-y": "f5d24c",
    "flower-w": "ded8b9",
    "flower-p": "e07aa8",
    "lavender": "8d6bc4",
    "lavender-hi": "ad8fe6",
    "apple": "d94132",
    "cloth-r": "d95b43",
    "cloth-b": "5282ad",
    "cloth-y": "f0c54d",
    "sail": "f7eedb",
    "earth": "8a5e3c",
    "earth-lo": "634026",
}


class Scenery(VoxelBuilder):
    """Static parts sharing a material instance the same unit cube in the GLB."""

    def __init__(self, scene, palette, emissive_keys=()):
        super().__init__(scene, palette, emissive_keys)
        self.unit_meshes = {}

    def box(self, parent, name, color, pos, size, rot_deg=None, shade=0.0):
        material = self.mat(color, shade)
        mesh = self.unit_meshes.get(material)
        if mesh is None:
            mesh = bpy.data.meshes.new(material.name)
            corners = [
                (x * 0.5, y * 0.5, z * 0.5)
                for x, y, z in ((-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1), (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1))
            ]
            faces = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
            mesh.from_pydata(corners, [], faces)
            mesh.materials.append(material)
            self.unit_meshes[material] = mesh
        ob = bpy.data.objects.new(name, mesh)
        self.scene.collection.objects.link(ob)
        ob.parent = parent
        ob.location = pos
        ob.scale = size
        if rot_deg is not None:
            ob.rotation_euler = tuple(math.radians(v) for v in rot_deg)
        return ob


def bake_pixels(scene):
    bpy.ops.render.render(write_still=True)
    subprocess.run(["python3", str(Path(__file__).with_name("pixel_bake.py")), scene.render.filepath], check=True)


def setup_ortho_render(scene, width, height, cam_loc, target, ortho_scale, transparent=False, samples=24):
    scene.world = bpy.data.worlds.new("Sky")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.79, 0.84, 0.88, 1.0)
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.58

    def sun(rot_deg, energy, color=(1.0, 0.96, 0.88)):
        bpy.ops.object.light_add(type="SUN")
        l = bpy.context.object
        l.data.energy = energy
        l.data.color = color
        l.data.angle = math.radians(10)
        l.rotation_euler = tuple(math.radians(a) for a in rot_deg)

    sun((40, 18, -32), 2.9, (1.0, 0.95, 0.85))
    sun((58, -18, 142), 0.66, (0.74, 0.86, 1.0))

    bpy.ops.object.camera_add(location=cam_loc)
    cam = bpy.context.object
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = ortho_scale
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.film_transparent = transparent
    scene.view_settings.view_transform = "Standard"


def prism(vb, parent, name, color, rim, bottom, top):
    signed_area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(rim, rim[1:] + rim[:1]))
    if signed_area < 0:
        rim = list(reversed(rim))
    n = len(rim)
    vertices = [(x, y, z) for z in (bottom, top) for x, y in rim]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(vb.mat(color))
    ob = bpy.data.objects.new(name, mesh)
    vb.scene.collection.objects.link(ob)
    ob.parent = parent
    return ob


def crown(vb, parent, name, x, y, z, width, depth, height, colors, seed, pine=False):
    rng = random.Random(seed)
    sides = 7 if pine else 9
    angles = [math.tau * (i + rng.uniform(-0.19, 0.19)) / sides for i in range(sides)]
    radii = [rng.uniform(0.81, 1.12) for _ in angles]
    offset = rng.uniform(-0.12, 0.12)
    rings = ((0.0, 0.57), (0.14, 1.0), (0.38, 0.83), (1.0, 0.05)) if pine else ((0, 0.52), (0.25, 0.96), (0.68, 1.0), (0.98, 0.52))
    verts = []
    for level, (rise, span) in enumerate(rings):
        for a, radius in zip(angles, radii):
            angle = a + offset * level
            verts.append(
                (
                    x + width * span * radius * math.cos(angle) / 2,
                    y + depth * span * radius * math.sin(angle) / 2,
                    z + height * (rise + rng.uniform(-0.045, 0.045)),
                )
            )
    faces = [tuple(reversed(range(sides)))]
    materials = [0]
    for level in range(len(rings) - 1):
        for i in range(sides):
            j = (i + 1) % sides
            faces.append((level * sides + i, level * sides + j, (level + 1) * sides + j, (level + 1) * sides + i))
            toward_light = math.cos(angles[i] - 2.8)
            value = level * 0.48 + toward_light * 0.36 + rng.uniform(-0.13, 0.13)
            materials.append(0 if value < 0.25 else 1 if value < 0.96 else 2)
    top_offset = (len(rings) - 1) * sides
    faces.append(tuple(range(top_offset, top_offset + sides)))
    materials.append(2)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    for col in colors:
        mesh.materials.append(vb.mat(col))
    for face, mat in zip(mesh.polygons, materials):
        face.material_index = mat
    ob = bpy.data.objects.new(name, mesh)
    vb.scene.collection.objects.link(ob)
    ob.parent = parent
    return ob


# KayKit's fixed palette cells describe the material, not the building that uses it.
KIT_SURFACES = {
    (0, 3): "slate",
    (1, 3): "slate",
    (4, 0): "stone",
    (5, 0): "stone",
    (10, 0): "oak",
    (11, 0): "oak",
    (12, 0): "oak",
    (13, 0): "oak",
}


def place_prop(parent, name, position, scale, angle=0, slots=KIT_SURFACES):
    model = prop(name, slots)
    model.parent = parent
    model.scale = scale
    model.rotation_mode = "XYZ"
    model.rotation_euler.z = math.radians(angle)
    vertices = list(zip(*(v.co for v in model.data.vertices)))
    origin = Vector([(min(vertices[0]) + max(vertices[0])) / 2, (min(vertices[1]) + max(vertices[1])) / 2, min(vertices[2])])
    model.location = Vector(position) - model.rotation_euler.to_matrix() @ (origin * Vector(scale))
    return model


def fence_run(vb, parent, start_x, end_x, y, count, height):
    span = end_x - start_x
    beams = []
    for i in range(count + 1):
        x = start_x + i * span / count
        beams.append(vb.box(parent, "FencePost", "wood-lo", (x, y, height * 0.48), (height * 0.22, height * 0.24, height * 0.96)))
        vb.box(parent, "FenceCap", "wood-hi", (x, y, height), (height * 0.28, height * 0.28, height * 0.10))
    for z in (0.35, 0.76):
        beams.append(vb.box(parent, "FenceRail", "wood", ((start_x + end_x) / 2, y, height * z), (span, height * 0.13, height * 0.134)))
    texture_objects(beams, "oak", tile_size=(2.2, 1.1))


PINE_SURFACES = {**KIT_SURFACES, (2, 2): "needles", (3, 2): "needles-light"}


def windmill(vb, parent, x, y):
    mill = place_prop(parent, "building_windmill_blue", (x, y, 0), (1.37, 1.37, 1.40), angle=30, slots={**KIT_SURFACES, (10, 1): "plaster", (11, 1): "plaster"})
    # In the source hierarchy the fan is 0.332 units ahead of the tower, on a 0.957-high axle.
    for index in range(4):
        blade = vb.pivot("ReefedSail", (0, -0.428, 0.957), mill, rot_deg=(0, index * 90, 0))
        vb.box(blade, "SailSpar", "wood-lo", (0, 0, 0.43), (0.045, 0.034, 0.82))
        sail = prism(vb, blade, "FlaxCanvas", "sail", [(-0.022, 0.20), (0.105, 0.25), (0.245, 0.78), (-0.030, 0.77)], 0, 0.018)
        sail.rotation_euler.x = math.pi / 2
        for z in (0.32, 0.58, 0.76):
            length = 0.12 + (z - 0.32) * 0.25
            vb.box(blade, "SailBatten", "wood-hi", (length * 0.5, -0.024, z), (length, 0.018, 0.022))


def shelter_tree(vb, root, x, y, scale, pine, seed):
    rng = random.Random(seed)
    vb.box(root, "TreeTrunk", "trunk", (x, y, 0.69 * scale), (0.25 * scale, 0.28 * scale, 1.38 * scale))
    if pine:
        for i, (z, w, h) in enumerate(((0.41, 1.64, 1.15), (0.96, 1.30, 1.02), (1.45, 0.92, 0.98))):
            crown(vb, root, "FirWhorl", x, y, z * scale, w * scale, w * scale, h * scale, ("pine-lo", "pine", "pine-hi"), seed + i, pine=True)
    else:
        for i, (ox, oy, oz, s) in enumerate(((-0.43, -0.10, 0.72, 1.14), (0.33, 0.16, 0.80, 1.32), (-0.20, 0.22, 1.25, 1.28), (0.22, -0.22, 1.45, 0.84))):
            crown(
                vb,
                root,
                "LeafCluster",
                x + ox * scale,
                y + oy * scale,
                oz * scale,
                s * scale,
                s * scale,
                s * scale * rng.uniform(0.75, 0.96),
                ("leaf-lo", "leaf", "leaf-hi"),
                seed + i,
            )


def build_farm_scene(assets_dir):
    """Builds the refined 384x256 voxel farm village aligned 1:1 with assets/village.ldtk."""
    scene = reset_scene()
    vb = Scenery(scene, SCENE_PAL, emissive_keys=("win-glow", "forge", "beacon"))
    root = vb.pivot("scene-farm", (0, 0, 0))

    camera_settings = json.loads((assets_dir / "village-camera.json").read_text())
    layout_pitch = math.radians(camera_settings["layoutPitchDegrees"])
    pixels_per_unit = camera_settings["pixelsPerUnit"]
    origin_x, origin_y = camera_settings["layoutOrigin"]
    sy = 1.0 / math.sin(layout_pitch)
    landmarks = {}

    def pt(ax, ay):
        return ((ax - origin_x) / pixels_per_unit, (origin_y - ay) / pixels_per_unit * sy)

    def rect(ax0, ay0, ax1, ay1, z, h, col, name="Ground", shade=0.0):
        cx, cy = pt((ax0 + ax1) * 0.5, (ay0 + ay1) * 0.5)
        w = (ax1 - ax0) / pixels_per_unit
        d = (ay1 - ay0) / pixels_per_unit * sy
        return vb.box(root, name, col, (cx, cy, z + h * 0.5), (w, d, h), shade=shade)

    def patch(name, color, outline, bottom, top):
        ring = [pt(x, y) for x, y in reversed(outline)]
        return prism(vb, root, name, color, ring, bottom, top)

    def box_at(name, color, ax, ay, z, w, d, h, rot=None):
        x, y = pt(ax, ay)
        return vb.box(root, name, color, (x, y, z), (w, d, h), rot_deg=rot)

    rng = random.Random(42)
    rect(-180, -188, 552, 410, -0.45, 0.45, "grass", "Meadow")
    perimeter = [
        (89, 99),
        (97, 96),
        (138, 97),
        (155, 95),
        (200, 96),
        (231, 94),
        (266, 96),
        (283, 95),
        (293, 100),
        (292, 128),
        (296, 139),
        (308, 141),
        (327, 143),
        (351, 140),
        (385, 139),
        (406, 143),
        (406, 161),
        (379, 161),
        (351, 158),
        (330, 163),
        (312, 160),
        (296, 163),
        (293, 188),
        (294, 200),
        (287, 210),
        (269, 209),
        (246, 212),
        (220, 210),
        (193, 212),
        (173, 210),
        (149, 211),
        (127, 209),
        (102, 211),
        (91, 205),
        (92, 184),
        (89, 172),
        (92, 147),
        (90, 132),
        (92, 112),
    ]
    patch("SoilVerge", "dirt-edge", perimeter, 0.001, 0.025)
    inner = [(192 + (x - 192) * 0.986, 153 + (y - 153) * 0.970) for x, y in perimeter]
    patch("TampedEarth", "dirt", inner, 0.026, 0.047)
    for edge in (
        [(37, 72), (53, 70), (67, 72), (77, 78), (107, 91), (117, 98), (105, 104), (88, 94), (70, 88), (48, 83), (36, 84)],
        [(176, 73), (201, 72), (204, 82), (201, 92), (206, 97), (175, 100), (180, 87)],
        [(285, 66), (355, 67), (363, 72), (362, 82), (343, 83), (319, 81), (298, 88), (284, 99), (272, 99), (285, 82)],
    ):
        patch("Footpath", "dirt-edge", edge, 0.005, 0.035)
    for ay in (82, 88, 94):
        box_at("DoorStone", "stone", 187 + rng.uniform(-1, 1), ay, 0.058, rng.uniform(0.60, 0.83), 0.29, 0.07, (0, 0, rng.uniform(-8, 8)))
    for _ in range(100):
        ax, ay = rng.uniform(96, 290), rng.uniform(98, 208)
        if rng.random() < 0.68:
            box_at(
                "SoilGrain",
                rng.choice(("dirt-grain", "dirt-grain", "dirt-lit")),
                ax,
                ay,
                0.052,
                rng.uniform(0.06, 0.16),
                rng.uniform(0.04, 0.09),
                0.008,
                (0, 0, rng.uniform(-28, 28)),
            )

    # Plant in drifts along boundaries; the patch itself stays visible between beds.
    drifts = [
        (5, 84, 13, 9),
        (12, 108, 20, 10),
        (57, 116, 15, 7),
        (40, 151, 15, 6),
        (9, 182, 17, 12),
        (75, 202, 10, 8),
        (75, 236, 22, 8),
        (24, 246, 29, 12),
        (141, 240, 12, 8),
        (202, 234, 29, 9),
        (272, 235, 20, 9),
        (306, 214, 11, 13),
        (348, 198, 22, 9),
        (375, 168, 14, 8),
        (364, 107, 17, 12),
        (327, 108, 11, 8),
        (115, 77, 10, 9),
        (257, 82, 13, 6),
    ]
    for i, (ax, ay, sx, sy_patch) in enumerate(drifts):
        edge = []
        for k in range(12):
            a = k * math.tau / 12
            f = rng.uniform(0.72, 1.12)
            edge.append((ax + math.cos(a) * sx * f, ay + math.sin(a) * sy_patch * f))
        patch("Clover", "grass-moss" if i % 3 else "grass-shade", edge, 0.001, 0.008 + i * 0.0003)
        for j in range(5):
            xx, yy = rng.uniform(-0.75, 0.75), rng.uniform(-0.70, 0.70)
            x, y = pt(ax + sx * xx, ay + sy_patch * yy)
            for k in range(3):
                angle = rng.uniform(-0.8, 0.8)
                h = rng.uniform(0.16, 0.36)
                vb.box(
                    root,
                    "Blade",
                    "grass-lo" if k == 0 else "grass-tip",
                    (x + k * 0.06, y + rng.uniform(-0.10, 0.10), h * 0.48),
                    (0.055, 0.035, h),
                    rot_deg=(10, math.degrees(angle), 0),
                )
            if j % 3 == 0:
                vb.box(root, "Bloom", ("flower-y", "flower-w", "flower-p")[i % 3], (x, y, 0.28), (0.12, 0.10, 0.10))
        if i % 3 != 0:
            x, y = pt(ax - sx * 0.25, ay + sy_patch * 0.2)
            for j, sc in enumerate((0.68, 0.53, 0.38)):
                crown(
                    vb, root, "Hedgerow", x + j * 0.28, y + 0.09 * (j % 2), 0.02, sc, sc, sc * 0.82, ("leaf-lo", "leaf", "leaf-hi"), 170 + i * 7 + j
                )

    # These banks extend outside the walkable LDtk rectangle, into the diagonal camera's corners.
    north_edge = [
        (-173, 37),
        (-138, 24),
        (-101, 29),
        (-70, 17),
        (-35, 23),
        (6, 16),
        (42, 13),
        (74, 17),
        (106, 11),
        (154, 18),
        (187, 8),
        (229, 16),
        (265, 9),
        (305, 17),
        (332, 11),
        (373, 21),
        (405, 12),
        (441, 24),
        (482, 12),
        (551, 21),
    ]
    for i, (offset, bottom, top, rock, moss) in enumerate(
        ((0, -0.02, 0.92, "cliff-lo", "grass-shade"), (-8, 0.96, 1.59, "cliff", "pine"), (-24, 1.63, 2.27, "cliff-hi", "grass-moss"))
    ):
        lip = [(x, y + offset) for x, y in north_edge] + [(551, -185), (-173, -185)]
        patch("FoothillLedge", rock, lip, bottom, top)
        patch("RidgeMoss", moss, lip, top, top + 0.05)
    for i in range(62):
        x, y = pt(-165 + (i % 31) * 24 + rng.uniform(-8, 8), -4 - (i // 31) * 24 + rng.uniform(-7, 7))
        sc = rng.uniform(0.72, 1.28)
        for j, (zz, ww, hh) in enumerate(((0, 1.56, 1.19), (0.65, 1.04, 1.05))):
            crown(
                vb,
                root,
                "DistantSpruce",
                x,
                y,
                1.75 + zz * sc,
                ww * sc,
                ww * sc,
                hh * sc,
                ("pine-shadow", "pine-lo", "pine"),
                1831 + i * 5 + j,
                pine=True,
            )
    distant = [
        (-174, -25),
        (-122, -44),
        (-74, -39),
        (-14, -55),
        (41, -48),
        (73, -67),
        (116, -60),
        (163, -78),
        (201, -71),
        (246, -83),
        (291, -77),
        (346, -58),
        (410, -64),
        (454, -45),
        (552, -52),
        (553, -190),
        (-174, -190),
    ]
    for i, (back, z, col) in enumerate(((0, 2.76, "ridge-low"), (-29, 3.36, "ridge-far"))):
        outline = [(x, y + back) for x, y in distant]
        patch("DistantRidge", col, outline, z - 0.36, z)
        for j in range(23):
            x, y = pt(-130 + j * 26 + rng.uniform(-10, 10), -70 - i * 28 + rng.uniform(-15, 15))
            size = rng.uniform(0.65, 1.56)
            crown(vb, root, "FarPine", x, y, z, size, size, size * 1.60, ("pine", "ridge-low", "ridge-far"), 4131 + j + i * 27, pine=True)
    # A tributary crosses the gate approach and drains the existing pond into the foreground.
    banks = [
        (497, -169, 23),
        (482, -115, 17),
        (465, -69, 20),
        (455, -32, 15),
        (432, 9, 14),
        (427, 44, 13),
        (419, 70, 13),
        (428, 101, 14),
        (433, 131, 15),
        (425, 157, 15),
        (410, 178, 13),
        (403, 194, 13),
        (386, 213, 19),
        (372, 233, 19),
        (365, 253, 18),
        (347, 273, 20),
        (328, 281, 23),
        (301, 296, 22),
        (280, 301, 18),
        (262, 313, 18),
        (232, 325, 20),
        (201, 332, 23),
        (166, 329, 22),
        (128, 324, 24),
        (102, 311, 23),
        (78, 306, 21),
        (49, 301, 17),
        (26, 291, 18),
        (-6, 288, 18),
        (-41, 273, 17),
        (-69, 265, 18),
        (-93, 242, 22),
        (-129, 232, 24),
        (-179, 215, 21),
    ]

    def ribbon(fraction):
        left, right = [], []
        for i, (x, y, w) in enumerate(banks):
            before = banks[max(0, i - 1)]
            after = banks[min(len(banks) - 1, i + 1)]
            vx, vy = after[0] - before[0], after[1] - before[1]
            mag = math.hypot(vx, vy)
            nx, ny = -vy / mag * w * fraction, vx / mag * w * fraction
            left.append((x + nx, y + ny))
            right.append((x - nx, y - ny))
        return left + list(reversed(right))

    for name, col, frac, z in (
        ("GravelBank", "cliff", 1.00, 0.011),
        ("WetCobble", "stone-lo", 0.91, 0.017),
        ("RiverShallows", "water", 0.82, 0.030),
        ("StreamChannel", "water-deep", 0.48, 0.036),
    ):
        patch(name, col, ribbon(frac), z, z + 0.003)
    for i, (ax, ay, w) in enumerate(banks):
        for j in range(3):
            xx, yy = ax + rng.uniform(-w / 3, w / 3), ay + rng.uniform(-w / 3, w / 3)
            box_at("Ripple", "water-hi", xx, yy, 0.050, rng.uniform(0.26, 0.72), 0.08, 0.01, (0, 0, rng.uniform(-22, 22)))
        if i % 2:
            x, y = pt(ax + w, ay + 2)
            crown(vb, root, "RiverStone", x, y, -0.08, 0.78, 0.57, 0.39, ("stone-lo", "cliff", "pebble"), 2461 + i)
    approach = [
        (380, 142),
        (400, 144),
        (422, 145),
        (442, 141),
        (470, 134),
        (502, 131),
        (524, 133),
        (529, 142),
        (504, 144),
        (472, 146),
        (447, 154),
        (419, 162),
        (399, 160),
        (380, 158),
    ]
    patch("ValleyTrack", "dirt", approach, 0.005, 0.022)
    for j in range(12):
        x = 402 + j * 3.2
        box_at("BridgePlank", "wood" if j % 3 else "wood-hi", x, 151, 0.22, 0.18, 1.09, 0.14, (0, 0, -8))
    for ay in (145, 157):
        box_at("BridgeRail", "wood-lo", 420, ay, 0.67, 2.37, 0.085, 0.12)
        for ax in (402, 420, 438):
            box_at("BridgePost", "trunk", ax, ay, 0.43, 0.15, 0.16, 0.86)
    for i, (ax, ay, span, number) in enumerate(
        (
            (-38, 73, 23, 10),
            (-64, 147, 31, 13),
            (-17, 221, 21, 8),
            (32, 285, 22, 5),
            (118, 291, 24, 7),
            (175, 289, 19, 6),
            (258, 277, 18, 5),
            (461, 73, 21, 9),
            (450, 201, 25, 11),
            (298, 336, 28, 9),
            (73, 352, 34, 14),
            (153, 362, 18, 8),
            (225, -62, 33, 14),
        )
    ):
        for j in range(number):
            a = rng.uniform(0, math.tau)
            r = span * math.sqrt(rng.random())
            x, y = pt(ax + r * math.cos(a), ay + r * math.sin(a))
            shelter_tree(vb, root, x, y, rng.uniform(0.65, 1.32), j % 3 != 1, 3503 + i * 29 + j)
    for i in range(12):
        ax, ay = -60 + (i % 6) * 10, 109 + (i // 6) * 15
        box_at("HayStack", "dirt", ax, ay, 0.31, 0.72, 0.80, 0.55, (0, 0, 6))
        box_at("BaleTwine", "trunk", ax, ay, 0.37, 0.07, 0.81, 0.57, (0, 0, 6))

    for cx_a in range(6, 386, 18):
        tx, ty = pt(cx_a, rng.uniform(2, 17))
        vb.box(
            root,
            "Rock",
            rng.choice(("cliff-hi", "cliff", "cliff-lo")),
            (tx, ty, rng.uniform(0.9, 1.8)),
            (1.1, 1.0, rng.uniform(0.9, 1.7)),
            shade=rng.uniform(-0.05, 0.05),
        )
    # Wooden utility poles along back ridge
    for px_a in (126, 256):
        ux, uy = pt(px_a, 14)
        vb.box(root, "Pole", "trunk", (ux, uy, 2.2), (0.20, 0.20, 4.0))
        vb.box(root, "CrossArm", "wood-lo", (ux, uy, 3.85), (1.10, 0.14, 0.14))
    for tx_a, ty_a, sc, is_pine in [
        (10, 36, 1.20, True),
        (118, 24, 1.10, True),
        (132, 34, 0.95, False),
        (248, 22, 1.15, True),
        (264, 34, 0.95, False),
        (374, 38, 1.15, True),
        (18, 122, 0.92, False),
        (52, 148, 0.85, True),
        (372, 182, 0.98, False),
        (26, 246, 0.85, False),
        (294, 244, 0.80, True),
    ]:
        tx, ty = pt(tx_a, ty_a)
        if is_pine:
            place_prop(root, "tree_single_A", (tx, ty, 0), (2.30 * sc, 2.30 * sc, 2.15 * sc), angle=tx_a, slots=PINE_SURFACES)
        else:
            shelter_tree(vb, root, tx, ty, sc, False, int(tx_a + ty_a))

    for i, (ax, ay, scale, pine) in enumerate(
        (
            (-1, 54, 0.93, False),
            (8, 62, 0.62, True),
            (119, 38, 1.22, True),
            (126, 53, 0.62, False),
            (245, 42, 1.04, True),
            (267, 53, 0.68, False),
            (378, 57, 0.83, True),
            (388, 79, 1.20, False),
            (-4, 184, 1.18, False),
            (8, 199, 0.63, True),
            (380, 188, 1.13, False),
            (389, 201, 0.70, True),
            (262, 247, 0.55, False),
            (279, 256, 0.76, True),
            (-3, 259, 1.18, False),
        )
    ):
        x, y = pt(ax, ay)
        shelter_tree(vb, root, x, y, scale, pine, 900 + i)
    for i, (x0, y0, length) in enumerate(((1, 72, 20), (113, 63, 16), (249, 56, 19), (359, 88, 21), (4, 223, 21), (239, 250, 21))):
        for j in range(5):
            x, y = pt(x0 + j * length / 5, y0 + rng.uniform(-2, 2))
            w = rng.uniform(0.25, 0.50)
            crown(vb, root, "DryStone", x, y, 0.04, w, w * 0.8, w * 0.65, ("stone-lo", "stone", "cliff-hi"), 500 + i * 12 + j)
    for i, (ax, ay) in enumerate(((51, 187), (97, 218), (152, 230), (223, 228), (313, 182), (366, 135))):
        x, y = pt(ax, ay)
        for j in range(6):
            xx, yy = x + rng.uniform(-0.38, 0.38), y + rng.uniform(-0.19, 0.19)
            height = rng.uniform(0.17, 0.29)
            vb.box(root, "WildflowerStem", "grass-lo", (xx, yy, height / 2), (0.035, 0.04, height))
            vb.box(root, "Wildflower", "flower-w" if j % 3 else "flower-y", (xx, yy, height), (0.11, 0.09, 0.065))

    for i in range(30):
        ax = -6 + i * 13.5 + rng.uniform(-4, 4)
        ay = rng.uniform(13, 26) + (i % 3) * 2
        x, y = pt(ax, ay)
        width = rng.uniform(0.82, 1.42)
        for k, (zz, ww, hh) in enumerate(((0.34, 1.7, 1.03), (0.93, 1.24, 0.94), (1.46, 0.76, 0.88))):
            crown(
                vb,
                root,
                "RidgePine",
                x,
                y,
                zz * width,
                width * ww,
                width * ww,
                width * hh,
                ("pine-shadow", "pine-lo", "pine"),
                1200 + i * 13 + k,
                pine=True,
            )
    for i, (ax, ay, rx, ry) in enumerate(
        (
            (6, 65, 16, 8),
            (15, 120, 13, 8),
            (50, 147, 13, 7),
            (121, 49, 13, 9),
            (253, 48, 19, 7),
            (380, 83, 16, 8),
            (377, 184, 17, 9),
            (14, 204, 13, 8),
            (27, 246, 15, 7),
            (275, 247, 18, 8),
            (310, 216, 12, 6),
        )
    ):
        ring = []
        for j in range(11):
            a = j * math.tau / 11
            spread = rng.uniform(0.71, 1.15)
            ring.append((ax + math.cos(a) * rx * spread, ay + math.sin(a) * ry * spread))
        patch("ForestFloor", "meadow-shade", ring, 0.001, 0.009 + i * 0.0003)
    for i, (ax, ay) in enumerate(
        ((99, 92), (107, 96), (175, 97), (202, 94), (280, 95), (290, 88), (304, 82), (301, 140), (308, 159), (350, 159), (367, 141))
    ):
        for j in range(4):
            x, y = pt(ax + rng.uniform(-3, 3), ay + rng.uniform(-1.8, 1.8))
            w = rng.uniform(0.12, 0.29)
            crown(vb, root, "WornVerge", x, y, 0.035, w, w * 0.68, w * 0.22, ("dirt-edge", "dirt-grain", "dirt-lit"), 1500 + i * 4 + j)
        if i % 2:
            x, y = pt(ax, ay + 1.5)
            for j in range(3):
                vb.box(root, "VergeGrass", "grass-lo", (x + j * 0.07, y, 0.10 + j * 0.018), (0.04, 0.06, 0.20), rot_deg=(12, -16 + j * 14, 0))

    start = set(scene.objects)
    lx, ly = pt(69, 52)
    bookshop = vb.pivot("Bookshop", (lx, ly, 0), root)
    vb.plank_wall(bookshop, "Limewash", "wall", (0, 0, 1.21), 4.3, 2.62, 2.2, planks=5, trim_color="wood-lo")
    footing = vb.box(bookshop, "StoneFooting", "stone-lo", (0, 0, 0.13), (4.55, 2.84, 0.26))
    texture_objects([footing], "stone", 1.7)
    vb.tiled_roof(bookshop, "TerracottaFront", "roof-orange", (0, -0.62, 2.54), 4.85, 1.52, 31, cols=12, rows=4)
    vb.tiled_roof(bookshop, "TerracottaBack", "roof-orange-hi", (0, 0.62, 2.54), 4.85, 1.52, 31, cols=12, rows=4, flip_y=True)
    vb.box(bookshop, "CappedRidge", "roof-rust-hi", (0, 0, 2.97), (4.92, 0.24, 0.18))
    for x in (-1.98, -0.55, 1.98):
        vb.box(bookshop, "FacadeTimber", "wood-lo", (x, -1.34, 1.11), (0.12, 0.13, 1.99))
    lintel = vb.box(bookshop, "LibraryLintel", "wood", (0, -1.36, 1.86), (4.35, 0.16, 0.16))
    door = vb.box(bookshop, "LibraryDoor", "wood-lo", (-0.92, -1.37, 0.78), (0.83, 0.13, 1.42))
    texture_objects([lintel, door], "oak", 1.45)
    vb.box(bookshop, "DoorPanel", "door-teal", (-0.92, -1.46, 0.77), (0.65, 0.08, 1.22))
    vb.box(bookshop, "BrassLatch", "cloth-y", (-0.71, -1.52, 0.75), (0.09, 0.06, 0.09))
    wx, wy = pt(70, 70)
    vb.window_box(root, "ReadingWindow", (wx, wy, 1.12), 0.85, 0.78, "win-frame", "win-glow")
    flue = box_at("MasonryFlue", "brick", 48, 43, 2.88, 0.58, 0.58, 1.50)
    texture_objects([flue], "brick", 1.25)
    box_at("ClayPot", "roof-rust-hi", 48, 43, 3.65, 0.69, 0.68, 0.15)
    for ax in range(36, 102, 7):
        box_at("PorchBoards", "wood", ax, 75, 0.15, 0.43, 0.91, 0.15)
    for ax in (32, 49):
        box_at("BookSignPost", "wood-lo", ax, 81, 0.80, 0.12, 0.14, 1.58)
    box_at("BookSignRail", "wood-hi", 40.5, 81, 1.48, 1.26, 0.19, 0.14)
    px, py = pt(40.5, 79)
    lectern = vb.pivot("OpenBook", (px, py, 1.52), root, rot_deg=(32, 0, 10))
    for side in (-1, 1):
        leaf = vb.pivot("Folio", (0, 0, 0), lectern, rot_deg=(0, -side * 17, 0))
        vb.box(leaf, "BookCover", "roof-teal-lo", (side * 0.39, 0, 0), (0.82, 1.07, 0.11))
        vb.box(leaf, "GiltPageEdges", "cloth-y", (side * 0.39, 0, 0.075), (0.72, 0.96, 0.09))
        vb.box(leaf, "Pages", "sail", (side * 0.39, 0, 0.135), (0.67, 0.90, 0.055))
        if side < 0:
            vb.box(leaf, "IlluminatedInitial", "roof-orange", (-0.42, 0.12, 0.17), (0.28, 0.29, 0.023))
        else:
            vb.box(leaf, "ManuscriptHeading", "door-teal", (0.39, 0.16, 0.17), (0.44, 0.08, 0.023))
        vb.box(leaf, "ManuscriptLine", "wood-lo", (side * 0.39, -0.15, 0.17), (0.42, 0.070, 0.023))
    vb.box(lectern, "Bookmark", "cloth-r", (0, -0.32, 0.17), (0.11, 0.50, 0.046))
    sx, sy_book = pt(91, 79)
    shelf = vb.pivot("BooksForLoan", (sx, sy_book, 0), root)
    vb.box(shelf, "DarkWoodBack", "win-frame", (0, 0.08, 0.76), (1.38, 0.18, 1.22))
    for xx in (-0.72, 0.72):
        vb.box(shelf, "ShelfUpright", "wood", (xx, -0.08, 0.76), (0.12, 0.40, 1.37))
    for zz in (0.16, 0.76, 1.36):
        vb.box(shelf, "ShelfLedge", "wood-hi", (0, -0.12, zz), (1.54, 0.47, 0.10))
    for i, col in enumerate(("cloth-r", "sail", "door-teal", "cloth-y", "pine-lo", "roof-rust-hi")):
        for j, base in enumerate((0.22, 0.82)):
            hh = (0.40, 0.47, 0.36)[(i + j) % 3]
            vb.box(shelf, "BookSpine", col, (-0.55 + i * 0.21, -0.21, base + hh / 2), (0.15, 0.20, hh), rot_deg=(0, 5 if i == 3 else 0, 0))

    def side_gable(parent, side_x, wall_top, half_depth, rise):
        tri = prism(vb, parent, "TimberedGable", "wall-lo", [(-half_depth, 0), (half_depth, 0), (0, rise)], 0, 0.08)
        tri.location = (side_x, 0, wall_top)
        tri.rotation_euler = (math.pi / 2, 0, math.pi / 2)
        for sign in (-1, 1):
            slope = math.degrees(math.atan2(rise, half_depth))
            vb.box(
                parent,
                "Bargeboard",
                "wood-lo",
                (side_x + 0.07, sign * half_depth * 0.5, wall_top + rise * 0.5),
                (0.11, math.hypot(half_depth, rise), 0.10),
                rot_deg=(-sign * slope, 0, 0),
            )
        vb.box(parent, "KingPost", "wood", (side_x + 0.09, 0, wall_top + rise * 0.48), (0.11, 0.12, rise * 0.96))

    def side_window(parent, x, y, z):
        wall = vb.pivot("SideWindow", (x, y, z), parent, rot_deg=(0, 0, 90))
        vb.window_box(wall, "Sash", (0, 0, 0), 0.65, 0.68, "win-frame", "win-glow")
        for sign in (-1, 1):
            vb.box(wall, "Shutter", "door-teal", (sign * 0.50, -0.035, 0), (0.20, 0.09, 0.73))
        vb.box(wall, "Sill", "wood-hi", (0, -0.10, -0.38), (1.23, 0.21, 0.10))

    side_gable(bookshop, 2.15, 2.17, 1.21, 0.71)
    side_window(bookshop, 2.19, -0.16, 1.30)
    vb.box(bookshop, "DoorNotice", "sail", (-1.08, -1.53, 1.02), (0.21, 0.04, 0.23))
    landmarks["skills"] = set(scene.objects) - start
    start = set(scene.objects)

    # 5. Center building: Main Farmhouse / Manager (px=[146..234], py=[16..82])
    mx, my = pt(190, 58)
    vb.box(root, "HomeStone", "stone", (mx, my, 0.16), (5.45, 3.25, 0.32))
    vb.plank_wall(root, "HomeWall", "wood", (mx, my, 1.12), 5.20, 3.00, 1.66, planks=6, trim_color="wood-lo")
    vb.tiled_roof(root, "HomeRoofF", "roof-teal", (mx, my - 0.64, 2.44), 5.79, 1.49, 26, cols=10, rows=4, flip_y=False)
    vb.tiled_roof(root, "HomeRoofB", "roof-teal-hi", (mx, my + 0.64, 2.44), 5.79, 1.49, 26, cols=10, rows=4, flip_y=True)
    vb.box(root, "HomeRidge", "roof-teal-lo", (mx, my, 2.80), (5.89, 0.32, 0.24))
    mcx, mcy = pt(160, 50)
    vb.box(root, "HomeChimney", "stone", (mcx, mcy, 2.82), (0.68, 0.68, 1.38))
    vb.box(root, "HomeChimCap", "stone-lo", (mcx, mcy, 3.54), (0.82, 0.82, 0.14))
    vb.box(root, "HomeDoorFrame", "wood-lo", (mx - 0.22, my - 1.53, 0.74), (1.06, 0.14, 1.36))
    vb.box(root, "HomeDoor", "door-teal", (mx - 0.22, my - 1.56, 0.72), (0.88, 0.12, 1.26))
    vb.box(root, "HomeDoorStep", "stone", (mx - 0.22, my - 1.72, 0.10), (1.20, 0.36, 0.20))
    vb.window_box(root, "HomeWinL", (mx - 1.68, my - 1.54, 1.06), 0.84, 0.70, "win-frame", "win-glow", "flower-p", "leaf")
    vb.window_box(root, "HomeWinR", (mx + 1.36, my - 1.54, 1.06), 0.84, 0.70, "win-frame", "win-glow", "flower-y", "leaf")
    porch_x, porch_y = pt(188, 79)
    porch = vb.pivot("EntrancePorch", (porch_x, porch_y, 0), root)
    vb.box(root, "EntryRecess", "porch-shade", (mx - 0.20, my - 1.53, 0.99), (1.76, 0.07, 1.68))
    vb.box(root, "ShadowedDoor", "pine-lo", (mx - 0.22, my - 1.62, 0.76), (0.86, 0.09, 1.33))
    vb.box(root, "BrassKnob", "cloth-y", (mx + 0.08, my - 1.69, 0.72), (0.09, 0.06, 0.09))
    vb.box(porch, "PorchFloor", "wood-lo", (0, 0, 0.12), (3.76, 0.76, 0.24))
    for i in range(10):
        vb.box(porch, "DeckBoard", "wood", (i * 0.37 - 1.66, -0.02, 0.26), (0.347, 0.76, 0.09), shade=((i % 3) - 1) * 0.035)
    for side in (-1, 1):
        vb.box(porch, "PaintedPost", "door-teal", (side * 1.76, -0.18, 0.97), (0.14, 0.17, 1.69))
        vb.box(porch, "PorchRail", "wood-hi", (side * 1.30, -0.20, 0.78), (0.88, 0.12, 0.10))
        for i in range(3):
            vb.box(porch, "Baluster", "wood", (side * (0.94 + i * 0.27), -0.20, 0.52), (0.065, 0.08, 0.48))
    vb.box(porch, "PorchCornice", "wood-lo", (0, 0.13, 1.76), (3.84, 0.23, 0.16))
    porch_roof = vb.box(porch, "VerandaRoof", "roof-teal-lo", (0, 0.42, 1.90), (3.96, 0.59, 0.14), rot_deg=(13, 0, 0))
    texture_objects([porch_roof], "slate", 1.9)
    for i in range(4):
        vb.box(porch, "Joist", "wood-hi", (-1.65 + i * 1.10, 0.04, 1.73), (0.12, 0.41, 0.15))
    dor = vb.pivot("Dormer", (mx - 0.32, my - 0.86, 2.03), root)
    vb.box(dor, "DormerFront", "wall", (0, -0.23, 0.54), (1.02, 0.68, 0.88))
    tri = prism(vb, dor, "Gable", "wall", [(-0.55, 0), (0.55, 0), (0, 0.44)], 0, 0.42)
    tri.location = (0, -0.16, 0.97)
    tri.rotation_euler[0] = math.pi / 2
    vb.window_box(dor, "LoftWindow", (0, -0.61, 0.66), 0.50, 0.47, "win-frame", "door-teal")
    dormer_tiles = []
    for side in (-1, 1):
        tile = vb.box(dor, "DormerSlate", "roof-teal-lo", (side * 0.31, -0.26, 1.14), (0.82, 1.02, 0.13), rot_deg=(0, side * 34, 0))
        dormer_tiles.append(tile)
    texture_objects(dormer_tiles, "slate", 1.9)
    vb.box(dor, "RidgeTile", "roof-teal-hi", (0, -0.26, 1.38), (0.13, 1.05, 0.10))
    box_at("DoorLampBracket", "iron-dark", 190, 80, 1.60, 0.12, 0.37, 0.12)
    box_at("DoorLamp", "win-glow", 190, 80, 1.35, 0.23, 0.22, 0.33)
    box_at("DoorLampShade", "iron-dark", 190, 80, 1.55, 0.32, 0.30, 0.10)

    # Potted plants flanking doorway + clothesline on right
    for px_o, fl_c in ((-1.05, "flower-p"), (0.58, "flower-y")):
        vb.box(root, "Pot", "roof-orange", (mx + px_o, my - 1.72, 0.22), (0.34, 0.34, 0.32))
        vb.box(root, "PotLeaf", "leaf-hi", (mx + px_o, my - 1.72, 0.44), (0.42, 0.42, 0.24))
        vb.box(root, "PotFlw", fl_c, (mx + px_o, my - 1.72, 0.58), (0.20, 0.20, 0.12))
    side = vb.pivot("FarmhouseElevation", (mx, my, 0), root)
    side_gable(side, 2.61, 1.95, 1.26, 0.82)
    side_window(side, 2.64, -0.36, 1.22)
    for i in range(8):
        local_z = 0.28 + i * 0.17
        vb.box(
            side,
            "ClimbingIvy",
            "leaf-lo" if i % 3 else "leaf",
            (2.64, 0.64 + 0.09 * (i % 3), local_z),
            (0.09, 0.19, 0.16),
            rot_deg=(26 * (i % 2) - 13, 0, 0),
        )
    landmarks["manager"] = set(scene.objects) - start
    clx, cly = pt(246, 68)
    vb.box(root, "LinePost", "wood-lo", (clx + 1.0, cly, 0.65), (0.14, 0.14, 1.30))
    vb.box(root, "LineRope", "wood-lo", (clx, cly, 1.10), (2.05, 0.05, 0.05))
    for i, ccol in enumerate(("cloth-y", "cloth-r", "cloth-b")):
        vb.box(root, "Cloth", ccol, (clx - 0.52 + i * 0.52, cly, 0.82), (0.38, 0.08, 0.48))

    from kaykit import blacksmith

    smithy = blacksmith()
    smithy.parent = root
    # The kit's anvil face sits at the LDtk hammer emitter (299, 83, height 0.85).
    smithy.location = (*pt(310, 54), 0)
    smithy.scale = (4.72,) * 3
    landmarks["runtimes"] = {smithy}

    tx, ty = pt(22, 148)
    tower = vb.pivot("RadioTower", (tx, ty, 0), root)

    def spar(name, color, start, end, thickness):
        a, b = Vector(start), Vector(end)
        delta = b - a
        ob = vb.box(tower, name, color, (a + b) * 0.5, (thickness, thickness, delta.length))
        ob.rotation_euler = delta.to_track_quat("Z", "Y").to_euler()

    vb.box(tower, "Plinth", "stone-lo", (0, 0, 0.17), (1.49, 1.26, 0.34))
    stages = ((0.34, 0.58), (1.80, 0.47), (3.25, 0.35), (4.60, 0.24), (5.83, 0.13))
    for (z0, r0), (z1, r1) in zip(stages, stages[1:]):
        for side in (-1, 1):
            spar("TowerLeg", "iron-dark", (side * r0, -r0 * 0.7, z0), (side * r1, -r1 * 0.7, z1), 0.085)
            spar("RearLeg", "iron", (side * r0, r0 * 0.7, z0), (side * r1, r1 * 0.7, z1), 0.075)
            spar("CrossTie", "iron", (side * r0, -r0 * 0.7, z0), (-side * r1, -r1 * 0.7, z1), 0.055)
        vb.box(tower, "Collar", "iron-hi", (0, 0, z1), (r1 * 2 + 0.07, r1 * 1.5, 0.065))
    spar("Aerial", "iron-dark", (0, 0, 5.8), (0, 0, 7.58), 0.075)
    for zz, span in ((6.11, 0.94), (6.60, 0.69)):
        vb.box(tower, "Dipole", "iron-hi", (0, 0, zz), (span, 0.06, 0.07))
    vb.box(tower, "Beacon", "beacon", (0, 0, 7.60), (0.18, 0.17, 0.18))
    dish = vb.pivot("ReceiverDish", (0.61, -0.15, 3.50), tower, rot_deg=(-18, 0, 22))
    verts = [(0, 0, 0)]
    for r, depth in ((0.36, -0.045), (0.69, -0.23)):
        verts.extend((r * math.cos(i * math.tau / 12), depth, r * math.sin(i * math.tau / 12)) for i in range(12))
    faces = [(0, 1 + i, 1 + (i + 1) % 12) for i in range(12)]
    faces.extend((1 + i, 13 + i, 13 + (i + 1) % 12, 1 + (i + 1) % 12) for i in range(12))
    mesh = bpy.data.meshes.new("Dish")
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(vb.mat("iron-hi"))
    reflecting = bpy.data.objects.new("Reflector", mesh)
    vb.scene.collection.objects.link(reflecting)
    reflecting.parent = dish
    vb.box(dish, "FeedArm", "iron-dark", (0, -0.25, 0), (0.07, 0.48, 0.08))
    vb.box(dish, "FeedHorn", "cloth-y", (0, -0.49, 0), (0.16, 0.13, 0.16))

    wx, wy = pt(42, 200)
    place_prop(root, "building_well_blue", (wx, wy, 0), (2.9, 2.9, 2.4), angle=300)
    bnx, bny = pt(68, 210)
    vb.box(root, "BenchSeat", "wood-hi", (bnx, bny, 0.36), (1.30, 0.48, 0.12))
    vb.box(root, "BenchBack", "wood", (bnx, bny + 0.20, 0.64), (1.30, 0.10, 0.40))
    for sx in (-0.52, 0.52):
        vb.box(root, "BenchLeg", "wood-lo", (bnx + sx, bny, 0.18), (0.14, 0.44, 0.36))

    bank = [
        (307, 235),
        (310, 225),
        (317, 221),
        (319, 215),
        (327, 214),
        (337, 209),
        (347, 211),
        (358, 206),
        (369, 207),
        (377, 201),
        (391, 204),
        (400, 259),
        (308, 265),
        (311, 252),
    ]
    patch("ShoreStones", "stone-lo", bank, 0.006, 0.064)
    water = [
        (311, 237),
        (314, 228),
        (321, 224),
        (322, 219),
        (329, 218),
        (338, 213),
        (349, 215),
        (359, 211),
        (371, 212),
        (379, 207),
        (391, 209),
        (400, 260),
        (312, 265),
        (315, 252),
    ]
    patch("Pond", "water", water, 0.065, 0.080)
    patch(
        "DeepPool",
        "water-deep",
        [(328, 246), (332, 234), (343, 232), (353, 222), (368, 222), (377, 214), (391, 215), (398, 260), (326, 263)],
        0.081,
        0.086,
    )
    for i in range(1, 10):
        ax, ay = bank[i]
        x, y = pt(ax, ay)
        crown(
            vb,
            root,
            "BankRock",
            x,
            y,
            0.06,
            rng.uniform(0.30, 0.67),
            rng.uniform(0.22, 0.42),
            rng.uniform(0.12, 0.26),
            ("stone-lo", "stone", "pebble"),
            90 + i,
        )
    for i in range(13):
        ax, ay = rng.uniform(332, 391), rng.uniform(228, 261)
        box_at("WaterGlint", "water-hi", ax, ay, 0.091, rng.uniform(0.15, 0.43), 0.045, 0.009, (0, 0, rng.uniform(-8, 8)))
    for lx_a, ly_a, bloom in ((332, 232, True), (348, 244, False), (358, 224, True)):
        px, py = pt(lx_a, ly_a)
        vb.box(root, "Lily", "lily", (px, py, 0.145), (0.44, 0.38, 0.05))
        if bloom:
            vb.box(root, "Lotus", "lotus", (px, py, 0.20), (0.18, 0.18, 0.09))
    for rx_a, ry_a in ((316, 220), (318, 236), (322, 248)):
        px, py = pt(rx_a, ry_a)
        vb.box(root, "Reed", "reed", (px, py, 0.28), (0.14, 0.14, 0.56))
    prx, pry = pt(366, 220)
    for pi in range(4):
        vb.box(root, "PierPlank", "wood-hi", (prx - 0.50 + pi * 0.34, pry, 0.24), (0.28, 0.88, 0.12), shade=((pi % 2) - 0.5) * 0.06)
    for sx in (-0.56, 0.56):
        vb.box(root, "PierPost", "wood-lo", (prx + sx, pry - 0.36, 0.18), (0.16, 0.16, 0.44))

    # 10. Right fence gate with diagonal brace + arched street lamp
    for ax, ay in ((322, 136), (338, 138), (324, 164), (337, 168)):
        box_at("GatePost", "wood-lo", ax, ay, 0.50, 0.23, 0.23, 1.00)
        box_at("PostCap", "wood-hi", ax, ay, 1.06, 0.30, 0.30, 0.17)
    for zz in (0.40, 0.78):
        box_at("GateRail", "wood", 330, 137, zz, 1.01, 0.13, 0.12, (0, 0, -6))
        box_at("GateRail", "wood", 330.5, 166, zz, 0.84, 0.13, 0.12, (0, 0, -17))
    box_at("GateBrace", "wood-hi", 330, 137, 0.58, 1.04, 0.11, 0.10, (0, 22, -6))
    lmx, lmy = pt(354, 128)
    vb.box(root, "LampBase", "stone", (lmx, lmy, 0.16), (0.38, 0.38, 0.32))
    vb.box(root, "LampPost", "iron", (lmx, lmy, 1.05), (0.16, 0.16, 1.85))
    vb.box(root, "LampArm", "iron", (lmx - 0.20, lmy, 1.92), (0.50, 0.12, 0.12))
    vb.box(root, "LampGlow", "win-glow", (lmx - 0.36, lmy, 1.66), (0.30, 0.30, 0.38))
    vb.box(root, "LampCap", "iron", (lmx - 0.36, lmy, 1.88), (0.38, 0.38, 0.10))

    fx, fy = pt(10, 228)
    fence_run(vb, root, fx, pt(294, 228)[0], fy, 13, 0.72)

    export_glb(assets_dir / "models" / "scene-farm.glb", multi_clip=False)

    yaw = math.radians(camera_settings["yawDegrees"])
    pitch = math.radians(camera_settings["pitchDegrees"])
    camera_dir = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    right = Vector((math.cos(yaw), math.sin(yaw), 0))
    up = camera_dir.cross(right)
    screen_x, screen_y = camera_settings["screenOrigin"]
    density = pixels_per_unit * camera_settings["zoom"]
    target = (right * (192 - screen_x) + up * (screen_y - 128)) / density
    setup_ortho_render(scene, 768, 512, target + camera_dir * 35, target, ortho_scale=384 / density, transparent=False, samples=20)
    scene.render.filepath = str(assets_dir / "pixel" / "map.png")
    bake_pixels(scene)
    from landmark_mask import write_landmark_mask

    write_landmark_mask(scene, landmarks, assets_dir / "pixel" / "yard-landmarks.png")


# Screen-space coastlines keep the interactive yard clear in all six atlas crops.
ISLAND_SHORES = {
    "lavender": [
        (7, 36),
        (16, 22),
        (32, 19),
        (46, 23),
        (62, 20),
        (74, 18),
        (89, 29),
        (95, 48),
        (91, 62),
        (96, 69),
        (83, 77),
        (62, 77),
        (53, 83),
        (31, 78),
        (22, 73),
        (9, 69),
        (4, 55),
    ],
    "meadow": [
        (4, 46),
        (10, 32),
        (18, 28),
        (23, 17),
        (40, 20),
        (51, 25),
        (72, 21),
        (85, 27),
        (91, 38),
        (96, 46),
        (92, 60),
        (86, 70),
        (86, 77),
        (70, 78),
        (50, 84),
        (30, 78),
        (17, 79),
        (10, 66),
    ],
    "orchard": [
        (5, 46),
        (10, 30),
        (22, 21),
        (40, 19),
        (54, 23),
        (64, 19),
        (79, 23),
        (91, 34),
        (94, 48),
        (90, 55),
        (94, 64),
        (84, 71),
        (78, 78),
        (55, 80),
        (40, 84),
        (23, 75),
        (9, 74),
        (5, 62),
    ],
    "pines": [
        (6, 43),
        (11, 31),
        (22, 29),
        (26, 15),
        (38, 18),
        (46, 24),
        (59, 23),
        (68, 15),
        (80, 20),
        (87, 33),
        (95, 41),
        (91, 58),
        (94, 64),
        (84, 72),
        (65, 73),
        (57, 81),
        (46, 76),
        (38, 82),
        (26, 73),
        (15, 74),
        (14, 62),
        (5, 57),
    ],
    "pond": [
        (4, 44),
        (9, 30),
        (24, 19),
        (38, 22),
        (51, 19),
        (66, 23),
        (79, 21),
        (91, 30),
        (96, 45),
        (91, 52),
        (94, 61),
        (88, 69),
        (80, 67),
        (72, 78),
        (56, 77),
        (44, 82),
        (29, 78),
        (15, 72),
        (5, 63),
    ],
    "windmill": [
        (4, 44),
        (11, 28),
        (20, 23),
        (27, 18),
        (40, 21),
        (58, 20),
        (68, 23),
        (79, 21),
        (88, 29),
        (95, 44),
        (92, 54),
        (96, 62),
        (87, 70),
        (70, 75),
        (61, 80),
        (45, 77),
        (32, 81),
        (17, 73),
        (11, 62),
        (5, 58),
    ],
}


def island_strata(vb, root, name, outline, rings, weathering=0):
    """A closed, faceted section whose last ring forms the flat walkable top."""
    area = sum(x * ny - nx * y for (x, y), (nx, ny) in zip(outline, outline[1:] + outline[:1]))
    if area < 0:
        outline = list(reversed(outline))
    cx = sum(x for x, _ in outline) / len(outline)
    cy = sum(y for _, y in outline) / len(outline)
    n = len(outline)
    vertices = []
    faces = []
    colors = []
    for j, (scale, dx, dy, z, color) in enumerate(rings):
        for i, (x, y) in enumerate(outline):
            ripple = math.sin(i * 1.7 + j * 0.85) * 0.65 + math.sin(i * 0.9 - j * 0.26) * 0.35
            height = z + weathering * min(1, abs(z)) * ripple
            vertices.append((cx + (x - cx) * scale + dx, cy + (y - cy) * scale + dy, height))
        if j:
            for i in range(n):
                k = (i + 1) % n
                faces.append(((j - 1) * n + i, (j - 1) * n + k, j * n + k, j * n + i))
                colors.append((color, (-0.10, -0.05, 0.0, 0.05)[(i * 7 + j * 3) % 4]))
    faces.extend([tuple(reversed(range(n))), tuple(range(len(vertices) - n, len(vertices)))])
    colors.extend([(rings[0][-1], 0.0), (rings[-1][-1], 0.0)])
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    vb.scene.collection.objects.link(obj)
    obj.parent = root
    slots = {}
    for polygon, key in zip(mesh.polygons, colors):
        if key not in slots:
            slots[key] = len(slots)
            mesh.materials.append(vb.mat(*key))
        polygon.material_index = slots[key]
    return obj


def island_crown(vb, root, x, y, z, radius, height, color, seed):
    rng = random.Random(seed)
    points = []
    for i in range(8):
        angle = 2 * math.pi * (i + 0.35) / 8
        length = radius * rng.uniform(0.83, 1.13)
        points.append((x + length * math.cos(angle), y + 0.82 * length * math.sin(angle)))
    return island_strata(
        vb,
        root,
        "Crown",
        points,
        [(0.63, 0, 0, z, color), (1.0, 0, 0, z + height * 0.34, color), (0.96, 0, 0, z + height * 0.66, color), (0.50, -0.05, 0, z + height, color)],
    )


def island_tree(vb, root, x, y, scale, pine=False, apples=False):
    s = scale
    if pine:
        place_prop(root, "tree_single_A", (x, y, 0), (1.86 * s, 1.86 * s, 1.45 * s), slots=PINE_SURFACES)
        return
    vb.box(root, "Trunk", "trunk", (x, y, 0.30 * s), (0.23 * s, 0.24 * s, 0.60 * s))
    for i, (ox, oy, oz, r, h, col) in enumerate(
        (
            (-0.33, 0.12, 0.52, 0.52, 0.67, "leaf-lo"),
            (0.30, 0.10, 0.65, 0.52, 0.66, "leaf"),
            (-0.10, -0.24, 0.68, 0.48, 0.65, "leaf"),
            (0.0, 0.04, 0.99, 0.52, 0.51, "leaf-hi"),
        )
    ):
        island_crown(vb, root, x + ox * s, y + oy * s, oz * s, r * s, h * s, col, 34 + i)
    if apples:
        for ox, oy, oz in ((-0.47, -0.28, 0.91), (-0.15, -0.58, 0.88), (0.24, -0.46, 1.03), (0.53, -0.18, 0.95), (-0.28, 0.02, 1.27)):
            vb.box(root, "Apple", "apple", (x + ox * s, y + oy * s, oz * s), (0.13 * s, 0.13 * s, 0.14 * s), rot_deg=(0, 0, 12))


def build_islands(assets_dir, sprites_meta):
    camera = json.loads((assets_dir / "village-camera.json").read_text())
    layout_pitch = math.radians(camera["islandLayoutPitchDegrees"])
    pitch = math.radians(camera["pitchDegrees"])
    yaw = math.radians(camera["yawDegrees"])
    zoom = camera["islandZoom"]
    pixels_per_unit = 54
    right = Vector((math.cos(yaw), math.sin(yaw), 0))
    up = Vector((-math.sin(yaw) * math.sin(pitch), math.cos(yaw) * math.sin(pitch), math.cos(pitch)))
    eye = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    palettes = {
        "lavender": ("879868", "788654", "af8d65"),
        "meadow": ("86a456", "6f8b45", "bd955e"),
        "orchard": ("96a558", "708748", "a78052"),
        "pines": ("728f76", "586e60", "889690"),
        "pond": ("7b9d74", "5b806b", "84958a"),
        "windmill": ("aaad67", "8b955a", "bc9266"),
    }
    for theme, shore in ISLAND_SHORES.items():
        name = f"island-{theme}"
        meta = sprites_meta[name]
        w, h = meta["w"], meta["h"]
        x0, y0, x1, y1 = meta["yard"]
        # The six-slot map places the front row of feet 38.5 art pixels below the yard centre.
        soil_front = max(y1, (y0 + y1) / 2 + 77)
        meadow, moss, stone = palettes[theme]
        scene = reset_scene()
        vb = Scenery(scene, dict(SCENE_PAL, turf=meadow, moss=moss, shale=stone, tilth="bd955d", chalk="d4c5a4", grain="c78c3c"))
        root = vb.pivot(name)
        rng = random.Random(theme)

        def ground(px, py):
            return ((px - w / 2) / pixels_per_unit, (h / 2 - py) / (pixels_per_unit * math.sin(layout_pitch)))

        def place(u, v):
            return ground(u * w, v * h)

        def box(label, col, x, y, z, sx, sy, sz, rotation=None):
            return vb.box(root, label, col, (x, y, z), (sx, sy, sz), rot_deg=rotation)

        outline = [place(u / 100, v / 100) for u, v in shore]
        depth = {"lavender": 0.60, "meadow": 0.70, "orchard": 0.68, "pines": 0.95, "pond": 0.83, "windmill": 0.82}[theme]
        island_strata(
            vb,
            root,
            "Island",
            outline,
            [
                (0.55, -0.18, 0, -depth * 2.15, "cliff-lo"),
                (0.78, 0.06, 0, -depth * 1.85, "cliff"),
                (0.92, -0.05, 0, -depth * 1.66, "shale"),
                (0.98, -0.02, 0, -depth * 1.28, "cliff"),
                (0.97, 0, 0, -depth * 0.98, "shale"),
                (0.99, 0, 0, -depth * 0.64, "cliff"),
                (0.99, 0, 0, -depth * 0.45, "shale"),
                (0.99, 0, 0, -0.17, "earth"),
                (1, 0, 0, -0.07, "moss"),
                (1, 0, 0, 0, "turf"),
            ],
            weathering=0.22,
        )
        # The atlas yard is in source pixels; its corners stay on soil at every density.
        bed = [
            ground(x, y)
            for x, y in [
                (x0 - 3, y0 + 4),
                (x0 + 5, y0 - 3),
                (x1 - 6, y0 - 3),
                (x1 + 4, y0 + 4),
                (x1 + 4, soil_front - 5),
                (x1 - 3, soil_front + 3),
                (x0 + 6, soil_front + 3),
                (x0 - 3, soil_front - 4),
            ]
        ]
        island_strata(vb, root, "Yard", bed, [(1.02, 0, 0, 0.003, "dirt-lo"), (1.02, 0, 0, 0.021, "dirt-edge"), (1, 0, 0, 0.032, "tilth")])

        # A gap in the fence and stones at the front read as a way in at map scale.
        back = ground(0, y0 - 9)[1]
        for start, end in ((x0 + 10, (x0 + x1) / 2 - 31), ((x0 + x1) / 2 + 34, x1 - 10)):
            a = ground(start, 0)[0]
            b = ground(end, 0)[0]
            fence_run(vb, root, a, b, back, 2, 0.34)
        for i in range(4):
            x, y = ground((x0 + x1) / 2 + (i % 2) * 4, soil_front + 7 + i * 5)
            box("Paver", "chalk", x, y, 0.037, 0.28 + i * 0.015, 0.13, 0.05, (0, 0, rng.randrange(-12, 13)))

        # Alternating spurs and recesses carry the cliff silhouette below the edge of the turf.
        for i, ((x, y), (nx, ny)) in enumerate(zip(outline, outline[1:] + outline[:1])):
            if (y + ny) / 2 > -0.6:
                continue
            for fraction in (0.23, 0.68):
                bx = x + (nx - x) * fraction
                by = y + (ny - y) * fraction
                width = rng.uniform(0.32, 0.61)
                cliff_limit = w * 0.465 / pixels_per_unit - width
                bx = max(-cliff_limit, min(cliff_limit, bx))
                depth_offset = rng.uniform(0.12, 0.22)
                height = depth * rng.uniform(0.64, 1.20)
                contour = [
                    (bx - width * 0.67, by + 0.09),
                    (bx + width * 0.37, by + 0.15),
                    (bx + width, by - 0.01),
                    (bx + width * 0.49, by - depth_offset),
                    (bx - width * 0.58, by - depth_offset * 0.82),
                    (bx - width, by - 0.02),
                ]
                island_strata(
                    vb,
                    root,
                    "Weathered outcrop",
                    contour,
                    [
                        (0.45, 0.035, 0.035, -height - 0.25, "cliff-lo"),
                        (0.88, -0.04, 0, -height * 0.83, "cliff"),
                        (1.0, 0, 0, -height * 0.46, "shale"),
                        (0.85, 0, 0.05, -0.15 - rng.uniform(0.03, 0.15), "shale"),
                    ],
                )
            if i % 3 == 0:
                for j in range(4):
                    xx = x * 0.96
                    yy = y * 0.99 - 0.07
                    box("Ivy", "leaf-lo", xx, yy, -0.07 - j * 0.12, 0.11, 0.16, 0.19)
                    box("Ivy leaf", "leaf", xx + (-1) ** j * 0.08, yy - 0.06, -0.06 - j * 0.12, 0.14, 0.09, 0.10, (0, 14 * j, 10))

        # Wild plants grow in patches at the shoulder of the yard; the grass between patches stays quiet.
        grasses = {
            "lavender": [(0.20, 0.71), (0.69, 0.73), (0.33, 0.22), (0.57, 0.23)],
            "meadow": [(0.10, 0.45), (0.16, 0.57), (0.24, 0.71), (0.68, 0.69), (0.81, 0.66), (0.86, 0.49), (0.37, 0.23)],
            "orchard": [(0.12, 0.46), (0.20, 0.63), (0.29, 0.74), (0.66, 0.73), (0.86, 0.54), (0.56, 0.25)],
            "pines": [(0.12, 0.54), (0.20, 0.67), (0.68, 0.67), (0.84, 0.62), (0.53, 0.25)],
            "pond": [(0.16, 0.50), (0.17, 0.61), (0.25, 0.69), (0.63, 0.72), (0.85, 0.30)],
            "windmill": [(0.12, 0.52), (0.18, 0.65), (0.33, 0.72), (0.68, 0.70), (0.75, 0.64), (0.74, 0.30)],
        }
        for u, v in grasses[theme]:
            if x0 - 12 < u * w < x1 + 12 and v > 0.5:
                v = max(v, (soil_front + 26) / h)
            gx, gy = place(u, v)
            for j in range(6):
                x = gx + rng.uniform(-0.23, 0.23)
                y = gy + rng.uniform(-0.18, 0.18)
                angle = rng.uniform(-55, 55)
                box(
                    "Moss",
                    "moss" if j % 3 else "grass-hi",
                    x,
                    y,
                    0.016 + j * 0.002,
                    rng.uniform(0.12, 0.29),
                    rng.uniform(0.08, 0.15),
                    0.035,
                    (0, 0, angle),
                )
                for k in range(3):
                    tilt = (k - 1) * rng.randrange(16, 33)
                    box("Sedge", "grass-lo" if k == 0 else "grass-hi", x + 0.045 * k, y, 0.12, 0.055, 0.049, 0.22 + j * 0.013, (0, tilt, angle))
            if theme in ("meadow", "orchard", "lavender"):
                for k in range(4):
                    x, y = gx + rng.uniform(-0.22, 0.22), gy + rng.uniform(-0.18, 0.18)
                    box("Wildflower", "flower-w" if k % 3 else "flower-y", x, y, 0.24, 0.085, 0.09, 0.06, (0, 5, 19 * k))

        for i in range(32):
            x, y = ground(rng.uniform(x0 + 5, x1 - 5), rng.uniform(y0 + 4, y1 - 6))
            box("Soil fleck", "tilth", x, y, 0.04, 0.09 + rng.random() * 0.08, 0.055, 0.018, (0, 0, rng.randrange(-20, 20))).data.materials[0] = (
                vb.mat("tilth", rng.choice([-0.10, -0.05, 0.05]))
            )

        def flowers(u, v, col):
            x, y = place(u, v)
            for dx, dy, size in ((0, 0, 1), (-0.17, 0.04, 0.8), (0.17, 0.12, 0.74)):
                box("Foliage", "leaf-lo", x + dx, y + dy, 0.10 * size, 0.18 * size, 0.14 * size, 0.21 * size, (0, -16, 8))
                box("Floret", col, x + dx, y + dy, 0.24 * size, 0.115 * size, 0.13 * size, 0.09 * size)

        def tree(u, v, s, **kind):
            island_tree(vb, root, *place(u, v), s, **kind)

        if theme == "lavender":
            for side in (0.145, 0.851):
                for row in range(3):
                    for step in range(10):
                        u = side + (row - 1) * 0.025 + 0.018 * math.sin(step * 0.44)
                        v = 0.34 + step * 0.036 + row * 0.005
                        x, y = place(u, v)
                        hh = rng.uniform(0.22, 0.44)
                        box("Lavender foliage", "moss", x, y, 0.10, 0.18, 0.22, 0.19, (0, 0, 14))
                        box(
                            "Flower spike",
                            "lavender" if (step + row) % 3 else "lavender-hi",
                            x,
                            y,
                            hh * 0.7,
                            0.095,
                            0.10,
                            hh,
                            (0, rng.randrange(-22, 18), 0),
                        )
            tree(0.72, 0.24, 0.85)
            for u, v in ((0.26, 0.31), (0.20, 0.33)):
                x, y = place(u, v)
                for z, s in ((0.08, 0.40), (0.21, 0.36), (0.32, 0.25)):
                    box("Bee skep", "grain", x, y, z, s, s, 0.12)
                box("Entrance", "wood-lo", x, y - 0.20, 0.10, 0.09, 0.025, 0.06)
        elif theme == "meadow":
            x, y = place(0.235, 0.316)
            place_prop(root, "building_home_A_blue", (x, y, 0), (1.60, 1.38, 1.60))
            for i in range(4):
                box("Doorstep", "shale", x - 0.21 + i * 0.12, y - 0.59 - i * 0.13, 0.05, 0.23, 0.14, 0.06, (0, 0, i * 7))
            tree(0.80, 0.33, 0.93)
            for u, v in ((0.12, 0.53), (0.16, 0.63), (0.19, 0.69), (0.86, 0.65), (0.78, 0.73)):
                flowers(u, v, "flower-w" if u < 0.5 else "flower-y")
        elif theme == "orchard":
            for u, v, s in ((0.17, 0.37, 1.08), (0.34, 0.25, 0.84), (0.73, 0.26, 0.89), (0.84, 0.46, 0.98)):
                tree(u, v, s, apples=True)
            x, y = place(0.16, 0.465)
            for ox in (-0.13, 0.13):
                box("Ladder side", "wood-lo", x + ox, y, 0.44, 0.06, 0.07, 0.92, (-18, 0, 0))
            for i in range(5):
                box("Rung", "wood-hi", x, y + 0.048 * i - 0.11, 0.11 + i * 0.16, 0.29, 0.07, 0.065)
            for u, v in ((0.83, 0.64), (0.79, 0.68)):
                x, y = place(u, v)
                box("Crate", "wood", x, y, 0.14, 0.48, 0.31, 0.24)
                for j in range(3):
                    box("Apples", "apple", x + (j - 1) * 0.13, y + (j % 2 - 0.5) * 0.08, 0.28, 0.115, 0.105, 0.12, (0, 0, 16 * j))
                for side in (-1, 1):
                    box("Slat", "wood-hi", x, y + side * 0.15, 0.23, 0.53, 0.05, 0.09)
                    box("Slat", "wood-hi", x + side * 0.24, y, 0.23, 0.05, 0.34, 0.09)
        elif theme == "pines":
            for u, v, s in ((0.17, 0.42, 1.14), (0.25, 0.31, 1.21), (0.34, 0.23, 0.77), (0.72, 0.30, 1.02), (0.83, 0.37, 1.20), (0.85, 0.54, 0.78)):
                tree(u, v, s, pine=True)
            for u, v, s in ((0.19, 0.62, 0.75), (0.14, 0.61, 0.43), (0.82, 0.67, 0.56)):
                x, y = place(u, v)
                island_crown(vb, root, x, y, 0, s * 0.48, s * 0.41, "shale", 42)
            for u, v in ((0.14, 0.51), (0.84, 0.60)):
                flowers(u, v, "flower-y")
        elif theme == "pond":
            shore_points = [
                place(u, v)
                for u, v in [
                    (0.75, 0.34),
                    (0.82, 0.29),
                    (0.89, 0.34),
                    (0.93, 0.43),
                    (0.89, 0.54),
                    (0.93, 0.61),
                    (0.87, 0.67),
                    (0.81, 0.64),
                    (0.76, 0.58),
                    (0.75, 0.50),
                ]
            ]
            island_strata(
                vb,
                root,
                "Reed pond",
                shore_points,
                [(1, 0, 0, 0.009, "stone"), (1, 0, 0, 0.044, "shale"), (0.92, 0, 0, 0.054, "water"), (0.71, 0.03, 0.04, 0.060, "water-deep")],
            )
            for u, v in ((0.82, 0.40), (0.86, 0.48), (0.84, 0.54)):
                x, y = place(u, v)
                box("Lily pad", "lily", x, y, 0.085, 0.19, 0.14, 0.035, (0, 0, 25))
                box("Blossom", "lotus", x + 0.02, y, 0.13, 0.09, 0.08, 0.07)
            for u, v in ((0.78, 0.35), (0.90, 0.55), (0.79, 0.59)):
                x, y = place(u, v)
                for j in range(4):
                    box("Reed", "reed", x + j * 0.05, y, 0.17, 0.045, 0.045, 0.33 + j * 0.026, (0, j * 9 - 10, 0))
            tree(0.17, 0.36, 1.02)
            tree(0.31, 0.24, 0.67)
            for i in range(6):
                u = 0.85 + i * 0.007
                x, y = place(u, 0.673)
                box("Stream", "water-hi" if i in (1, 4) else "water", x, y, 0.06, 0.09, 0.30, 0.07)
                box("Cascade", "water-hi" if i in (1, 4) else "water", x, y - 0.14, -0.42, 0.09, 0.10, 1.0 - i * 0.03)
            for u, v in ((0.85, 0.35), (0.83, 0.45), (0.86, 0.61)):
                x, y = place(u, v)
                box("Ripple", "water-hi", x, y, 0.087, 0.23, 0.035, 0.015)
        elif theme == "windmill":
            x, y = place(0.24, 0.34)
            windmill(vb, root, x, y)
            for u, v in ((0.82, 0.37), (0.84, 0.46), (0.83, 0.56)):
                x, y = place(u, v)
                for j in range(8):
                    xx = x + rng.uniform(-0.19, 0.19)
                    yy = y + rng.uniform(-0.19, 0.19)
                    box("Wheat", "grain", xx, yy, 0.20, 0.055, 0.055, 0.39, (0, j - 8, 0))
                    box("Ear", "flower-y", xx, yy, 0.40, 0.09, 0.07, 0.18)
        export_glb(assets_dir / "models" / f"{name}.glb", multi_clip=False)
        # Map markers rotate about the original yard centre. Offset the lens centre in its own plane.
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        scale = pixels_per_unit * zoom
        target = Vector((*ground(cx, cy), 0)) - right * ((cx - w / 2) / scale) + up * ((cy - h / 2) / scale)
        setup_ortho_render(scene, w, h, target + eye * 14, target, ortho_scale=w / scale, transparent=True, samples=16)
        scene.render.filepath = str(assets_dir / "pixel" / f"{name}.png")
        bake_pixels(scene)


def build_foreground(assets_dir, sprites_meta):
    """Builds the 6 layered foreground 3D voxel foliage overlays."""
    specs = {
        "fg-branch-left": "branch-l",
        "fg-branch-right": "branch-r",
        "fg-bush-left": "bush",
        "fg-bush-right": "bush",
        "fg-fern": "fern",
        "fg-grass": "grass",
    }
    for name, kind in specs.items():
        meta = sprites_meta[name]
        w, h = int(meta["w"]), int(meta["h"])
        scene = reset_scene()
        vb = Scenery(scene, SCENE_PAL)
        root = vb.pivot(name, (0, 0, 0))
        rng = random.Random(name)
        if kind.startswith("branch"):
            side = -1 if kind == "branch-l" else 1
            vb.box(root, "Bough", "trunk", (side * 0.52, 0.06, 0.60), (1.28, 0.13, 0.15), rot_deg=(0, side * 18, 0))
            for j, (ox, oy, oz, sz) in enumerate(
                ((0.03, 0.02, 0.38, 0.62), (0.40, 0.03, 0.57, 0.91), (0.71, -0.08, 0.28, 0.57), (-0.30, 0.05, 0.39, 0.48))
            ):
                crown(vb, root, "Leaves", side * ox, oy, oz, sz, sz * 0.85, sz * 0.62, ("leaf-lo", "leaf", "leaf-hi"), rng.randrange(10000))
        elif kind == "bush":
            for ox, oy, oz, sz in (
                (-0.65, 0.10, 0.12, 0.77),
                (-0.26, 0.13, 0.35, 1.04),
                (0.33, 0.15, 0.23, 0.86),
                (0.59, -0.09, 0.10, 0.76),
                (-0.19, -0.19, 0.15, 0.76),
            ):
                crown(vb, root, "Bramble", ox, oy, oz, sz, sz * 0.88, sz * 0.74, ("leaf-lo", "leaf", "leaf-hi"), rng.randrange(10000))
            for _ in range(6):
                x, y, z = rng.uniform(-0.46, 0.40), rng.uniform(-0.51, -0.29), rng.uniform(0.38, 0.58)
                vb.box(root, "Berry", "roof-rust-hi", (x, y, z), (0.08, 0.075, 0.08))
        else:
            for j, (angle, length) in enumerate(((-61, 0.83), (-41, 1.02), (-22, 0.78), (2, 1.04), (24, 0.85), (50, 1.02), (66, 0.70))):
                base_x = rng.uniform(-0.14, 0.14)
                base_y = rng.uniform(-0.17, 0.15)
                stem = vb.pivot("Frond", (base_x, base_y, 0.04), root, rot_deg=(0, angle, rng.uniform(-19, 19)))
                vb.box(stem, "Stem", "grass-lo", (0, 0, length / 2), (0.042, 0.038, length))
                for i in range(1, 5):
                    fraction = i / 5
                    half = (0.17 if kind == "fern" else 0.080) * (1.17 - fraction * 0.69)
                    col = "grass-tip" if (i + j) % 3 == 0 else "leaf"
                    for side in (-1, 1):
                        leaf = [(0, 0), (side * half, -0.058), (side * half * 0.34, 0.066)]
                        blade = prism(vb, stem, "Leaflet", col, leaf if side == 1 else list(reversed(leaf)), 0, 0.045)
                        blade.location = (0, 0, fraction * length)
                        blade.rotation_euler[0] = 0.62

        export_glb(assets_dir / "models" / f"{name}.glb", multi_clip=False)
        pitch = math.radians(24.0)
        cam_loc = (0.0, -8.0 * math.cos(pitch), 8.0 * math.sin(pitch) + 0.45)
        setup_ortho_render(scene, w, h, cam_loc, (0.0, 0.0, 0.45), ortho_scale=2.2, transparent=True, samples=12)
        scene.render.filepath = str(assets_dir / "pixel" / f"{name}.png")
        bake_pixels(scene)


if __name__ == "__main__":
    assets_dir = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
    sprites_meta = json.loads((assets_dir / "pixel" / "sprites.json").read_text())
    build_farm_scene(assets_dir)
    build_islands(assets_dir, sprites_meta)
    build_foreground(assets_dir, sprites_meta)
    print("Built refined 3D voxel farm scene, 6 floating islands, and 6 foreground foliage assets.")
