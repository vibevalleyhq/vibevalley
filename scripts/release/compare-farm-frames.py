# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "opencv-python-headless", "pillow", "scikit-image"]
# ///
"""Compare two same-size farm captures. Run with uv run --script."""
import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageCms
from skimage.metrics import structural_similarity


def load(path, dpr):
    with Image.open(path) as source:
        source.load()
        profile = source.info.get("icc_profile")
        rgb = source.convert("RGB")
        if profile:
            rgb = ImageCms.profileToProfile(
                rgb, ImageCms.ImageCmsProfile(BytesIO(profile)),
                ImageCms.createProfile("sRGB"), outputMode="RGB",
            )
        if rgb.width % dpr or rgb.height % dpr:
            raise ValueError(f"{path}: physical size {rgb.size} is not divisible by DPR {dpr}")
        logical = rgb.resize((rgb.width // dpr, rgb.height // dpr), Image.Resampling.BOX)
        return np.asarray(logical), sha256(path.read_bytes()).hexdigest()


def edges(rgb):
    return cv2.Canny(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), 80, 160) > 0


def edge_match(a, b):
    if not a.any():
        return float(not b.any())
    if not b.any():
        return 0.0
    distance = cv2.distanceTransform((~b).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    return float((distance[a] <= 1).mean())


def metrics(a, b):
    diff = abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)
    changed = (diff > 12).astype(np.uint8)
    score = structural_similarity(a, b, channel_axis=-1, data_range=255)
    ea, eb = edges(a), edges(b)
    precision, recall = edge_match(ea, eb), edge_match(eb, ea)
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    h, w = changed.shape
    integral = cv2.integral(changed)
    xs = sorted(set(range(0, max(1, w - 31), 16)) | {max(0, w - 32)})
    ys = sorted(set(range(0, max(1, h - 31), 16)) | {max(0, h - 32)})
    blocks = []
    for y in ys:
        for x in xs:
            x1, y1 = min(x + 32, w), min(y + 32, h)
            total = integral[y1,x1] - integral[y,x1] - integral[y1,x] + integral[y,x]
            blocks.append((float(total / ((x1-x)*(y1-y))), x, y))
    worst, wx, wy = max(blocks)
    rate = float(changed.mean())
    return {
        "ssim": float(score), "different": rate, "edge_f1": f1,
        "worst_block": {"different": worst, "x": wx, "y": wy},
        "pass": bool(score >= 0.985 and rate <= 0.02 and f1 >= 0.97 and worst <= 0.08),
    }


def region(arg, w, h):
    name, box = arg.split("=", 1)
    x, y, width, height = map(int, box.split(","))
    if x < 0 or y < 0 or width < 7 or height < 7 or x + width > w or y + height > h:
        raise ValueError(f"region outside capture: {arg}")
    return name, (x, y, width, height)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("reference", type=Path)
    cli.add_argument("candidate", type=Path)
    cli.add_argument("--out", type=Path, required=True)
    cli.add_argument("--reference-dpr", type=int, choices=(1, 2, 3), default=1)
    cli.add_argument("--candidate-dpr", type=int, choices=(1, 2, 3), default=1)
    cli.add_argument("--region", action="append", default=[], metavar="NAME=X,Y,W,H")
    args = cli.parse_args()
    a, ref_hash = load(args.reference, args.reference_dpr)
    b, candidate_hash = load(args.candidate, args.candidate_dpr)
    if a.shape != b.shape:
        raise ValueError(f"different logical dimensions: {a.shape} vs {b.shape}")
    h,w=a.shape[:2]
    regions = [("full", (0,0,w,h)), *(region(s,w,h) for s in args.region)]
    if len({name for name, _ in regions}) != len(regions):
        raise ValueError("region names must be unique")
    scores = {name: {**metrics(a[y:y+height,x:x+width],b[y:y+height,x:x+width]), "box": [x,y,width,height]}
              for name,(x,y,width,height) in regions}
    passed = all(s["pass"] for s in scores.values())
    report = {
        "reference": str(args.reference), "reference_sha256": ref_hash, "reference_dpr": args.reference_dpr,
        "candidate": str(args.candidate), "candidate_sha256": candidate_hash, "candidate_dpr": args.candidate_dpr,
        "comparator_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
        "thresholds": {"ssim_min":0.985, "different_max":0.02, "channel_delta":12,
                       "edge_f1_min":0.97,"edge_tolerance":1,"block_max":0.08,"block_size":32,"block_stride":16},
        "regions": scores, "pixels_pass": passed,
    }
    args.out.mkdir(parents=True,exist_ok=True)
    (args.out / "metrics.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n")
    Image.blend(Image.fromarray(a),Image.fromarray(b),0.5).save(args.out / "overlay.png")
    diff = abs(a.astype(np.int16)-b.astype(np.int16)).max(axis=2)
    Image.fromarray(cv2.applyColorMap(np.minimum(255, diff*3).astype(np.uint8),cv2.COLORMAP_INFERNO)[:,:,::-1]).save(args.out / "difference.png")
    print(json.dumps(scores))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
