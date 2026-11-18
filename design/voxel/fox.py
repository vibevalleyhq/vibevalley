"""Blender --background --python design/voxel/fox.py -- <output directory>."""
from math import radians, sin, tau
from pathlib import Path
import sys

import bpy
from mathutils import Vector

out = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
out.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# Colors sampled from fox-farmer-down, -side and -up in assets/pixel.
palette = {
    "fur": "f68a22", "shade": "d3671c", "cream": "fbe4b0", "cream-dark": "f2d197",
    "eye": "3f2322", "paw": "75391e", "ear": "a84f20",
    "cloth": "40789f", "seam": "32617c", "thread": "3f799f",
    "straw": "fbd065", "brim": "f2b649", "band": "334148", "gold": "f9c555",
}
def linear(c):
    c = int(c, 16) / 255
    return c / 12.92 if c < 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def material(name, color):
    m = bpy.data.materials.new(name)
    rgb = tuple(linear(color[i:i+2]) for i in (0, 2, 4))
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = 0.95
    return m

mats = {name: material(name, color) for name, color in palette.items()}

def pivot(name, position, parent=None):
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = position
    return obj

def block(parent, name, color, position, size):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.name = name
    obj.parent = parent
    obj.location = position
    obj.dimensions = size
    obj.data.materials.append(mats[color])
    return obj

root = pivot("Fox farmer", (0, 0, 0))
body = pivot("Hips", (0, 0, 0.79), root)
block(body, "Overalls", "cloth", (0, 0.02, 0.17), (0.83, 0.66, 0.68))
block(body, "Shirt", "cream", (0, 0.02, 0.56), (0.8, 0.61, 0.45))
block(body, "Bib", "cloth", (0, -0.309, 0.44), (0.72, 0.07, 0.47))
block(body, "Pocket", "seam", (0, -0.355, 0.47), (0.28, 0.04, 0.19))
block(body, "Pocket hem", "thread", (0, -0.381, 0.54), (0.28, 0.014, 0.046))
for side in (-1, 1):
    block(body, "Strap", "seam", (side*0.263, -0.3, 0.64), (0.12, 0.09, 0.32))
    block(body, "Brass button", "gold", (side*0.263, -0.356, 0.59), (0.084, 0.034, 0.084))
    strap = block(body, "Crossed back strap", "seam", (side*0.12, 0.339, 0.54), (0.12, 0.039, 0.51))
    strap.rotation_euler.y = radians(side*31)

head = pivot("Head", (0, 0, 0.74), body)
block(head, "Face", "fur", (0, -0.02, 0.37), (1.10, 0.86, 0.70))
block(head, "Jaw", "cream", (0, -0.21, 0.075), (0.69, 0.63, 0.21))
for side in (-1, 1):
    block(head, "Cheek", "cream", (side*0.374, -0.305, 0.18), (0.39, 0.36, 0.18))
    block(head, "Cheek point", "cream-dark", (side*0.529, -0.205, 0.236), (0.17, 0.28, 0.12))
    block(head, "Eye", "eye", (side*0.263, -0.467, 0.367), (0.126, 0.054, 0.160))
    block(head, "Eye glint", "cream", (side*0.263-0.031, -0.498, 0.408), (0.044, 0.01, 0.045))
block(head, "Muzzle", "cream", (0, -0.438, 0.191), (0.435, 0.27, 0.21))
block(head, "Nose", "eye", (0, -0.586, 0.25), (0.175, 0.070, 0.109))
block(head, "Hat brim", "brim", (0, 0.02, 0.64), (1.30, 0.90, 0.090))
block(head, "Hat brim front and back", "brim", (0, 0.02, 0.64), (1.10, 1.06, 0.094))
block(head, "Hat last straw row", "straw", (0, 0.02, 0.679), (1.02, 1.00, 0.026))
block(head, "Hat crown", "straw", (0, 0.04, 0.79), (0.86, 0.72, 0.23))
block(head, "Hat band", "band", (0, 0.04, 0.716), (0.89, 0.74, 0.071))
block(head, "Hat top", "straw", (0, 0.04, 0.925), (0.63, 0.62, 0.062))
for side in (-1, 1):
    ear = pivot("Ear", (side*0.476, -0.17, 0.705), head)
    ear.rotation_euler.y = radians(side*12)
    block(ear, "Ear base", "fur", (0, 0, 0.06), (0.31, 0.26, 0.20))
    block(ear, "Ear middle", "fur", (0, 0, 0.218), (0.21, 0.21, 0.17))
    block(ear, "Ear tip", "paw", (0, 0, 0.331), (0.115, 0.14, 0.105))
    block(ear, "Ear inside", "ear", (0, -0.143, 0.12), (0.128, 0.026, 0.136))

legs, arms = [], []
for side in (-1, 1):
    leg = pivot("Leg", (side*0.224, 0.01, -0.12), body)
    block(leg, "Trouser leg", "cloth", (0, 0, -0.228), (0.36, 0.45, 0.46))
    block(leg, "Trouser cuff", "seam", (0, 0, -0.41), (0.375, 0.46, 0.10))
    block(leg, "Boot", "paw", (0, -0.052, -0.55), (0.36, 0.53, 0.21))
    legs.append(leg)
    arm = pivot("Arm", (side*0.47, -0.016, 0.68), body)
    block(arm, "Sleeve", "cream", (side*0.045, 0, -0.17), (0.28, 0.37, 0.33))
    block(arm, "Forearm", "fur", (side*0.071, -0.012, -0.396), (0.255, 0.32, 0.25))
    block(arm, "Paw", "paw", (side*0.077, -0.02, -0.538), (0.23, 0.30, 0.13))
    arms.append(arm)
tail = pivot("Tail", (-0.23, 0.22, 0.02), body)
tail.rotation_euler.x = radians(10)
for pos, size, color in [
    ((-0.055,0.17,0.04),(0.26,0.35,0.28),"shade"), ((-0.13,0.38,0.12),(0.36,0.37,0.37),"fur"),
    ((-0.19,0.60,0.21),(0.42,0.38,0.41),"fur"), ((-0.22,0.79,0.29),(0.32,0.31,0.36),"cream"),
    ((-0.24,0.95,0.36),(0.20,0.20,0.25),"cream"), ((-0.24,1.045,0.42),(0.10,0.10,0.13),"cream-dark"),
]:
    block(tail, "Brush", color, pos, size)

scene.render.fps = 24
scene.frame_start, scene.frame_end = 1, 25
for frame in (1,4,7,10,13,16,19,22,25):
    phase = (frame-1)/24*tau
    for i, limb in enumerate(legs):
        limb.rotation_euler.x = radians(21)*sin(phase+i*tau/2)
        limb.keyframe_insert(data_path="rotation_euler", frame=frame)
        arms[i].rotation_euler.x = -radians(19)*sin(phase+i*tau/2)-radians(4)
        arms[i].keyframe_insert(data_path="rotation_euler", frame=frame)
    body.location.z = 0.775 - abs(sin(phase))*0.032
    body.keyframe_insert(data_path="location", frame=frame)
    tail.rotation_euler.z = radians(28) + radians(9)*sin(phase)
    tail.keyframe_insert(data_path="rotation_euler", frame=frame)
scene.frame_set(4)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=str(out/"fox-farmer.glb"), use_selection=True, export_animation_mode="SCENE", export_anim_scene_split_object=False, export_yup=True)
# These are presentation lights and floor; the exported game piece contains only the character.
bpy.ops.mesh.primitive_plane_add(size=200, location=(0,0,0))
bpy.context.object.data.materials.append(material("Studio floor", "dbddcc"))
scene.world = bpy.data.worlds.new("Ambient")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.72,0.76,0.82,1)
scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
def light(pos, energy, size):
    bpy.ops.object.light_add(type="AREA",location=pos)
    lamp=bpy.context.object
    lamp.data.energy, lamp.data.shape, lamp.data.size = energy, "DISK", size
    lamp.rotation_euler=(Vector((0,0,1))-lamp.location).to_track_quat("-Z","Y").to_euler()
light((-3,-4,6),400,5)
light((4,2,5),250,4)
bpy.ops.object.camera_add(location=(-4.25,-5.9,3.18))
cam=bpy.context.object
cam.rotation_euler=(Vector((0,0,1.18))-cam.location).to_track_quat("-Z","Y").to_euler()
cam.data.type="ORTHO"
cam.data.ortho_scale=3.19
scene.camera=cam
scene.render.engine="CYCLES"
scene.cycles.samples=12
scene.cycles.use_denoising=True
scene.render.resolution_x=scene.render.resolution_y=600
scene.render.resolution_percentage=100
scene.view_settings.view_transform="Standard"
scene.render.filepath=str(out/"fox-farmer.png")
bpy.ops.render.render(write_still=True)
