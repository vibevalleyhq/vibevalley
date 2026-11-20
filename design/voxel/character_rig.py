"""Shared expressions, held tools and motion for farm helpers."""
from math import cos, radians, sin, tau

from core import ClipRecorder


TOOL_PALETTE = {
    "tool-wood": "a86c36", "tool-wood-dark": "754720",
    "tool-iron": "757b85", "tool-iron-hi": "b3b9c4",
    "book-cover": "913c34", "book-page": "fff0c8", "book-ink": "795943",
    "sweat": "70c8ff", "sweat-hi": "d6f3ff",
}


def build_expressions(vb, head, face_y=-0.468, eye_x=0.265, eye_z=0.365, iris_col="iris", blush_col="blush"):
    """Creates 4 switchable expression groups parented to `head` (switched via scale 0/1 in animations)."""
    # 1. Normal: expressive eyes with iris edge + cream glint
    expr_normal = vb.pivot("ExprNormal", (0, 0, 0), head)
    for side in (-1, 1):
        vb.box(expr_normal, "Iris", iris_col, (side * eye_x, face_y, eye_z - 0.005), (0.196, 0.045, 0.21))
        vb.box(expr_normal, "Pupil", "eye", (side * eye_x - side * 0.008, face_y - 0.015, eye_z + 0.004), (0.15, 0.038, 0.181))
        vb.box(expr_normal, "Glint", "cream", (side * eye_x - 0.032, face_y - 0.035, eye_z + 0.048), (0.06, 0.024, 0.068))
        vb.box(expr_normal, "Blush", blush_col, (side * (eye_x + 0.12), face_y + 0.008, eye_z - 0.125), (0.12, 0.03, 0.065))

    # 2. Happy (cheer): curved ^ ^ smiling eyes, rosy cheeks, open joyful mouth
    expr_happy = vb.pivot("ExprHappy", (0, 0, 0), head)
    for side in (-1, 1):
        vb.box(expr_happy, "SmileL", "eye", (side * eye_x - 0.04, face_y - 0.015, eye_z + 0.01), (0.09, 0.04, 0.045), rot_deg=(0, 26, 0))
        vb.box(expr_happy, "SmileR", "eye", (side * eye_x + 0.04, face_y - 0.015, eye_z + 0.01), (0.09, 0.04, 0.045), rot_deg=(0, -26, 0))
        vb.box(expr_happy, "HappyBlush", blush_col, (side * (eye_x + 0.11), face_y - 0.005, eye_z - 0.11), (0.16, 0.035, 0.085))
    vb.box(expr_happy, "HappyMouth", "eye", (0.0, face_y - 0.085, eye_z - 0.21), (0.15, 0.04, 0.10))

    # 3. Focus (hammer / tinker / read): slightly angled determined brows over alert eyes
    expr_focus = vb.pivot("ExprFocus", (0, 0, 0), head)
    for side in (-1, 1):
        vb.box(expr_focus, "FocusPupil", "eye", (side * eye_x, face_y - 0.015, eye_z - 0.01), (0.125, 0.04, 0.135))
        vb.box(expr_focus, "FocusGlint", "cream", (side * eye_x - 0.028, face_y - 0.036, eye_z + 0.032), (0.042, 0.016, 0.042))
        vb.box(expr_focus, "FocusBrow", "eye", (side * eye_x, face_y - 0.025, eye_z + 0.105), (0.17, 0.045, 0.042), rot_deg=(0, -side * 16, 0))

    # 4. Worry: tilted sad brows, wide anxious eyes, floating blue sweat drop
    expr_worry = vb.pivot("ExprWorry", (0, 0, 0), head)
    for side in (-1, 1):
        vb.box(expr_worry, "WorryWhite", "cream", (side * eye_x, face_y - 0.005, eye_z), (0.16, 0.04, 0.17))
        vb.box(expr_worry, "WorryPupil", "eye", (side * eye_x, face_y - 0.022, eye_z - 0.01), (0.095, 0.035, 0.105))
        vb.box(expr_worry, "WorryBrow", "eye", (side * eye_x, face_y - 0.025, eye_z + 0.115), (0.18, 0.045, 0.042), rot_deg=(0, side * 22, 0))
    vb.box(expr_worry, "Sweat", "sweat", (eye_x + 0.24, face_y - 0.02, eye_z + 0.08), (0.09, 0.06, 0.15))
    vb.box(expr_worry, "SweatHi", "sweat-hi", (eye_x + 0.23, face_y - 0.045, eye_z + 0.11), (0.04, 0.03, 0.05))
    vb.box(expr_worry, "WorryMouth", "eye", (0.0, face_y - 0.085, eye_z - 0.20), (0.18, 0.04, 0.045))

    return {
        "normal": expr_normal,
        "happy": expr_happy,
        "focus": expr_focus,
        "worry": expr_worry,
    }


def build_held_tools(vb, arm_right, body):
    """Attach striking tools at the right grip and the open book between the paws."""
    # 1. Hammer attached to right paw
    hammer = vb.pivot("ToolHammer", (0.08, -0.06, -0.54), arm_right, rot_deg=(28, 0, 12))
    vb.box(hammer, "Handle", "tool-wood", (0.0, -0.33, 0.04), (0.11, 0.77, 0.11))
    vb.box(hammer, "Grip", "tool-wood-dark", (0.0, -0.02, 0.04), (0.10, 0.16, 0.10))
    vb.box(hammer, "Head", "tool-iron", (0.0, -0.66, 0.04), (0.27, 0.28, 0.49))
    vb.box(hammer, "Face", "tool-iron-hi", (0.0, -0.66, -0.20), (0.28, 0.30, 0.08))

    hoe = vb.pivot("ToolHoe", (0.08, -0.06, -0.54), arm_right, rot_deg=(47, 0, 12))
    vb.box(hoe, "Ash shaft", "tool-wood", (0, -0.46, 0), (0.092, 1.33, 0.092))
    vb.box(hoe, "Ferrule", "tool-iron", (0, -1.08, 0), (0.15, 0.14, 0.15))
    vb.box(hoe, "Hoe blade", "tool-iron", (0, -1.11, -0.14), (0.37, 0.10, 0.31), rot_deg=(-16, 0, 0))
    vb.box(hoe, "Cutting edge", "tool-iron-hi", (0, -1.15, -0.28), (0.39, 0.085, 0.073))

    # 2. Wrench attached to right paw
    wrench = vb.pivot("ToolWrench", (0.08, -0.06, -0.54), arm_right)
    vb.box(wrench, "Shaft", "tool-iron", (0.0, -0.24, 0.02), (0.08, 0.46, 0.07))
    vb.box(wrench, "JawL", "tool-iron-hi", (-0.07, -0.48, 0.02), (0.06, 0.16, 0.08))
    vb.box(wrench, "JawR", "tool-iron-hi", (0.07, -0.48, 0.02), (0.06, 0.16, 0.08))
    vb.box(wrench, "JawB", "tool-iron-hi", (0.0, -0.41, 0.02), (0.20, 0.08, 0.08))

    # 3. Open book held in front of body
    book = vb.pivot("ToolBook", (0.0, -0.70, 0.44), body, rot_deg=(36, 0, -4))
    vb.box(book, "Spine", "book-cover", (0, 0, -0.02), (0.11, 0.62, 0.09))
    for side in (-1, 1):
        leaf = vb.pivot("Book leaf", (0, 0, 0), book, rot_deg=(0, -side * 15, 0))
        vb.box(leaf, "Binding", "book-cover", (side * 0.28, 0, 0), (0.57, 0.65, 0.08))
        vb.box(leaf, "Paper", "book-page", (side * 0.28, 0, 0.072), (0.50, 0.57, 0.076))
        for y, width in ((-0.12, 0.26), (0.06, 0.32)):
            vb.box(leaf, "Printed line", "book-ink", (side * 0.275, y, 0.114), (width, 0.052, 0.018))

    palm = vb.pivot("OpenPaw", (0.075, 0.0, -0.62), arm_right)
    vb.box(palm, "Palm", "paw", (0, 0, -0.06), (0.29, 0.19, 0.29))
    vb.box(palm, "Paw pad", "blush", (0, 0.098, -0.06), (0.17, 0.033, 0.15))
    for x, length in ((-0.10, 0.10), (0, 0.15), (0.10, 0.11)):
        vb.box(palm, "Toe", "paw", (x, 0, -0.17 - length / 2), (0.089, 0.14, length))
    return {"hammer": hammer, "wrench": wrench, "book": book, "hoe": hoe, "palm": palm}


def record_helper_clips(scene, body, head, legs, arms, tail, exprs, tools):
    """Record each loop over one second at 24 fps."""
    arm_l, arm_r = arms[0], arms[1]
    leg_l, leg_r = legs[0], legs[1]
    tracked = [body, head, leg_l, leg_r, arm_l, arm_r]
    if tail is not None:
        tracked.append(tail)
    tracked.extend(exprs.values())
    tracked.extend(tools.values())

    rec = ClipRecorder(scene, tracked)
    base_z = body.location.z

    def set_vis(active_expr, active_tool=None, phase=0.0):
        # Micro-pulse (0.002) guarantees Blender never strips constant scale tracks during glTF export.
        pulse = 1.0 + 0.002 * sin(phase * tau)
        off = 0.0001 * (1.0 + sin(phase * tau))
        for k, obj in exprs.items():
            s = pulse if k == active_expr else off
            obj.scale = (s, s, s)
        for k, obj in tools.items():
            s = pulse if k == active_tool else off
            obj.scale = (s, s, s)

    # 1. idle: gentle breathing, head micro-bob, relaxed tail sway
    def pose_idle(p, _):
        set_vis("normal", None, p)
        ph = p * tau
        body.location.z = base_z + 0.018 * sin(ph)
        head.rotation_euler.y = radians(4) * sin(ph)
        arm_l.rotation_euler.x = radians(-4) + radians(3) * sin(ph)
        arm_r.rotation_euler.x = radians(-4) - radians(3) * sin(ph)
        if tail is not None:
            tail.rotation_euler.z = radians(18) + radians(8) * sin(ph)

    rec.record("idle", (1, 7, 13, 19, 25), pose_idle)

    # 2. walk: energetic stride, counter-swing arms, bouncy body, wagging tail
    def pose_walk(p, _):
        set_vis("normal", None, p)
        ph = p * tau
        leg_l.rotation_euler.x = radians(24) * sin(ph)
        leg_r.rotation_euler.x = -radians(24) * sin(ph)
        arm_l.rotation_euler.x = -radians(22) * sin(ph) - radians(5)
        arm_r.rotation_euler.x = radians(22) * sin(ph) - radians(5)
        body.location.z = base_z - abs(sin(ph)) * 0.036
        head.rotation_euler.x = radians(4) * abs(sin(ph))
        if tail is not None:
            tail.rotation_euler.z = radians(24) + radians(12) * sin(ph)

    rec.record("walk", (1, 4, 7, 10, 13, 16, 19, 22, 25), pose_walk)

    def striking_pose(tool, raised_angle, contact_angle):
        def pose(p, _):
            set_vis("focus", tool, p)
            lift = max(0.0, (cos((p - 0.19) * tau) + 0.85) / 1.85)
            body.rotation_euler.x = radians(9 - 12 * lift)
            head.rotation_euler.x = radians(11 - 12 * lift)
            head.rotation_euler.z = radians(9)
            arm_r.rotation_euler.x = radians(contact_angle + (raised_angle - contact_angle) * lift)
            arm_r.rotation_euler.y = radians(-12 + 48 * lift)
            arm_r.rotation_euler.z = radians(25)
            arm_l.rotation_euler.x = radians(-38 - 22 * lift)
            arm_l.rotation_euler.z = radians(-12)
            if tail is not None:
                tail.rotation_euler.z = radians(17 + 12 * lift)
        return pose

    beats = (1, 4, 6, 9, 12, 15, 17, 20, 23, 25)
    rec.record("hammer", beats, striking_pose("hammer", -153, -25))
    rec.record("hoe", beats, striking_pose("hoe", -122, -8))

    # 4. tinker: focused expression, both arms extended forward turning wrench
    def pose_tinker(p, _):
        set_vis("focus", "wrench", p)
        ph = p * tau
        body.rotation_euler.x = radians(-10)
        head.rotation_euler.x = radians(-10)
        head.rotation_euler.y = radians(6) * sin(ph)
        arm_r.rotation_euler.x = radians(-72) - radians(12) * sin(ph)
        arm_r.rotation_euler.z = radians(14) * sin(ph)
        arm_l.rotation_euler.x = radians(-64) + radians(10) * sin(ph)
        if tail is not None:
            tail.rotation_euler.z = radians(14) + radians(8) * sin(ph)

    rec.record("tinker", (1, 7, 13, 19, 25), pose_tinker)

    # 5. read: focused expression, both hands forward cradling open book, head tilted down
    def pose_read(p, _):
        set_vis("focus", "book", p)
        ph = p * tau
        body.location.z = base_z - 0.015
        head.rotation_euler.x = radians(11)
        head.rotation_euler.z = radians(5) * sin(ph)
        arm_l.rotation_euler.x = radians(-67)
        arm_l.rotation_euler.y = radians(-15)
        arm_r.rotation_euler.x = radians(-67)
        arm_r.rotation_euler.y = radians(15)
        if tail is not None:
            tail.rotation_euler.z = radians(12) + radians(5) * sin(ph)

    rec.record("read", (1, 7, 13, 19, 25), pose_read)

    # 6. sit: lowered hips, legs extended forward 76 deg, relaxed breathing
    def pose_sit(p, _):
        set_vis("normal", None, p)
        ph = p * tau
        body.location.z = base_z - 0.24 + 0.015 * sin(ph)
        leg_l.rotation_euler.x = radians(-76)
        leg_r.rotation_euler.x = radians(-76)
        arm_l.rotation_euler.x = radians(-26)
        arm_r.rotation_euler.x = radians(-26)
        head.rotation_euler.y = radians(5) * sin(ph)
        if tail is not None:
            tail.rotation_euler.z = radians(22) + radians(6) * sin(ph)

    rec.record("sit", (1, 7, 13, 19, 25), pose_sit)

    # 7. cheer: joyful ^ ^ smile expression, both arms raised high overhead, happy jump!
    def pose_cheer(p, _):
        set_vis("happy", None, p)
        ph = p * tau
        hop = abs(sin(ph))
        body.location.z = base_z + 0.14 * hop
        head.rotation_euler.x = radians(8) * hop
        arm_l.rotation_euler.x = radians(-148) - radians(12) * sin(ph)
        arm_l.rotation_euler.y = radians(16)
        arm_r.rotation_euler.x = radians(-148) + radians(12) * sin(ph)
        arm_r.rotation_euler.y = radians(-16)
        leg_l.rotation_euler.x = radians(12) * hop
        leg_r.rotation_euler.x = radians(12) * hop
        if tail is not None:
            tail.rotation_euler.z = radians(28) + radians(18) * sin(ph)

    rec.record("cheer", (1, 6, 11, 16, 21, 25), pose_cheer)

    # 8. worry: anxious sweat-drop expression, arms huddled forward, nervous tremble
    def pose_worry(p, _):
        set_vis("worry", None, p)
        ph = p * tau
        body.location.z = base_z - 0.04
        body.rotation_euler.x = radians(-8)
        head.rotation_euler.x = radians(-10)
        head.rotation_euler.z = radians(7) * sin(ph)
        arm_l.rotation_euler.x = radians(-60)
        arm_l.rotation_euler.y = radians(-24)
        arm_r.rotation_euler.x = radians(-60)
        arm_r.rotation_euler.y = radians(24)
        if tail is not None:
            tail.rotation_euler.x = radians(-14)
            tail.rotation_euler.z = radians(8) * sin(ph)

    rec.record("worry", (1, 7, 13, 19, 25), pose_worry)

    def pose_ask(p, _):
        set_vis("normal", "palm", p)
        wave = sin(p * tau)
        head.rotation_euler.z = radians(-10)
        head.rotation_euler.y = radians(-5)
        arm_r.location.x += 0.08
        arm_r.location.z += 0.19
        arm_r.scale.z = 1.26
        arm_r.rotation_euler.x = radians(-174)
        arm_r.rotation_euler.y = radians(25 + 10 * wave)
        arm_r.rotation_euler.z = radians(13)
        arm_l.rotation_euler.x = radians(-12)

    rec.record("ask", (1, 7, 13, 19, 25), pose_ask)
