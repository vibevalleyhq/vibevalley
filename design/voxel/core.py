"""Core Blender voxel primitives, palette shading, and multi-clip NLA animation exporter."""
from math import radians
from pathlib import Path

import bpy


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def _srgb_to_linear(c):
    return c / 12.92 if c < 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _hex_to_rgb(hex_str):
    return (
        int(hex_str[0:2], 16) / 255.0,
        int(hex_str[2:4], 16) / 255.0,
        int(hex_str[4:6], 16) / 255.0,
    )


class VoxelBuilder:
    """Builds clean voxel assemblies with palette shade variants and emissive materials."""

    def __init__(self, scene, palette, emissive_keys=()):
        self.scene = scene
        self.palette = dict(palette)
        self.emissive_keys = set(emissive_keys)
        self._mats = {}

    def mat(self, key, shade=0.0):
        """Returns a material for `key`; `shade` in [-0.25, 0.25] subtly shifts brightness to break flatness."""
        bucket = round(shade * 20)
        cache_key = (key, bucket)
        if cache_key in self._mats:
            return self._mats[cache_key]
        r, g, b = _hex_to_rgb(self.palette[key])
        delta = bucket / 20.0
        if delta > 0:
            r += (1.0 - r) * delta
            g += (1.0 - g) * delta
            b += (1.0 - b) * delta
        elif delta < 0:
            f = 1.0 + delta
            r, g, b = r * f, g * f, b * f
        lr, lg, lb = _srgb_to_linear(max(0.0, min(1.0, r))), _srgb_to_linear(max(0.0, min(1.0, g))), _srgb_to_linear(max(0.0, min(1.0, b)))
        m = bpy.data.materials.new(f"{key}_{bucket}")
        m.diffuse_color = (lr, lg, lb, 1.0)
        bsdf = m.node_tree.nodes.get("Principled BSDF") if m.use_nodes else None
        if bsdf is None:
            m.use_nodes = True
            bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (lr, lg, lb, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.92
        if key in self.emissive_keys:
            if "Emission Color" in bsdf.inputs:
                bsdf.inputs["Emission Color"].default_value = (lr, lg, lb, 1.0)
            if "Emission Strength" in bsdf.inputs:
                bsdf.inputs["Emission Strength"].default_value = 0.55
        self._mats[cache_key] = m
        return m

    def pivot(self, name, pos=(0.0, 0.0, 0.0), parent=None, rot_deg=None):
        obj = bpy.data.objects.new(name, None)
        self.scene.collection.objects.link(obj)
        obj.parent = parent
        obj.location = pos
        if rot_deg is not None:
            obj.rotation_euler = tuple(radians(a) for a in rot_deg)
        return obj

    def box(self, parent, name, color, pos, size, rot_deg=None, shade=0.0):
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        obj = bpy.context.object
        obj.name = name
        obj.parent = parent
        obj.location = pos
        obj.dimensions = size
        if rot_deg is not None:
            obj.rotation_euler = tuple(radians(a) for a in rot_deg)
        obj.data.materials.append(self.mat(color, shade=shade))
        return obj

    def tiled_roof(self, parent, name, color, center, width, slope_len, pitch_deg, cols, rows, flip_y=False, thickness=0.14):
        """Builds an overlapping row-by-row voxel shingle roof slope."""
        slope = self.pivot(name, center, parent, rot_deg=(-pitch_deg if flip_y else pitch_deg, 0.0, 0.0))
        tile_w = width / cols
        tile_d = slope_len / rows
        for r in range(rows):
            for c in range(cols):
                x = -width * 0.5 + (c + 0.5) * tile_w
                y = -slope_len * 0.5 + (r + 0.5) * tile_d
                # Slight step and checker shade variation so each shingle reads clearly.
                step_z = (rows - 1 - r) * 0.025 if not flip_y else r * 0.025
                shade = (((r * 7 + c * 13) % 5) - 2) * 0.045
                self.box(
                    slope,
                    f"{name}_t",
                    color,
                    (x, y, step_z),
                    (tile_w * 0.96, tile_d * 1.04, thickness),
                    shade=shade,
                )
        return slope

    def plank_wall(self, parent, name, color, center, width, depth, height, planks=5, trim_color=None):
        """Builds a timber wall with individual horizontal clapboard courses and optional corner posts."""
        wall = self.pivot(name, center, parent)
        plank_h = height / planks
        for i in range(planks):
            z = -height * 0.5 + (i + 0.5) * plank_h
            shade = ((i % 3) - 1) * 0.04
            self.box(wall, f"{name}_p", color, (0.0, 0.0, z), (width, depth, plank_h * 0.92), shade=shade)
        if trim_color is not None:
            for sx in (-1, 1):
                for sy in (-1, 1):
                    self.box(
                        wall,
                        f"{name}_post",
                        trim_color,
                        (sx * width * 0.5, sy * depth * 0.5, 0.0),
                        (0.24, 0.24, height + 0.04),
                    )
        return wall

    def window_box(self, parent, name, pos, w, h, frame_col, glass_col, flower_col=None, leaf_col=None):
        """Builds a recessed glowing window with cross mullions and optional flower sill box."""
        win = self.pivot(name, pos, parent)
        self.box(win, f"{name}_glass", glass_col, (0.0, 0.0, 0.0), (w, 0.08, h))
        # Outer frame & cross bars
        t = 0.08
        self.box(win, f"{name}_ft", frame_col, (0.0, -0.04, h * 0.5), (w + t, 0.10, t))
        self.box(win, f"{name}_fb", frame_col, (0.0, -0.05, -h * 0.5), (w + t * 1.6, 0.14, t * 1.1))
        self.box(win, f"{name}_fl", frame_col, (-w * 0.5, -0.04, 0.0), (t, 0.10, h))
        self.box(win, f"{name}_fr", frame_col, (w * 0.5, -0.04, 0.0), (t, 0.10, h))
        self.box(win, f"{name}_mh", frame_col, (0.0, -0.04, 0.0), (w, 0.08, t * 0.7))
        self.box(win, f"{name}_mv", frame_col, (0.0, -0.04, 0.0), (t * 0.7, 0.08, h))
        if flower_col and leaf_col:
            self.box(win, f"{name}_box", frame_col, (0.0, -0.14, -h * 0.5 - 0.10), (w + 0.10, 0.20, 0.16), shade=-0.05)
            self.box(win, f"{name}_leaf", leaf_col, (0.0, -0.14, -h * 0.5 + 0.02), (w, 0.18, 0.14))
            for fx in (-w * 0.28, 0.0, w * 0.28):
                self.box(win, f"{name}_flw", flower_col, (fx, -0.16, -h * 0.5 + 0.10), (0.12, 0.12, 0.10))
        return win

    def voxel_tree(self, parent, pos, scale=1.0, pine=True, fruit_col=None):
        """Builds a lush multi-cluster voxel tree (layered pine or puffy broadleaf)."""
        t = self.pivot("Tree", pos, parent)
        self.box(t, "Trunk", "trunk", (0.0, 0.0, 0.48 * scale), (0.36 * scale, 0.36 * scale, 0.96 * scale))
        self.box(t, "Root", "trunk", (0.0, 0.0, 0.12 * scale), (0.56 * scale, 0.56 * scale, 0.24 * scale), shade=-0.08)
        if pine:
            tiers = (
                (0.86, 1.48, 0.44, "pine-lo"),
                (1.22, 1.24, 0.42, "pine"),
                (1.56, 0.94, 0.40, "pine"),
                (1.88, 0.60, 0.36, "pine-hi"),
                (2.14, 0.30, 0.24, "pine-hi"),
            )
            for dz, w, h, col in tiers:
                self.box(t, "Pine", col, (0.0, 0.0, dz * scale), (w * scale, w * scale, h * scale))
        else:
            clusters = (
                ((0.0, 0.0, 1.26), (1.36, 1.26, 0.84), "leaf", 0.0),
                ((-0.44, -0.24, 1.12), (0.76, 0.72, 0.64), "leaf-lo", -0.04),
                ((0.46, 0.18, 1.16), (0.78, 0.72, 0.64), "leaf", 0.04),
                ((-0.14, -0.14, 1.66), (0.94, 0.88, 0.46), "leaf-hi", 0.05),
                ((0.20, 0.22, 1.54), (0.64, 0.62, 0.38), "leaf-hi", 0.0),
            )
            for cpos, csz, col, sh in clusters:
                self.box(
                    t,
                    "Canopy",
                    col,
                    tuple(v * scale for v in cpos),
                    tuple(v * scale for v in csz),
                    shade=sh,
                )
            if fruit_col:
                for fx, fy, fz in ((-0.42, -0.58, 1.16), (0.36, -0.56, 1.38), (0.04, -0.62, 1.02)):
                    self.box(t, "Fruit", fruit_col, (fx * scale, fy * scale, fz * scale), (0.20 * scale, 0.20 * scale, 0.20 * scale))
        return t


class ClipRecorder:
    """Records multiple named animation clips onto NLA tracks for multi-clip glTF 2.0 export."""

    def __init__(self, scene, objects, fps=24):
        self.scene = scene
        self.objects = list(objects)
        self.scene.render.fps = fps
        self._rest = {
            obj: (tuple(obj.location), tuple(obj.rotation_euler), tuple(obj.scale))
            for obj in self.objects
        }
        for obj in self.objects:
            obj.animation_data_create()

    def reset_pose(self):
        for obj, (loc, rot, scl) in self._rest.items():
            obj.location = loc
            obj.rotation_euler = rot
            obj.scale = scl

    def record(self, clip_name, frames, pose_fn):
        """Records `clip_name` over `frames` (e.g. `(1, 7, 13, 19, 25)`), calling `pose_fn(phase, rest)`."""
        actions = {}
        for obj in self.objects:
            act = bpy.data.actions.new(f"{clip_name}_{obj.name}")
            obj.animation_data.action = act
            actions[obj] = act

        span = max(1, frames[-1] - frames[0])
        for f in frames:
            self.reset_pose()
            phase = (f - frames[0]) / float(span)
            pose_fn(phase, self._rest)
            for obj in self.objects:
                obj.keyframe_insert(data_path="location", frame=f)
                obj.keyframe_insert(data_path="rotation_euler", frame=f)
                obj.keyframe_insert(data_path="scale", frame=f)

        for obj, act in actions.items():
            tr = obj.animation_data.nla_tracks.new()
            tr.name = clip_name
            st = tr.strips.new(clip_name, frames[0], act)
            st.name = clip_name
            obj.animation_data.action = None

        self.reset_pose()


def export_glb(path, multi_clip=True):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    kwargs = dict(
        filepath=str(path),
        use_selection=True,
        export_yup=True,
    )
    if multi_clip:
        kwargs["export_animation_mode"] = "NLA_TRACKS"
        kwargs["export_optimize_animation_size"] = False
    else:
        kwargs["export_animation_mode"] = "SCENE"
        kwargs["export_anim_scene_split_object"] = False
    bpy.ops.export_scene.gltf(**kwargs)
