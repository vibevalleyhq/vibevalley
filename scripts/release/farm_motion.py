"""Input adapters for a fixed-tick capture of the pinned Web farm. No rendered state is transferred."""

import difflib
from pathlib import Path
import shutil
import subprocess
import tempfile


def instrument_web(web_root, out, build):
    revision = subprocess.check_output(["git", "-C", web_root, "rev-parse", "HEAD"], text=True).strip()
    with tempfile.TemporaryDirectory(prefix="farm-motion-source-", dir=out) as temporary:
        root = Path(temporary)
        archive = root / "source.tar"
        with archive.open("wb") as stream:
            subprocess.run(["git", "-C", web_root, "archive", revision], stdout=stream, check=True)
        subprocess.run(["tar", "-xf", archive], cwd=root, check=True)
        archive.unlink()
        patches = []
        def adapt(name, transform):
            file = root / name
            before = file.read_text()
            after = transform(before)
            patches.extend(difflib.unified_diff(before.splitlines(True), after.splitlines(True), "a/" + name, "b/" + name))
            file.write_text(after)

        def once(text, old, new):
            if text.count(old) != 1:
                raise ValueError("The Go reference changed; check the simulation input boundary before capturing")
            return text.replace(old, new, 1)

        def flies(text):
            text = once(text, "  const fireflies = blinkers(shine, {", """  const fireflies = (() => {
    const previous = Math.random;
    let seed = window.__vvMotion.fireflySeed;
    Math.random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) / 16777216;
    };
    try {
      return blinkers(shine, {""")
            text = once(text, "  });\n  let flash = 0;", """      });
    } finally {
      Math.random = previous;
    }
  })();
  let flash = 0;""")

            return once(text, "    lights.push(...fireflies.update(t, night > 0.4 ? (night - 0.4) / 0.6 : 0));", """    const activeFlies = fireflies.update(t, night > 0.4 ? (night - 0.4) / 0.6 : 0);
    window.__vvMotion.fireflyLights = activeFlies.map((light) => [light.x, light.y, light.intensity]);
    lights.push(...activeFlies);""")

        def clock(text):
            return once(text, """  const tick = () => {
    const dt = Math.min(0.1, app.ticker.deltaMS / 1000);""", """  const tick = () => {
    const capture = window.__vvMotion;
    if (input().frame?.seq !== capture.seq || capture.advanced >= capture.ticks) return;
    capture.advanced++;
    const dt = 1 / 60;""")

        adapt("apps/web/src/farm/canvas/life.ts", flies)
        adapt("apps/web/src/farm/canvas/scene.ts", clock)
        (root / "apps/web/src/farm-motion.d.ts").write_text(
            "interface Window { __vvMotion: { seq: number; ticks: number; advanced: number; fireflySeed: number; fireflyLights?: number[][] } }\n"
        )
        (out / "web-motion-inputs.patch").write_text("".join(patches))
        log = out / "build.log"
        build(["vp", "install", "--frozen-lockfile", "--offline", "--ignore-scripts"], root, log)
        build(["vp", "run", "packages:build"], root, log)
        build(["vp", "run", "--filter", "@vibevalley/web", "build"], root, log)
        return Path(shutil.copytree(root / "apps/web/dist", out / "controlled-web-dist"))
