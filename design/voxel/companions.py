"""Build 3 refined animated pets (6 named clips each) and 6 refined orchestrator managers
(3 named clips with expressive faces & layered hair/accessories).

Usage:
    blender --background --python design/voxel/companions.py -- assets/models
"""
from math import radians, sin, tau
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from core import ClipRecorder, VoxelBuilder, export_glb, reset_scene


def build_pets(out_dir):
    specs = {
        "dog": {
            "fur": "c97932", "shade": "94531f", "cream": "f7e4be", "eye": "2f1c18",
            "nose": "3b211a", "collar": "a6312d", "bell": "f0b936", "ear-in": "94531f",
            "tongue": "eb7575", "floppy": True,
        },
        "bluecat": {
            "fur": "7d848c", "shade": "575d66", "cream": "dfe2de", "eye": "2d1c19",
            "nose": "945848", "collar": "a62b34", "bell": "e89b32", "ear-in": "bf754c",
            "tongue": "eb7575", "floppy": False,
        },
        "ragdoll": {
            "fur": "f5e6cc", "shade": "66432e", "cream": "fff5e0", "eye": "325878",
            "nose": "5e3b29", "collar": "8c5d3a", "bell": "e8b347", "ear-in": "593624",
            "tongue": "eb7575", "floppy": False, "mask": True,
        },
    }
    for name, pal in specs.items():
        scene = reset_scene()
        colors = {k: v for k, v in pal.items() if isinstance(v, str)}
        vb = VoxelBuilder(scene, colors)

        root = vb.pivot(name, (0, 0, 0))
        body = vb.pivot("Body", (0, 0, 0.40), root)
        vb.box(body, "Torso", "fur", (0, 0.06, 0.08), (0.64, 0.84, 0.56))
        vb.box(body, "Chest", "cream", (0, -0.28, 0.04), (0.48, 0.24, 0.44))
        vb.box(body, "Collar", "collar", (0, -0.22, 0.32), (0.58, 0.46, 0.10))
        vb.box(body, "Bell", "bell", (0, -0.47, 0.25), (0.14, 0.12, 0.14))

        paws_f, paws_b = [], []
        for sx in (-0.22, 0.22):
            pf = vb.pivot("FrontLeg", (sx, -0.24, -0.14), body)
            vb.box(pf, "FrontPaw", "cream" if name == "dog" else "shade", (0, -0.02, -0.14), (0.20, 0.26, 0.28))
            paws_f.append(pf)
            pb = vb.pivot("BackLeg", (sx, 0.24, -0.14), body)
            vb.box(pb, "BackPaw", "fur", (0, 0, -0.14), (0.22, 0.30, 0.24))
            paws_b.append(pb)

        head = vb.pivot("Head", (0, -0.22, 0.46), body)
        vb.box(head, "Skull", "fur", (0, 0, 0.24), (0.78, 0.70, 0.58))
        if pal.get("mask"):
            vb.box(head, "Mask", "shade", (0, -0.35, 0.22), (0.52, 0.08, 0.32))
        else:
            vb.box(head, "Snout", "cream", (0, -0.36, 0.14), (0.44, 0.18, 0.24))
        vb.box(head, "Nose", "nose", (0, -0.46, 0.20), (0.14, 0.08, 0.10))
        for side in (-1, 1):
            if pal["floppy"]:
                vb.box(head, "Ear", "shade", (side * 0.41, -0.04, 0.38), (0.18, 0.26, 0.36), rot_deg=(0, side * 18, 0))
            else:
                vb.box(head, "Ear", "shade" if pal.get("mask") else "fur", (side * 0.26, -0.04, 0.58), (0.22, 0.18, 0.25))
                vb.box(head, "EarIn", "ear-in", (side * 0.26, -0.13, 0.56), (0.11, 0.04, 0.14))

        # Switchable pet faces: awake / sleep / bark
        f_awake = vb.pivot("FaceAwake", (0, 0, 0), head)
        f_sleep = vb.pivot("FaceSleep", (0, 0, 0), head)
        f_bark = vb.pivot("FaceBark", (0, 0, 0), head)
        for side in (-1, 1):
            vb.box(f_awake, "Eye", "eye", (side * 0.20, -0.37, 0.28), (0.115, 0.05, 0.135))
            vb.box(f_awake, "Glint", "cream", (side * 0.20 - 0.02, -0.40, 0.31), (0.042, 0.02, 0.042))
            vb.box(f_sleep, "Shut", "eye", (side * 0.20, -0.37, 0.26), (0.13, 0.04, 0.045))
            vb.box(f_bark, "HappyEye", "eye", (side * 0.20, -0.37, 0.29), (0.12, 0.045, 0.06))
        vb.box(f_bark, "MouthOpen", "eye", (0, -0.45, 0.09), (0.18, 0.06, 0.12))
        vb.box(f_bark, "Tongue", "tongue", (0, -0.48, 0.04), (0.11, 0.05, 0.10))

        tail = vb.pivot("Tail", (0, 0.44, 0.14), body)
        vb.box(tail, "TailBase", "shade" if pal.get("mask") else "fur", (0, 0.14, 0.14), (0.20, 0.24, 0.36), rot_deg=(-22, 0, 0))
        vb.box(tail, "TailTip", "cream" if name == "dog" else "shade", (0, 0.22, 0.36), (0.18, 0.20, 0.22))

        faces = {"awake": f_awake, "sleep": f_sleep, "bark": f_bark}
        tracked = [body, head, tail, *paws_f, *paws_b, *faces.values()]
        rec = ClipRecorder(scene, tracked)
        bz = body.location.z

        def set_face(active, phase=0.0):
            pulse = 1.0 + 0.002 * sin(phase * tau)
            off = 0.0001 * (1.0 + sin(phase * tau))
            for k, obj in faces.items():
                s = pulse if k == active else off
                obj.scale = (s, s, s)

        def p_awake(p, _):
            set_face("awake", p)
            ph = p * tau
            tail.rotation_euler.z = radians(26) * sin(ph)
            head.rotation_euler.y = radians(6) * sin(ph)

        def p_walk(p, _):
            set_face("awake", p)
            ph = p * tau
            paws_f[0].rotation_euler.x = radians(26) * sin(ph)
            paws_f[1].rotation_euler.x = -radians(26) * sin(ph)
            paws_b[0].rotation_euler.x = -radians(24) * sin(ph)
            paws_b[1].rotation_euler.x = radians(24) * sin(ph)
            body.location.z = bz + 0.04 * abs(sin(ph))
            tail.rotation_euler.z = radians(30) * sin(ph)

        def p_sleep(p, _):
            set_face("sleep", p)
            ph = p * tau
            body.location.z = bz - 0.16 + 0.015 * sin(ph)
            head.rotation_euler.x = radians(-24)
            head.location.z = 0.34
            tail.rotation_euler.z = radians(36)

        def p_bark(p, _):
            set_face("bark", p)
            ph = p * tau
            body.location.z = bz + 0.06 * abs(sin(ph))
            head.rotation_euler.x = radians(16) * abs(sin(ph))
            tail.rotation_euler.z = radians(38) * sin(ph * 2)

        def p_jump(p, _):
            set_face("bark", p)
            ph = p * tau
            hop = abs(sin(ph))
            body.location.z = bz + 0.24 * hop
            body.rotation_euler.x = radians(18) * hop
            paws_f[0].rotation_euler.x = radians(-36) * hop
            paws_f[1].rotation_euler.x = radians(-36) * hop
            tail.rotation_euler.z = radians(34) * sin(ph)

        def p_belly(p, _):
            set_face("bark", p)
            ph = p * tau
            body.location.z = bz - 0.08
            body.rotation_euler.y = radians(155)
            paws_f[0].rotation_euler.x = radians(24) * sin(ph)
            paws_f[1].rotation_euler.x = -radians(24) * sin(ph)
            tail.rotation_euler.z = radians(24) * sin(ph)

        rec.record("awake", (1, 7, 13, 19, 25), p_awake)
        rec.record("walk", (1, 7, 13, 19, 25), p_walk)
        rec.record("sleep", (1, 7, 13, 19, 25), p_sleep)
        rec.record("bark", (1, 7, 13, 19, 25), p_bark)
        rec.record("jump", (1, 7, 13, 19, 25), p_jump)
        rec.record("belly", (1, 7, 13, 19, 25), p_belly)
        export_glb(out_dir / f"pet-{name}.glb", multi_clip=True)


def build_managers(out_dir):
    configs = {
        "farmer": {
            "skin": "f5c998", "blush": "eb9175", "hair": "6b4126", "eye": "36211a", "cream": "fff5e0",
            "shirt": "fae6b7", "cloth": "40789f", "seam": "32617c", "hat": "f2be5c", "band": "7a4b2b",
            "boot": "7a4624", "gold": "f5c249",
        },
        "auntie": {
            "skin": "f5c998", "blush": "eb9175", "hair": "7c4625", "eye": "36211a", "cream": "fff5e0",
            "shirt": "c9d1c5", "cloth": "e8aa35", "seam": "b87d22", "hat": "f2dfa8", "band": "5c7361",
            "boot": "596654", "gold": "d9c298", "kerchief": True,
        },
        "foreman": {
            "skin": "f0be8d", "blush": "e3896d", "hair": "593622", "eye": "36211a", "cream": "fff5e0",
            "shirt": "d97e38", "cloth": "f08c2b", "seam": "fae6b7", "hat": "f5bd33", "band": "c98e1e",
            "boot": "6e3d21", "gold": "a88e65", "beard": True, "hardhat": True,
        },
        "gardener": {
            "skin": "f5c998", "blush": "eb9175", "hair": "6e3f23", "eye": "36211a", "cream": "fff5e0",
            "shirt": "f7e8c3", "cloth": "5d874b", "seam": "446636", "hat": "e8ba66", "band": "5d874b",
            "boot": "7a4b29", "gold": "f7f2dc", "braid": True,
        },
        "grandpa": {
            "skin": "f2c291", "blush": "e38b70", "hair": "e8e2d5", "eye": "36211a", "cream": "fff5e0",
            "shirt": "407094", "cloth": "407094", "seam": "2f5470", "hat": "e6b35a", "band": "6b4628",
            "boot": "453d38", "gold": "f5ebd6", "beard": True, "towel": True,
        },
        "robot": {
            "skin": "33363b", "blush": "eb8546", "hair": "f2e3b8", "eye": "ffe89e", "cream": "fff7db",
            "shirt": "f2e3b8", "cloth": "e8882c", "seam": "5d874b", "hat": "f0b94a", "band": "c98d2e",
            "boot": "4e5446", "gold": "699e4b", "robot": True,
        },
    }
    for name, pal in configs.items():
        scene = reset_scene()
        colors = {k: v for k, v in pal.items() if isinstance(v, str)}
        emissive = ("eye",) if pal.get("robot") else ()
        vb = VoxelBuilder(scene, colors, emissive_keys=emissive)

        root = vb.pivot(f"manager-{name}", (0, 0, 0))
        body = vb.pivot("Hips", (0, 0, 0.79), root)
        vb.box(body, "Torso", "cloth", (0, 0.02, 0.24), (0.84, 0.64, 0.72))
        vb.box(body, "Upper", "shirt", (0, 0.02, 0.58), (0.80, 0.60, 0.36))
        vb.box(body, "Bib", "cloth", (0, -0.31, 0.44), (0.64, 0.07, 0.44))
        vb.box(body, "Pocket", "seam", (0, -0.355, 0.38), (0.30, 0.05, 0.22))
        for side in (-1, 1):
            vb.box(body, "Strap", "seam", (side * 0.24, -0.30, 0.64), (0.11, 0.08, 0.30))
            vb.box(body, "Btn", "gold", (side * 0.24, -0.355, 0.56), (0.09, 0.04, 0.09))
        if pal.get("towel"):
            for sx in (-0.25, 0.25):
                vb.box(body, "Towel", "gold", (sx, -0.33, 0.52), (0.17, 0.10, 0.46))
        if pal.get("hardhat"):
            # Hi-vis reflective vest stripes
            vb.box(body, "VestStripe", "seam", (0, -0.355, 0.34), (0.76, 0.04, 0.08))

        head = vb.pivot("Head", (0, 0, 0.74), body)
        if pal.get("robot"):
            vb.box(head, "Chassis", "hair", (0, 0, 0.38), (1.08, 0.86, 0.72))
            vb.box(head, "Screen", "skin", (0, -0.43, 0.38), (0.84, 0.06, 0.48))
            for side in (-1, 1):
                vb.box(head, "EarDial", "cloth", (side * 0.56, 0, 0.38), (0.10, 0.32, 0.32))
            vb.box(head, "Stem", "band", (0, 0, 1.00), (0.08, 0.08, 0.18))
            vb.box(head, "LeafL", "gold", (-0.14, 0, 1.12), (0.22, 0.10, 0.12), rot_deg=(0, 22, 0))
            vb.box(head, "LeafR", "gold", (0.14, 0, 1.12), (0.22, 0.10, 0.12), rot_deg=(0, -22, 0))
            ey_y = -0.47
        else:
            vb.box(head, "Face", "skin", (0, -0.02, 0.36), (0.98, 0.80, 0.66))
            vb.box(head, "HairBack", "hair", (0, 0.12, 0.44), (1.06, 0.74, 0.58))
            # Layered front bangs & sideburns
            for bx, bz, bw in ((-0.26, 0.58, 0.24), (0.0, 0.56, 0.28), (0.26, 0.58, 0.24)):
                vb.box(head, "Bangs", "hair", (bx, -0.42, bz), (bw, 0.08, 0.14))
            for side in (-1, 1):
                vb.box(head, "Ear", "skin", (side * 0.52, -0.02, 0.32), (0.12, 0.16, 0.18))
                vb.box(head, "SideHair", "hair", (side * 0.50, 0.08, 0.42), (0.12, 0.30, 0.32))
            if pal.get("beard"):
                vb.box(head, "Beard", "hair", (0, -0.40, 0.14), (0.78, 0.20, 0.24))
                vb.box(head, "Mustache", "hair", (0, -0.44, 0.23), (0.48, 0.08, 0.10), shade=0.05)
            if pal.get("braid"):
                vb.box(head, "Braid", "hair", (0.36, -0.22, 0.04), (0.18, 0.18, 0.44))
            ey_y = -0.435

        # Switchable manager faces: idle (warm smile), talk (open happy mouth), listen (attentive wide eyes)
        f_idle = vb.pivot("FaceIdle", (0, 0, 0), head)
        f_talk = vb.pivot("FaceTalk", (0, 0, 0), head)
        f_listen = vb.pivot("FaceListen", (0, 0, 0), head)
        for side in (-1, 1):
            # Idle: cheerful curved eyes + blush
            vb.box(f_idle, "EyeL", "eye", (side * 0.22 - 0.03, ey_y, 0.37), (0.08, 0.04, 0.045), rot_deg=(0, 20, 0))
            vb.box(f_idle, "EyeR", "eye", (side * 0.22 + 0.03, ey_y, 0.37), (0.08, 0.04, 0.045), rot_deg=(0, -20, 0))
            vb.box(f_idle, "Blush", "blush", (side * 0.34, ey_y + 0.005, 0.27), (0.12, 0.03, 0.07))
            # Talk: cheerful eyes + open mouth
            vb.box(f_talk, "EyeT", "eye", (side * 0.22, ey_y, 0.38), (0.13, 0.04, 0.06))
            vb.box(f_talk, "BlushT", "blush", (side * 0.34, ey_y + 0.005, 0.27), (0.14, 0.03, 0.08))
            # Listen: open attentive eyes with highlight
            vb.box(f_listen, "EyeW", "eye", (side * 0.22, ey_y, 0.36), (0.11, 0.04, 0.13))
            if not pal.get("robot"):
                vb.box(f_listen, "Glint", "cream", (side * 0.22 - 0.02, ey_y - 0.02, 0.40), (0.04, 0.02, 0.04))
            vb.box(f_listen, "BlushL", "blush", (side * 0.34, ey_y + 0.005, 0.27), (0.12, 0.03, 0.07))
        vb.box(f_idle, "Smile", "eye", (0, ey_y - 0.005, 0.24), (0.16, 0.04, 0.045))
        vb.box(f_talk, "OpenMouth", "eye", (0, ey_y - 0.005, 0.23), (0.16, 0.04, 0.11))
        vb.box(f_listen, "SmallMouth", "eye", (0, ey_y - 0.005, 0.24), (0.11, 0.04, 0.04))

        # Hat / headscarf / hardhat
        if pal.get("kerchief"):
            vb.box(head, "Kerchief", "hat", (0, 0.08, 0.66), (1.06, 0.90, 0.30))
            vb.box(head, "Knot", "band", (0.42, 0.36, 0.50), (0.24, 0.24, 0.20))
        elif pal.get("hardhat"):
            vb.box(head, "Visor", "hat", (0, -0.10, 0.66), (1.16, 1.06, 0.09))
            vb.box(head, "Dome", "hat", (0, 0.02, 0.80), (0.98, 0.88, 0.26))
            vb.box(head, "Ridge", "band", (0, 0.02, 0.94), (0.20, 0.90, 0.09))
        else:
            vb.box(head, "Brim", "hat", (0, 0.02, 0.66), (1.34, 1.06, 0.09))
            vb.box(head, "Band", "band", (0, 0.03, 0.73), (0.89, 0.75, 0.08))
            vb.box(head, "Crown", "hat", (0, 0.03, 0.83), (0.85, 0.71, 0.22))
            if pal.get("braid"):
                vb.box(head, "Flower", "gold", (0.42, -0.34, 0.76), (0.20, 0.12, 0.20))

        legs, arms = [], []
        for side in (-1, 1):
            leg = vb.pivot(f"Leg_{side}", (side * 0.22, 0.01, -0.12), body)
            vb.box(leg, "Leg", "cloth" if not pal.get("robot") else "hair", (0, 0, -0.22), (0.34, 0.42, 0.44))
            vb.box(leg, "Boot", "boot", (0, -0.05, -0.53), (0.38, 0.54, 0.22))
            legs.append(leg)
            arm = vb.pivot(f"Arm_{side}", (side * 0.46, -0.01, 0.64), body)
            vb.box(arm, "Sleeve", "shirt", (side * 0.04, 0, -0.20), (0.26, 0.34, 0.40))
            vb.box(arm, "Hand", "skin" if not pal.get("robot") else "boot", (side * 0.06, -0.02, -0.48), (0.22, 0.26, 0.18))
            arms.append(arm)

        faces = {"idle": f_idle, "talk": f_talk, "listen": f_listen}
        rec = ClipRecorder(scene, [body, head, *legs, *arms, *faces.values()])
        bz = body.location.z

        def set_face(active, phase=0.0):
            pulse = 1.0 + 0.002 * sin(phase * tau)
            off = 0.0001 * (1.0 + sin(phase * tau))
            for k, obj in faces.items():
                s = pulse if k == active else off
                obj.scale = (s, s, s)

        def p_idle(p, _):
            set_face("idle", p)
            ph = p * tau
            body.location.z = bz + 0.018 * sin(ph)
            head.rotation_euler.y = radians(4) * sin(ph)

        def p_talk(p, _):
            set_face("talk", p)
            ph = p * tau
            body.location.z = bz + 0.024 * abs(sin(ph))
            head.rotation_euler.x = radians(6) * sin(ph)
            arms[1].rotation_euler.x = radians(-64) - radians(18) * sin(ph)
            arms[0].rotation_euler.x = radians(-24)

        def p_listen(p, _):
            set_face("listen", p)
            ph = p * tau
            head.rotation_euler.z = radians(10) + radians(4) * sin(ph)
            arms[0].rotation_euler.x = radians(-20)
            arms[1].rotation_euler.x = radians(-20)

        rec.record("idle", (1, 7, 13, 19, 25), p_idle)
        rec.record("talk", (1, 7, 13, 19, 25), p_talk)
        rec.record("listen", (1, 7, 13, 19, 25), p_listen)
        export_glb(out_dir / f"manager-{name}.glb", multi_clip=True)


if __name__ == "__main__":
    out_dir = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
    build_pets(out_dir)
    build_managers(out_dir)
    print(f"Exported 9 refined multi-clip pets/managers to {out_dir}")
