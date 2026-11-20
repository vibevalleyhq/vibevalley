"""Build the 28 animated helper models.

Usage:
    blender --background --python design/voxel/helpers.py -- assets/models
"""
from math import cos, radians, sin, tau
from pathlib import Path
import sys

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from character_rig import TOOL_PALETTE, build_expressions, build_held_tools, record_helper_clips
from core import VoxelBuilder, export_glb, reset_scene

SPECIES = ("fox", "cat", "bear", "rabbit", "owl", "hedgehog", "raccoon")
OUTFITS = ("farmer", "gardener", "rain", "winter")

OUTFIT_PALETTES = {
    "farmer": {
        "cloth": "40789f", "seam": "32617c", "thread": "5592b5",
        "shirt": "fae6b7", "hat": "fbd065", "brim": "f2b649", "band": "4f6258",
        "gold": "f9c555", "accent": "d98b32", "boot": "75391e",
    },
    "gardener": {
        "cloth": "587d52", "seam": "415f3d", "thread": "74a16c",
        "shirt": "f4e7c5", "stripe": "5f8558", "hat": "dfc189", "brim": "cba970", "band": "587d52",
        "gold": "d89d47", "glove": "d9b27a", "shorts": "d7be8f", "boot": "7a4829",
    },
    "rain": {
        "cloth": "f6d53b", "seam": "d9ad24", "thread": "fff099",
        "shirt": "f6d53b", "hat": "f6d53b", "brim": "e6ba28", "band": "d9ad24",
        "gold": "8d5628", "boot": "c9352e", "boot-hi": "eb6354",
    },
    "winter": {
        "cloth": "f4e6c8", "seam": "d8c49e", "thread": "fff7e6",
        "shirt": "f4e6c8", "hat": "f5b433", "brim": "df971d", "band": "c9352e",
        "scarf": "c9352e", "scarf-dark": "9e2521", "pants": "8c5b34", "boot": "6b3e21",
        "gold": "f5b433",
    },
}

SPECIES_PALETTES = {
    "fox": {
        "fur": "f68a22", "fur-light": "ffa647", "shade": "d3671c",
        "cream": "fbe4b0", "cream-dark": "f2d197", "eye": "3f2322", "iris": "7a3b20",
        "paw": "75391e", "ear": "a84f20", "nose": "3f2322", "blush": "f08c67",
    },
    "cat": {
        "fur": "897565", "fur-light": "a39278", "shade": "624e47",
        "cream": "fae6b7", "cream-dark": "ebd4a9", "eye": "332026", "iris": "b86e37",
        "paw": "fae6b7", "ear": "e59e52", "nose": "453233", "blush": "e39b86",
    },
    "bear": {
        "fur": "a8612b", "fur-light": "c77d3e", "shade": "7c431b",
        "cream": "f5dbb0", "cream-dark": "e2c18e", "eye": "2f1c18", "iris": "633622",
        "paw": "8c4d21", "ear": "7c431b", "nose": "3b211a", "blush": "db8463",
    },
    "rabbit": {
        "fur": "f7ecd4", "fur-light": "fff8eb", "shade": "dfd0b4",
        "cream": "fff8eb", "cream-dark": "eadbc0", "eye": "3a2324", "iris": "784840",
        "paw": "f7ecd4", "ear": "e0a896", "nose": "824c48", "blush": "f0a195",
    },
    "owl": {
        "fur": "9e602e", "fur-light": "bd7a42", "shade": "6f3f1d",
        "cream": "f6dfb1", "cream-dark": "e3c691", "eye": "2d1c19", "iris": "5c3726",
        "paw": "e39a36", "ear": "7d4a22", "nose": "e89b2d", "glass": "4a2e22", "blush": "d98b5b",
    },
    "hedgehog": {
        "fur": "f7e2bc", "fur-light": "fff1d6", "shade": "693c20",
        "quill": "7a4523", "quill-dark": "4f2a15",
        "cream": "f7e2bc", "cream-dark": "e5cb9f", "eye": "2e1c1a", "iris": "61382a",
        "paw": "c88a4b", "ear": "e3a36b", "nose": "3a221c", "blush": "f08c67",
    },
    "raccoon": {
        "fur": "b58152", "fur-light": "d1a373", "shade": "523121",
        "mask": "4d2c1e", "cream": "f5e1be", "cream-dark": "e1c79c",
        "eye": "2a1815", "iris": "613a2a", "paw": "8f5932", "ear": "6e4329", "nose": "361f18", "blush": "d98b6c",
    },
}


def carved(vb, parent, name, color, center, rings, *, tilt=(0, 0, 0), sides=8):
    """Facet adjoining elliptical cross sections into a single carved piece."""
    angles = [tau * (i + 0.5) / sides for i in range(sides)]
    vertices = [(rx * cos(a), ry * sin(a), z) for z, rx, ry in rings for a in angles]
    faces = [tuple(reversed(range(sides)))]
    for row in range(len(rings) - 1):
        for i in range(sides):
            j = (i + 1) % sides
            base = row * sides
            faces.append((base + i, base + j, base + sides + j, base + sides + i))
    faces.append(tuple(range(len(vertices) - sides, len(vertices))))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new(name, mesh)
    vb.scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = center
    obj.rotation_euler = tuple(radians(degrees) for degrees in tilt)
    mesh.materials.append(vb.mat(color))
    return obj


def build_hat(vb, head, outfit):
    if outfit == "farmer":
        brim = carved(vb, head, "Straw brim", "brim", (0, 0.035, 0.65),
                      ((-0.04, 0.61, 0.49), (0.0, 0.76, 0.60), (0.055, 0.69, 0.55)), sides=12)
        carved(vb, brim, "Straw crown", "hat", (0, 0.04, 0.03),
               ((0.0, 0.54, 0.46), (0.11, 0.47, 0.40), (0.22, 0.40, 0.34), (0.27, 0.28, 0.25)), sides=12)
        carved(vb, brim, "Woven hatband", "band", (0, 0.04, 0.07),
               ((0.0, 0.54, 0.46), (0.076, 0.49, 0.42)), sides=12)
    elif outfit == "gardener":
        vb.box(head, "Hat brim", "brim", (0, 0.01, 0.63), (1.42, 1.04, 0.085))
        vb.box(head, "Hat brim fb", "brim", (0, 0.01, 0.63), (1.20, 1.16, 0.088), shade=0.03)
        vb.box(head, "Hat band", "band", (0, 0.03, 0.715), (0.91, 0.77, 0.085))
        vb.box(head, "Hat bow", "gold", (0.44, -0.18, 0.72), (0.12, 0.14, 0.08))
        vb.box(head, "Hat crown", "hat", (0, 0.03, 0.795), (0.88, 0.74, 0.20))
        vb.box(head, "Hat top", "hat", (0, 0.03, 0.915), (0.68, 0.62, 0.065), shade=0.05)
    elif outfit == "rain":
        vb.box(head, "Rain brim", "brim", (0, 0.02, 0.63), (1.38, 1.00, 0.085))
        vb.box(head, "Rain brim fb", "brim", (0, 0.02, 0.63), (1.18, 1.14, 0.09))
        vb.box(head, "Rain crown", "hat", (0, 0.03, 0.78), (0.91, 0.77, 0.26))
        vb.box(head, "Rain shine", "thread", (-0.20, -0.34, 0.84), (0.28, 0.04, 0.09))
        vb.box(head, "Rain top", "hat", (0, 0.03, 0.935), (0.66, 0.60, 0.075), shade=0.05)
    elif outfit == "winter":
        vb.box(head, "Beanie cuff", "brim", (0, 0.01, 0.66), (1.18, 0.96, 0.19))
        # Ribbed knit stripes along beanie cuff
        for rx in (-0.42, -0.21, 0.0, 0.21, 0.42):
            vb.box(head, "KnitRib", "hat", (rx, -0.47, 0.66), (0.09, 0.04, 0.19), shade=0.06)
        vb.box(head, "Beanie stripe", "band", (0, 0.02, 0.78), (1.02, 0.84, 0.07))
        vb.box(head, "Beanie dome", "hat", (0, 0.02, 0.86), (0.94, 0.80, 0.18))
        vb.box(head, "Beanie top", "hat", (0, 0.02, 0.97), (0.66, 0.60, 0.09), shade=0.04)
        vb.box(head, "Pompom", "hat", (0, 0.02, 1.09), (0.29, 0.29, 0.24), shade=0.08)


def build_body_and_limbs(vb, body, outfit):
    if outfit == "farmer":
        carved(vb, body, "Overalls", "cloth", (0, 0.02, 0.15),
               ((-0.31, 0.42, 0.34), (-0.15, 0.50, 0.40), (0.16, 0.48, 0.38), (0.32, 0.40, 0.32)))
        vb.box(body, "Shirt", "shirt", (0, 0.02, 0.56), (0.80, 0.61, 0.45))
        vb.box(body, "Collar", "shirt", (0, -0.27, 0.70), (0.48, 0.10, 0.10), shade=0.06)
        vb.box(body, "Bib", "cloth", (0, -0.309, 0.44), (0.60, 0.07, 0.43))
        vb.box(body, "Pocket", "seam", (0, -0.355, 0.45), (0.31, 0.045, 0.22))
        vb.box(body, "Pocket hem", "thread", (0, -0.381, 0.54), (0.31, 0.015, 0.04))
        for side in (-1, 1):
            vb.box(body, "Strap", "seam", (side * 0.26, -0.30, 0.64), (0.12, 0.09, 0.32))
            vb.box(body, "Button", "gold", (side * 0.26, -0.358, 0.58), (0.10, 0.04, 0.10))
            vb.box(body, "HipBtn", "gold", (side * 0.41, -0.24, 0.38), (0.06, 0.06, 0.06))
            vb.box(body, "Back strap", "seam", (side * 0.12, 0.339, 0.54), (0.12, 0.04, 0.51), rot_deg=(0, side * 31, 0))
    elif outfit == "gardener":
        vb.box(body, "Apron", "cloth", (0, 0.02, 0.22), (0.86, 0.67, 0.72))
        vb.box(body, "Shirt", "shirt", (0, 0.02, 0.58), (0.80, 0.61, 0.40))
        vb.box(body, "Apron bib", "cloth", (0, -0.312, 0.46), (0.70, 0.07, 0.48))
        vb.box(body, "Apron pocket", "seam", (0, -0.358, 0.36), (0.36, 0.05, 0.24))
        vb.box(body, "Pocket trim", "thread", (0, -0.386, 0.46), (0.36, 0.015, 0.04))
        # Little trowel tucked into gardener pocket
        vb.box(body, "TrowelH", "boot", (0.12, -0.38, 0.52), (0.07, 0.06, 0.14), rot_deg=(0, 12, 0))
        for side in (-1, 1):
            vb.box(body, "Strap", "seam", (side * 0.25, -0.30, 0.66), (0.11, 0.09, 0.28))
            vb.box(body, "Button", "gold", (side * 0.25, -0.356, 0.58), (0.085, 0.038, 0.085))
    elif outfit == "rain":
        vb.box(body, "Coat lower", "cloth", (0, 0.01, 0.17), (0.96, 0.76, 0.66))
        vb.box(body, "Coat upper", "cloth", (0, 0.01, 0.55), (0.86, 0.68, 0.46))
        vb.box(body, "Collar", "seam", (0, -0.02, 0.74), (0.94, 0.76, 0.13))
        vb.box(body, "Placket", "seam", (0, -0.36, 0.36), (0.09, 0.045, 0.68))
        for z in (0.28, 0.52):
            vb.box(body, "Toggle", "gold", (0, -0.382, z), (0.25, 0.055, 0.08))
        for side in (-1, 1):
            vb.box(body, "Pocket", "seam", (side * 0.27, -0.375, 0.16), (0.23, 0.045, 0.21))
            vb.box(body, "PockFlap", "thread", (side * 0.27, -0.39, 0.25), (0.24, 0.035, 0.05))
    elif outfit == "winter":
        vb.box(body, "Sweater", "cloth", (0, 0.02, 0.36), (0.88, 0.68, 0.78))
        # Cable-knit vertical ribs on sweater front
        for rx in (-0.24, 0.0, 0.24):
            vb.box(body, "Cable", "thread", (rx, -0.33, 0.34), (0.09, 0.035, 0.64))
        vb.box(body, "Sweater hem", "seam", (0, 0.02, -0.02), (0.91, 0.71, 0.11))
        vb.box(body, "Scarf wrap", "scarf", (0, -0.02, 0.72), (0.96, 0.78, 0.19))
        vb.box(body, "Scarf fold", "scarf-dark", (0, -0.40, 0.68), (0.86, 0.04, 0.06))
        vb.box(body, "Scarf tail", "scarf", (0.22, -0.39, 0.43), (0.24, 0.085, 0.42))
        vb.box(body, "Scarf stripe", "scarf-dark", (0.22, -0.415, 0.32), (0.24, 0.04, 0.06))
        for fx in (0.14, 0.22, 0.30):
            vb.box(body, "Fringe", "gold", (fx, -0.39, 0.19), (0.05, 0.05, 0.09))

    legs, arms = [], []
    for side in (-1, 1):
        leg = vb.pivot(f"Leg_{'L' if side < 0 else 'R'}", (side * 0.245, 0.01, -0.12), body)
        if outfit == "farmer":
            vb.box(leg, "Trouser", "cloth", (0, 0, -0.22), (0.36, 0.45, 0.45))
            vb.box(leg, "Cuff", "seam", (0, 0, -0.40), (0.38, 0.47, 0.10))
            vb.box(leg, "Foot", "paw", (0, -0.055, -0.545), (0.38, 0.54, 0.21))
        elif outfit == "gardener":
            vb.box(leg, "Shorts", "shorts", (0, 0, -0.18), (0.37, 0.45, 0.34))
            vb.box(leg, "ShortCuff", "shorts", (0, 0, -0.33), (0.39, 0.47, 0.06), shade=-0.08)
            vb.box(leg, "Shin", "fur", (0, 0, -0.41), (0.32, 0.38, 0.15))
            vb.box(leg, "Foot", "paw", (0, -0.055, -0.545), (0.38, 0.54, 0.21))
        elif outfit == "rain":
            vb.box(leg, "Boot shaft", "boot", (0, 0, -0.28), (0.36, 0.44, 0.42))
            vb.box(leg, "Boot rim", "boot-hi", (0, 0, -0.09), (0.39, 0.47, 0.06))
            vb.box(leg, "Boot toe", "boot", (0, -0.06, -0.535), (0.38, 0.54, 0.21))
            vb.box(leg, "Boot shine", "boot-hi", (-0.06, -0.27, -0.49), (0.14, 0.04, 0.09))
        elif outfit == "winter":
            vb.box(leg, "Pants", "pants", (0, 0, -0.22), (0.37, 0.45, 0.42))
            vb.box(leg, "Boot cuff", "cloth", (0, 0, -0.40), (0.41, 0.49, 0.09))
            vb.box(leg, "Boot", "boot", (0, -0.055, -0.54), (0.39, 0.54, 0.21))
        legs.append(leg)

        arm = vb.pivot(f"Arm_{'L' if side < 0 else 'R'}", (side * 0.47, -0.016, 0.68), body)
        if outfit == "farmer":
            vb.box(arm, "Sleeve", "shirt", (side * 0.045, 0, -0.165), (0.28, 0.37, 0.33))
            vb.box(arm, "Forearm", "fur", (side * 0.07, -0.012, -0.39), (0.255, 0.32, 0.24))
            vb.box(arm, "Paw", "paw", (side * 0.075, -0.02, -0.535), (0.245, 0.31, 0.145))
        elif outfit == "gardener":
            vb.box(arm, "Sleeve", "shirt", (side * 0.045, 0, -0.165), (0.28, 0.37, 0.33))
            vb.box(arm, "Stripe", "stripe", (side * 0.046, 0, -0.165), (0.298, 0.385, 0.09))
            vb.box(arm, "GloveCuff", "glove", (side * 0.070, -0.014, -0.33), (0.28, 0.34, 0.08), shade=-0.06)
            vb.box(arm, "Glove", "glove", (side * 0.074, -0.016, -0.46), (0.26, 0.32, 0.24))
        elif outfit == "rain":
            vb.box(arm, "Sleeve", "cloth", (side * 0.055, 0, -0.25), (0.30, 0.38, 0.46))
            vb.box(arm, "Cuff", "seam", (side * 0.065, -0.01, -0.45), (0.315, 0.395, 0.07))
            vb.box(arm, "Paw", "paw", (side * 0.075, -0.02, -0.54), (0.24, 0.30, 0.14))
        elif outfit == "winter":
            vb.box(arm, "Sleeve", "cloth", (side * 0.055, 0, -0.24), (0.30, 0.38, 0.45))
            vb.box(arm, "Cuff", "seam", (side * 0.065, -0.01, -0.44), (0.315, 0.395, 0.07))
            vb.box(arm, "Paw", "paw", (side * 0.075, -0.02, -0.54), (0.24, 0.30, 0.14))
        arms.append(arm)

    return legs, arms


def build_species_head_and_tail(vb, head, body, species):
    """Builds refined species head geometry + tail, returning `(tail, expr_params)`."""
    tail = None
    expr_params = dict(face_y=-0.468, eye_x=0.265, eye_z=0.365)

    if species == "fox":
        carved(vb, head, "Russet head", "fur", (0, -0.015, 0),
               ((0.02, 0.27, 0.30), (0.17, 0.48, 0.44), (0.36, 0.62, 0.50),
                (0.55, 0.57, 0.49), (0.70, 0.41, 0.37)))
        carved(vb, head, "White chin", "cream", (0, -0.28, 0.06),
               ((-0.05, 0.19, 0.17), (0.04, 0.35, 0.26), (0.15, 0.39, 0.25)))
        carved(vb, head, "Pointed muzzle", "cream", (0, -0.405, 0.20),
               ((-0.09, 0.18, 0.18), (0.0, 0.26, 0.25), (0.09, 0.18, 0.21)))
        carved(vb, head, "Fox nose", "nose", (0, -0.605, 0.245),
               ((-0.055, 0.038, 0.04), (0.015, 0.104, 0.068), (0.057, 0.09, 0.065)))
        for side in (-1, 1):
            carved(vb, head, "Ruff", "cream", (side * 0.43, -0.20, 0.19),
                   ((-0.08, 0.10, 0.14), (0.0, 0.23, 0.25), (0.12, 0.19, 0.24)),
                   tilt=(0, side * 18, 0))
            ear = vb.pivot("Ear", (side * 0.43, -0.10, 0.63), head, rot_deg=(0, side * 23, 0))
            carved(vb, ear, "Ears", "fur", (0, 0, 0), ((0, 0.195, 0.15), (0.21, 0.17, 0.13), (0.48, 0.09, 0.08)))
            carved(vb, ear, "Dark ear point", "paw", (0, 0, 0), ((0.43, 0.097, 0.087), (0.59, 0.025, 0.035)))
            carved(vb, ear, "Inner ear", "cream-dark", (0, -0.095, 0),
                   ((0.16, 0.093, 0.051), (0.29, 0.105, 0.046), (0.43, 0.035, 0.026)))
        tail = vb.pivot("Tail", (-0.25, 0.37, -0.14), body, rot_deg=(-61, -25, 0))
        carved(vb, tail, "Fox brush", "fur", (0, 0, 0),
               ((0, 0.125, 0.12), (0.20, 0.22, 0.19), (0.57, 0.31, 0.295), (0.84, 0.235, 0.23)))
        carved(vb, tail, "White tail tip", "cream", (0, 0, 0),
               ((0.81, 0.25, 0.245), (0.98, 0.22, 0.205), (1.14, 0.12, 0.12), (1.24, 0.036, 0.048)))

    elif species == "cat":
        vb.box(head, "Face", "fur", (0, -0.02, 0.37), (1.14, 0.88, 0.70))
        vb.box(head, "Blaze lo", "cream", (0, -0.455, 0.33), (0.28, 0.05, 0.22))
        vb.box(head, "Blaze hi", "cream", (0, -0.455, 0.48), (0.14, 0.05, 0.14))
        vb.box(head, "Jaw", "cream", (0, -0.24, 0.11), (0.86, 0.62, 0.24))
        vb.box(head, "Muzzle", "cream", (0, -0.455, 0.20), (0.50, 0.16, 0.22))
        vb.box(head, "Nose", "nose", (0, -0.545, 0.255), (0.13, 0.055, 0.085))
        vb.box(head, "Mouth", "nose", (0, -0.540, 0.165), (0.22, 0.03, 0.04))
        expr_params = dict(face_y=-0.468, eye_x=0.285, eye_z=0.360)
        for side in (-1, 1):
            vb.box(head, "Cheek", "cream", (side * 0.39, -0.31, 0.17), (0.38, 0.34, 0.20))
            vb.box(head, "Tuft lo", "fur-light", (side * 0.56, -0.10, 0.19), (0.14, 0.26, 0.13))
            vb.box(head, "Tuft hi", "fur", (side * 0.57, -0.06, 0.32), (0.12, 0.28, 0.12))
            ear = vb.pivot("Ear", (side * 0.46, -0.14, 0.69), head, rot_deg=(0, side * 15, 0))
            vb.box(ear, "Ear base", "fur", (0, 0, 0.07), (0.32, 0.24, 0.20))
            vb.box(ear, "Ear mid", "shade", (0, 0, 0.21), (0.22, 0.19, 0.15))
            vb.box(ear, "Ear tip", "shade", (0, 0, 0.31), (0.12, 0.13, 0.09))
            vb.box(ear, "Ear in", "ear", (0, -0.125, 0.125), (0.15, 0.03, 0.16))
        tail = vb.pivot("Tail", (-0.18, 0.30, 0.08), body, rot_deg=(8, 0, 0))
        for pos, size, col in [
            ((-0.06, 0.14, 0.02), (0.20, 0.26, 0.20), "shade"),
            ((-0.14, 0.34, 0.06), (0.21, 0.26, 0.21), "fur"),
            ((-0.22, 0.50, 0.18), (0.21, 0.24, 0.24), "fur"),
            ((-0.26, 0.56, 0.36), (0.22, 0.22, 0.26), "fur-light"),
            ((-0.27, 0.56, 0.55), (0.23, 0.23, 0.22), "cream"),
            ((-0.27, 0.55, 0.66), (0.16, 0.16, 0.10), "cream-dark"),
        ]:
            vb.box(tail, "Tail seg", col, pos, size)

    elif species == "bear":
        vb.box(head, "Face", "fur", (0, -0.02, 0.37), (1.18, 0.92, 0.72))
        vb.box(head, "Muzzle", "cream", (0, -0.49, 0.21), (0.52, 0.20, 0.28))
        vb.box(head, "Nose", "nose", (0, -0.60, 0.29), (0.20, 0.07, 0.11))
        vb.box(head, "Mouth", "nose", (0, -0.595, 0.17), (0.22, 0.03, 0.04))
        expr_params = dict(face_y=-0.485, eye_x=0.28, eye_z=0.38)
        for side in (-1, 1):
            ear = vb.pivot("Ear", (side * 0.49, -0.08, 0.72), head)
            vb.box(ear, "Ear outer", "fur", (0, 0, 0.08), (0.31, 0.22, 0.27))
            vb.box(ear, "Ear inner", "ear", (0, -0.10, 0.08), (0.17, 0.05, 0.15))
        tail = vb.pivot("Tail", (0.0, 0.36, 0.08), body)
        vb.box(tail, "Stub", "shade", (0, 0.08, 0), (0.26, 0.24, 0.24))

    elif species == "rabbit":
        carved(vb, head, "Rabbit head", "fur", (0, -0.03, 0),
               ((0.01, 0.31, 0.30), (0.17, 0.54, 0.45), (0.37, 0.56, 0.48),
                (0.56, 0.48, 0.43), (0.70, 0.31, 0.32)))
        expr_params = dict(face_y=-0.455, eye_x=0.23, eye_z=0.38)
        for side in (-1, 1):
            carved(vb, head, "Muzzle", "fur-light", (side * 0.128, -0.43, 0.18),
                   ((-0.07, 0.10, 0.07), (0.005, 0.17, 0.12), (0.105, 0.115, 0.085)))
            ear = vb.pivot("Ear", (side * 0.34, -0.025, 0.63), head,
                           rot_deg=(6 if side < 0 else -8, side * (22 if side < 0 else 9), 0))
            carved(vb, ear, "Rabbit ear", "fur", (0, 0, 0),
                   ((0, 0.105, 0.09), (0.21, 0.16, 0.115), (0.64, 0.165, 0.11),
                    (0.81, 0.11, 0.085), (0.86, 0.05, 0.048)))
            carved(vb, ear, "Rose ear", "ear", (0, -0.085, 0),
                   ((0.20, 0.057, 0.038), (0.36, 0.092, 0.048), (0.65, 0.09, 0.043), (0.75, 0.035, 0.03)))
        carved(vb, head, "Rabbit nose", "nose", (0, -0.535, 0.258),
               ((-0.043, 0.035, 0.025), (0.022, 0.077, 0.038)))
        tail = vb.pivot("Tail", (0, 0.35, 0.03), body)
        carved(vb, tail, "Cottontail", "fur-light", (0, 0.11, 0.05),
               ((-0.12, 0.10, 0.10), (0.015, 0.22, 0.19), (0.13, 0.18, 0.16), (0.18, 0.085, 0.08)))

    elif species == "owl":
        vb.box(head, "Face", "fur", (0, -0.02, 0.37), (1.16, 0.90, 0.70))
        vb.box(head, "Beak", "nose", (0, -0.54, 0.24), (0.18, 0.18, 0.22))
        vb.box(head, "Bridge", "glass", (0, -0.498, 0.37), (0.18, 0.04, 0.055))
        expr_params = dict(face_y=-0.551, eye_x=0.267, eye_z=0.37)
        for side in (-1, 1):
            carved(vb, head, "Eye ring", "glass", (side * 0.267, -0.485, 0.37),
                   ((-0.02, 0.24, 0.24), (0.04, 0.242, 0.24)), tilt=(90, 0, 0))
            carved(vb, head, "Eye disc", "cream", (side * 0.267, -0.525, 0.37),
                   ((0, 0.201, 0.206), (0.022, 0.20, 0.20)), tilt=(90, 0, 0))
            vb.box(head, "Tuft", "fur-light", (side * 0.58, -0.08, 0.42), (0.14, 0.28, 0.14))
            ear = vb.pivot("Ear", (side * 0.46, -0.06, 0.71), head, rot_deg=(0, side * 16, 0))
            vb.box(ear, "Horn", "ear", (0, 0, 0.09), (0.22, 0.18, 0.22))
        tail = vb.pivot("Tail", (0.0, 0.36, 0.05), body)
        vb.box(tail, "Feathers", "shade", (0, 0.12, -0.04), (0.46, 0.26, 0.12), rot_deg=(-20, 0, 0))

    elif species == "hedgehog":
        vb.box(head, "Face", "fur", (0, -0.06, 0.36), (1.06, 0.80, 0.66))
        vb.box(head, "Brow peak", "quill", (0, -0.465, 0.56), (0.34, 0.05, 0.18))
        vb.box(head, "Quill crown", "quill", (0, 0.14, 0.40), (1.30, 0.74, 0.84))
        vb.box(head, "Quill back", "quill-dark", (0, 0.34, 0.36), (1.18, 0.44, 0.74))
        vb.box(head, "Nose", "nose", (0, -0.50, 0.25), (0.14, 0.09, 0.10))
        expr_params = dict(face_y=-0.468, eye_x=0.25, eye_z=0.355)
        for side in (-1, 1):
            ear = vb.pivot("Ear", (side * 0.47, -0.18, 0.56), head)
            vb.box(ear, "Ear", "ear", (0, 0, 0.04), (0.20, 0.14, 0.22))
            for idx, z in enumerate((0.14, 0.32, 0.50, 0.64)):
                col = "quill" if idx % 2 == 0 else "quill-dark"
                vb.box(head, "Spike", col, (side * 0.68, 0.06 + idx * 0.04, z), (0.24, 0.24, 0.15), rot_deg=(0, side * (14 + idx * 5), 0))
        tail = vb.pivot("Tail", (0.0, 0.36, 0.06), body)
        vb.box(tail, "Quill tail", "quill-dark", (0, 0.08, 0), (0.20, 0.16, 0.16))

    elif species == "raccoon":
        vb.box(head, "Face", "fur", (0, -0.02, 0.37), (1.16, 0.88, 0.70))
        vb.box(head, "Muzzle", "cream", (0, -0.46, 0.20), (0.50, 0.18, 0.22))
        vb.box(head, "Nose", "nose", (0, -0.565, 0.26), (0.16, 0.065, 0.10))
        expr_params = dict(face_y=-0.486, eye_x=0.27, eye_z=0.365)
        for side in (-1, 1):
            vb.box(head, "Mask", "mask", (side * 0.28, -0.456, 0.355), (0.42, 0.055, 0.28))
            vb.box(head, "Cheek", "fur-light", (side * 0.44, -0.28, 0.18), (0.34, 0.34, 0.18))
            ear = vb.pivot("Ear", (side * 0.46, -0.10, 0.70), head)
            vb.box(ear, "Ear outer", "fur", (0, 0, 0.08), (0.28, 0.20, 0.24))
            vb.box(ear, "Ear inner", "ear", (0, -0.09, 0.08), (0.15, 0.04, 0.14))
        tail = vb.pivot("Tail", (-0.20, 0.24, 0.04), body, rot_deg=(12, 0, 0))
        for pos, size, col in [
            ((-0.06, 0.16, 0.04), (0.28, 0.32, 0.28), "fur"),
            ((-0.13, 0.36, 0.12), (0.36, 0.34, 0.36), "shade"),
            ((-0.19, 0.56, 0.21), (0.40, 0.34, 0.40), "fur-light"),
            ((-0.23, 0.76, 0.29), (0.36, 0.32, 0.36), "shade"),
            ((-0.25, 0.94, 0.36), (0.26, 0.24, 0.26), "fur"),
            ((-0.26, 1.05, 0.41), (0.16, 0.16, 0.16), "shade"),
        ]:
            vb.box(tail, "Stripe", col, pos, size)

    return tail, expr_params


def build_helper(species, outfit, out_path):
    scene = reset_scene()
    palette = {**TOOL_PALETTE, **OUTFIT_PALETTES[outfit], **SPECIES_PALETTES[species]}
    vb = VoxelBuilder(scene, palette)

    root = vb.pivot(f"{species}-{outfit}", (0, 0, 0))
    body_depth, body_width = {"bear": (1.12, 1.14), "owl": (1.09, 1.12), "rabbit": (0.94, 0.91)}.get(species, (1.0, 1.0))
    body = vb.pivot("Hips", (0, 0, 0.59), root)
    body.scale = (body_width, body_depth, 0.76)
    head = vb.pivot("Head", (0, 0, 0.73), body)
    head.scale = (1.05 / body_width, 1.05 / body_depth, 1.05 / 0.76)

    legs, arms = build_body_and_limbs(vb, body, outfit)
    tail, expr_params = build_species_head_and_tail(vb, head, body, species)
    build_hat(vb, head, outfit)
    exprs = build_expressions(vb, head, **expr_params)
    tools = build_held_tools(vb, arms[1], body)
    record_helper_clips(scene, body, head, legs, arms, tail, exprs, tools)
    export_glb(out_path, multi_clip=True)


if __name__ == "__main__":
    out_dir = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
    for sp in SPECIES:
        for of in OUTFITS:
            build_helper(sp, of, out_dir / f"{sp}-{of}.glb")
    print(f"Exported {len(SPECIES) * len(OUTFITS)} refined multi-clip helper models to {out_dir}")
