import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import sharp from "sharp";
import { createServer } from "vite-plus";

function imageNames(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || !input.every((name) => typeof name === "string")) throw new Error("Missing website image names");
  if (input.some((name) => !/^[a-z][a-z0-9-]*$/u.test(name))) throw new Error("Invalid website image name");
  return input;
}

export async function prepareImages() {
  const root = resolve(import.meta.dirname, "..");
  const game = resolve(root, "../web/public");
  const output = resolve(root, "public/gen/images");
  await mkdir(output, { recursive: true });
  const server = await createServer({
    root,
    configFile: false,
    publicDir: false,
    resolve: { alias: { "@game": game } },
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const scene = await server.ssrLoadModule("/src/lib/scene.ts");
    const shown = imageNames(scene.SHOWN);
    const scenes = imageNames(scene.SCENES);
    const convert = async (file: string, quality: number, width?: number) => {
      const input = await readFile(file);
      const image = sharp(input).rotate();
      const metadata = await image.metadata();
      if (metadata.width === undefined || metadata.height === undefined || metadata.width === 0 || metadata.height === 0)
        throw new Error(`Missing image dimensions: ${file}`);
      if (width !== undefined) image.resize({ width, withoutEnlargement: true });
      const bytes = await image.webp({ quality }).toBuffer();
      const name = `${basename(file).replace(/\.[^.]+$/u, "")}-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.webp`;
      await writeFile(resolve(output, name), bytes);
      return { src: `/gen/images/${name}`, width: metadata.width, height: metadata.height };
    };
    const title = Object.fromEntries(await Promise.all(shown.map(async (name) => [name, (await convert(resolve(game, "title", `${name}.png`), 90)).src])));
    const backgrounds = Object.fromEntries(
      await Promise.all(scenes.map(async (name) => [name, (await convert(resolve(game, "pixel", `title-${name}.jpg`), 82)).src])),
    );
    const shots = Object.fromEntries(
      await Promise.all(
        ["farm.png", "title.jpg", "chat.png", "phone-chat.png", "phone-issues.png"].map(async (name) => {
          const file = resolve(root, "../../docs/images", name);
          const full = await convert(file, 80);
          const widths = [480, 720, 1080, full.width].filter((width, index, all) => width <= full.width && all.indexOf(width) === index);
          const copies = await Promise.all(widths.map((width) => convert(file, 80, width)));
          return [basename(name).replace(/\.[^.]+$/u, ""), { ...full, srcset: copies.map((copy, index) => `${copy.src} ${widths[index]}w`).join(", ") }];
        }),
      ),
    );
    await writeFile(resolve(root, "src/lib/images.generated.json"), JSON.stringify({ title, backgrounds, shots }, null, 2) + "\n");
  } finally {
    await server.close();
  }
}
