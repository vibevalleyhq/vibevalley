"""Bake the farm's common surface textures onto KayKit's palette-mapped meshes."""

from collections import Counter
from hashlib import blake2s
from math import atan2, tau
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

from core import _hex_to_rgb, _srgb_to_linear

SOURCES = Path(__file__).with_name("kaykit_assets")
TEXTURES = Path(__file__).with_name("materials")
SURFACE_UV = "ValleySurface"
PALETTE_UV = "KitPalette"
SURFACE_COLORS = {
    "slate": "4c8387",
    "oak": "ab774a",
    "brick": "9c6954",
    "stone": "9d9078",
}
FLAT_COLORS = {
    "plaster": "e4d3b0",
    "iron": "414e54",
    "darkstone": "746e64",
    "water": "669c9e",
    "coal": "ffa249",
    "needles": "4c774d",
    "needles-light": "6a905b",
}


def _material(role):
    name = f"Farm surface {role}"
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.83
    color = SURFACE_COLORS.get(role) or FLAT_COLORS.get(role) or "ffffff"
    linear = tuple(_srgb_to_linear(v) for v in _hex_to_rgb(color)) + (1.0,)
    material.diffuse_color = linear
    bsdf.inputs["Base Color"].default_value = linear
    if role == "coal":
        bsdf.inputs["Emission Color"].default_value = linear
        bsdf.inputs["Emission Strength"].default_value = 1.0
    if role in SURFACE_COLORS or role == "palette":
        path = SOURCES / "hexagons_medieval.png" if role == "palette" else TEXTURES / f"{role}.png"
        texture = material.node_tree.nodes.new("ShaderNodeTexImage")
        texture.image = bpy.data.images.load(str(path), check_existing=True)
        texture.interpolation = "Linear" if role == "palette" else "Closest"
        coordinates = material.node_tree.nodes.new("ShaderNodeUVMap")
        coordinates.uv_map = PALETTE_UV if role == "palette" else SURFACE_UV
        material.node_tree.links.new(coordinates.outputs["UV"], texture.inputs["Vector"])
        material.node_tree.links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    return material


def surface_material(role):
    if role not in SURFACE_COLORS:
        raise ValueError(f"Unknown farm surface: {role}")
    return _material(role)


def _plane_axes(normal):
    if abs(normal.z) > 0.7:
        return (0, 1)
    return (1, 2) if abs(normal.x) > abs(normal.y) else (0, 2)


def texture_objects(objects, role, tile_size=1.0):
    material = surface_material(role)
    width, height = (tile_size, tile_size) if isinstance(tile_size, (int, float)) else tile_size
    bpy.context.view_layer.update()
    for obj in objects:
        if obj.type != "MESH":
            continue
        # Scenery also keeps single-user cubes as templates for parts it will place later.
        obj.data = obj.data.copy()
        mesh = obj.data
        uv = mesh.uv_layers.get(SURFACE_UV) or mesh.uv_layers.new(name=SURFACE_UV, do_init=False)
        points = [obj.matrix_world @ v.co for v in mesh.vertices]
        normal_matrix = obj.matrix_world.to_3x3().inverted_safe().transposed()
        for face in mesh.polygons:
            face.material_index = 0
            axes = _plane_axes((normal_matrix @ face.normal).normalized())
            if role == "oak":
                spans = [max(points[i][ax] for i in face.vertices) - min(points[i][ax] for i in face.vertices) for ax in axes]
                if spans[1] > spans[0]:
                    axes = axes[::-1]
            for i in face.loop_indices:
                p = points[mesh.loops[i].vertex_index]
                uv.data[i].uv = (p[axes[0]] / width, p[axes[1]] / height)
        mesh.materials.clear()
        mesh.materials.append(material)
        mesh.update()


def _components(mesh):
    # The glTF exporter splits positions on hard edges and palette seams.
    parents = list(range(len(mesh.polygons)))
    first = {}

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for face in mesh.polygons:
        for i in face.vertices:
            position = tuple(round(v, 4) for v in mesh.vertices[i].co)
            if position in first:
                parents[root(face.index)] = root(first[position])
            else:
                first[position] = face.index
    return [root(i) for i in range(len(parents))]


def _smith_role(cell, on_furnace, z):
    col, row = cell
    if row == 3:
        return "slate" if col < 2 else "coal"
    if row == 1:
        return "water" if col < 2 else "darkstone"
    if col in (10, 11, 12, 13):
        return "oak"
    if col in (2, 3):
        return "plaster"
    if col in (6, 7):
        return "iron"
    if col == 4:
        return "brick" if on_furnace and 0.183 < z < 0.85 else "stone"
    return "darkstone"


def _dress(mesh, slots, smith):
    original = mesh.uv_layers.active
    if original is None:
        raise ValueError(f"{mesh.name} lacks its source palette UVs")
    original.name = PALETTE_UV
    cells = []
    for face in mesh.polygons:
        u, v = sum((original.data[i].uv for i in face.loop_indices), Vector((0, 0))) / len(face.loop_indices)
        cells.append((min(int(u * 16), 15), min(int((1 - v) * 4), 3)))
    uv = mesh.uv_layers.new(name=SURFACE_UV, do_init=False)
    mesh.materials.clear()
    material_indexes = {}
    if smith:
        components = _components(mesh)
        # The round kiln is the largest contiguous component of the pinned blacksmith asset.
        kiln = Counter(components).most_common(1)[0][0]
    for face, cell in zip(mesh.polygons, cells):
        role = _smith_role(cell, components[face.index] == kiln, face.center.z) if smith else slots.get(cell, "palette")
        if role not in material_indexes:
            material_indexes[role] = len(mesh.materials)
            mesh.materials.append(_material(role))
        face.material_index = material_indexes[role]
        if role not in SURFACE_COLORS:
            continue
        u_axis, v_axis = _plane_axes(face.normal)
        arc_start = None
        for i in face.loop_indices:
            p = mesh.vertices[mesh.loops[i].vertex_index].co
            if smith and role == "slate":
                u, v = p.x / 0.37, p.z / 0.27
            elif smith and role == "brick":
                arc = atan2(p.y - 0.15, p.x - 0.21) / tau
                if arc_start is None:
                    arc_start = arc
                arc -= round(arc - arc_start)
                u, v = arc * 4.0, p.z / 0.62
            else:
                u, v = p[u_axis] * 1.9, p[v_axis] * 1.9
            uv.data[i].uv = (u, v)
    mesh.update()


def _instance(name, slots, smith=False):
    variant = blake2s(repr((smith, sorted(slots.items()))).encode(), digest_size=4).hexdigest()
    mesh_name = f"KayKit {name} {variant}"
    mesh = bpy.data.meshes.get(mesh_name)
    if mesh is not None:
        instance = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(instance)
        return instance
    existing = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(SOURCES / f"{name}.gltf"))
    imported = set(bpy.data.objects) - existing
    parts = sorted((obj for obj in imported if obj.type == "MESH"), key=lambda obj: obj.name)
    if not parts:
        raise ValueError(f"KayKit {name} contains no mesh")
    transforms = [part.matrix_world.copy() for part in parts]
    for part, transform in zip(parts, transforms):
        part.parent = None
        if part.data.users > 1:
            part.data = part.data.copy()
        part.data.transform(transform)
        part.matrix_world = Matrix.Identity(4)
    for empty in imported.difference(parts):
        bpy.data.objects.remove(empty, do_unlink=True)
    obj = parts[0]
    if len(parts) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for part in parts:
            part.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.join()
        obj.name = name
    mesh = obj.data
    mesh.update()
    _dress(mesh, slots, smith)
    mesh.name = mesh_name
    return obj


def blacksmith():
    return _instance("building_blacksmith_blue", {}, smith=True)


def prop(name, slots):
    """Map selected (column, row) cells of the 16×4 palette to farm materials."""
    for role in slots.values():
        if role not in SURFACE_COLORS and role not in FLAT_COLORS:
            raise ValueError(f"Unknown farm material: {role}")
    return _instance(name, slots)
