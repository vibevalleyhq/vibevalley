"""Bake the visible LDtk building areas and their ground depth through the farm camera."""

from math import floor

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


AREA_IDS = {"skills": 1, "manager": 2, "runtimes": 3}


def write_landmark_mask(scene, landmarks, path):
    if landmarks.keys() != AREA_IDS.keys():
        raise ValueError(f"Expected farm building groups {tuple(AREA_IDS)}, got {tuple(landmarks)}")
    object_ids = {obj: AREA_IDS[spot] for spot, objects in landmarks.items() for obj in objects}
    width, height = 384, 256
    camera = scene.camera
    bpy.context.view_layer.update()
    camera_world = camera.matrix_world
    frame = camera.data.view_frame(scene=scene)
    left, right = min(p.x for p in frame), max(p.x for p in frame)
    bottom, top = min(p.y for p in frame), max(p.y for p in frame)
    dx, dy = (right - left) / width, (top - bottom) / height
    direction = camera_world.to_quaternion() @ Vector((0, 0, -1))
    world_to_camera = camera_world.inverted()

    vertices, triangles, surface_ids = [], [], []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in scene.objects:
        if obj.type != "MESH" or obj.hide_render:
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.data
        mesh.calc_loop_triangles()
        offset = len(vertices)
        transform = evaluated.matrix_world
        vertices.extend(transform @ v.co for v in mesh.vertices)
        triangles.extend(tuple(offset + i for i in tri.vertices) for tri in mesh.loop_triangles)
        surface_ids.extend([object_ids.get(obj, 0)] * len(mesh.loop_triangles))
    bvh = BVHTree.FromPolygons(vertices, triangles, all_triangles=True)

    pixels = [0.0, 0.0, 0.0, 1.0] * (width * height)
    visible = set()
    for y in range(height):
        for x in range(width):
            origin = camera_world @ Vector((left + (x + 0.5) * dx, top - (y + 0.5) * dy, -camera.data.clip_start))
            hit, _, triangle, _ = bvh.ray_cast(origin, direction, camera.data.clip_end)
            if triangle is None or not (area_id := surface_ids[triangle]):
                continue
            ground = world_to_camera @ Vector((hit.x, hit.y, 0))
            ground_row = min(height - 1, max(0, floor((top - ground.y) / dy)))
            # Blender's image buffer starts at the bottom. The stored depth uses top-left map coordinates.
            i = ((height - 1 - y) * width + x) * 4
            pixels[i] = area_id / 255
            pixels[i + 1] = ground_row / 255
            visible.add(area_id)
    if visible != set(AREA_IDS.values()):
        raise ValueError(f"Farm camera failed to see all three building areas: {visible}")
    mask = bpy.data.images.new("Farm building hits", width, height, alpha=False, is_data=True)
    try:
        mask.pixels.foreach_set(pixels)
        mask.file_format = "PNG"
        mask.filepath_raw = str(path)
        mask.save()
    finally:
        bpy.data.images.remove(mask)
