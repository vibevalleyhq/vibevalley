"""Combine natural and fixed-input screenshot measurements from the same farm build."""

import argparse
import json
import os
from pathlib import Path


def read(path):
    return json.loads(path.read_text())


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("natural", type=Path)
    cli.add_argument("controlled", type=Path)
    cli.add_argument("--out", type=Path, required=True)
    args = cli.parse_args()
    common = {}
    modes = {}
    for mode, folder in [("natural", args.natural), ("fixed_ticks_firefly_seed", args.controlled)]:
        manifest = read(folder / "manifest.json")
        result = read(folder / "result.json")
        if result["comparison_mode"] != mode or manifest["comparison_mode"] != mode:
            cli.error(f"{folder} must contain a {mode} run")
        inputs = {k: manifest[k] for k in (
            "route", "frame_seq", "web_frame_sha256", "native_frame_sha256", "responses_sha256",
            "native_binary_sha256", "go_binary_sha256", "native_bundle_sha256", "native_assets_sha256",
        )}
        web = manifest["sources"]["web"]
        inputs["web_commit"] = web.get("commit") or web["producer_commit"]
        inputs["comparator_sha256"] = manifest["tools"]["compare-farm-frames.py"]
        cases = read(folder / "cases.json")
        inputs["scenes"] = [{k: v for k, v in case.items() if k != "motion"} for case in cases]
        first_pair = result["cases"][cases[0]["name"]]["pair"]
        inputs["thresholds"] = read(folder / first_pair["report"])["thresholds"]
        if common and common != inputs:
            cli.error("The runs have different inputs: " + ", ".join(k for k in inputs if common[k] != inputs[k]))
        common = inputs
        modes[mode] = {"directory": os.path.relpath(folder, args.out.parent), "web_dist_sha256": manifest["web_dist_sha256"],
                       "web_motion_patch_sha256": manifest.get("web_motion_patch_sha256"),
                       "motion": {case["name"]: case["motion"] for case in cases if "motion" in case},
                       "paired_pass": result["paired_pass"], "noise_within_thresholds": result["noise_within_thresholds"],
                       "cases": result["cases"]}
    args.out.write_text(json.dumps({"common": common, "modes": modes}, indent=2) + "\n")


if __name__ == "__main__":
    main()
