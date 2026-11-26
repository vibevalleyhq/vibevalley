import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import sharp from "sharp";
import { createServer } from "vite-plus";

function sceneNames(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || !input.every((name) => typeof name === "string")) throw new Error("Missing website scene names");
  if (input.some((name) => !/^[a-z][a-z0-9-]*$/u.test(name))) throw new Error("Invalid website scene name");
  return input;
}

export async function prepareImages() {
  const root = resolve(import.meta.dirname, "..");
  const assets = resolve(root, "../../assets");
  const output = resolve(root, "public/gen/images");
  await mkdir(output, { recursive: true });
  const server = await createServer({
    root,
    configFile: false,
    publicDir: false,
    resolve: { alias: { "@game": assets } },
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const scene = await server.ssrLoadModule("/src/base/scene.ts");
    const scenes = sceneNames(scene.SCENES);
    const current = new Set<string>();
    const publish = async (file: string, bytes: Buffer) => {
      const name = `${basename(file).replace(/\.[^.]+$/u, "")}-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.webp`;
      await writeFile(resolve(output, name), bytes);
      current.add(name);
      return `/gen/images/${name}`;
    };
    const convert = async (file: string, quality: number, width?: number) => {
      const input = await readFile(file);
      const image = sharp(input).rotate();
      const metadata = await image.metadata();
      if (metadata.width === undefined || metadata.height === undefined || metadata.width === 0 || metadata.height === 0)
        throw new Error(`Missing image dimensions: ${file}`);
      if (width !== undefined) image.resize({ width, withoutEnlargement: true });
      const bytes = await image.webp({ quality }).toBuffer();
      return { src: await publish(file, bytes), width: metadata.width, height: metadata.height };
    };
    const backgrounds = Object.fromEntries(
      await Promise.all(
        scenes.map(async (hour) => {
          const variant = async (suffix: string, width: number, height: number) => {
            const file = resolve(assets, "site", `hero-${hour}${suffix}.webp`);
            const bytes = await readFile(file);
            const image = await sharp(bytes).metadata();
            if (image.format !== "webp" || image.width !== width || image.height !== height) throw new Error(`Expected a ${width} × ${height} WebP in ${file}`);
            return { src: await publish(file, bytes), width };
          };
          const [small, standard, large, portrait, portraitLarge] = await Promise.all([
            variant("-960", 960, 540),
            variant("", 1600, 900),
            variant("-3200", 3200, 1800),
            variant("-portrait-720", 720, 1280),
            variant("-portrait-1080", 1080, 1920),
          ]);
          const srcset = (images: (typeof small)[]) => images.map(({ src, width }) => `${src} ${width}w`).join(", ");
          return [hour, { src: standard.src, srcset: srcset([small, standard, large]), portraitSrcset: srcset([portrait, portraitLarge]) }];
        }),
      ),
    );
    const shots = Object.fromEntries(
      await Promise.all(
        ["native-farm.png", "native-workbench.png", "native-chat.png"].map(async (name) => {
          const file = resolve(root, "../../docs/images", name);
          const full = await convert(file, 80);
          const widths = [480, 720, 1080, full.width].filter((width, index, all) => width <= full.width && all.indexOf(width) === index);
          const copies = await Promise.all(widths.map((width) => convert(file, 80, width)));
          return [basename(name).replace(/\.[^.]+$/u, ""), { ...full, srcset: copies.map((copy, index) => `${copy.src} ${widths[index]}w`).join(", ") }];
        }),
      ),
    );
    const stale = (await readdir(output)).filter((name) => /-[a-f0-9]{12}\.webp$/u.test(name) && !current.has(name));
    await Promise.all(stale.map((name) => unlink(resolve(output, name))));
    await writeFile(resolve(root, "src/base/images.generated.json"), JSON.stringify({ backgrounds, shots }, null, 2) + "\n");
  } finally {
    await server.close();
  }
}
