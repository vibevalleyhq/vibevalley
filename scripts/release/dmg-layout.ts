import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dmgWindowLayout = {
  bounds: [120, 120, 800, 560] as const,
  iconSize: 128,
  textSize: 13,
  appPosition: [180, 210] as const,
  applicationsPosition: [500, 210] as const,
};

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildFinderLayoutScript(volumeName: string, appBundleFilename: string, mountPoint?: string): string {
  const [x1, y1, x2, y2] = dmgWindowLayout.bounds;
  const [appX, appY] = dmgWindowLayout.appPosition;
  const [appsX, appsY] = dmgWindowLayout.applicationsPosition;
  const body = [
    "    open",
    "    set current view of container window to icon view",
    "    set toolbar visible of container window to false",
    "    set statusbar visible of container window to false",
    `    set the bounds of container window to {${x1}, ${y1}, ${x2}, ${y2}}`,
    "    set viewOptions to the icon view options of container window",
    "    set arrangement of viewOptions to not arranged",
    `    set icon size of viewOptions to ${dmgWindowLayout.iconSize}`,
    `    set text size of viewOptions to ${dmgWindowLayout.textSize}`,
    '    set background picture of viewOptions to file ".background:background.png"',
    `    set position of item ${appleScriptString(appBundleFilename)} of container window to {${appX}, ${appY}}`,
    `    set position of item "Applications" of container window to {${appsX}, ${appsY}}`,
    "    close",
    "    open",
    "    update without registering applications",
    "    delay 1",
    "    close",
  ];
  if (mountPoint !== undefined) {
    return [
      `set targetDisk to (POSIX file ${appleScriptString(mountPoint)} as alias)`,
      'tell application "Finder"',
      "  repeat 20 times",
      "    if exists folder targetDisk then exit repeat",
      "    delay 0.25",
      "  end repeat",
      "  tell folder targetDisk",
      ...body,
      "  end tell",
      "end tell",
    ].join("\n");
  }
  const diskName = appleScriptString(volumeName);
  return [
    'tell application "Finder"',
    "  repeat 20 times",
    `    if exists disk ${diskName} then exit repeat`,
    "    delay 0.25",
    "  end repeat",
    `  tell disk ${diskName}`,
    ...body,
    "  end tell",
    "end tell",
  ].join("\n");
}

function parseAttachDevice(plistXml: string): string {
  const devMatch = /<key>dev-entry<\/key>\s*<string>(\/dev\/disk\d+)<\/string>/u.exec(plistXml);
  if (!devMatch?.[1]) throw new Error("hdiutil attach did not return a disk device");
  return devMatch[1];
}

function parseAttachMountPoint(plistXml: string): string | null {
  const mntMatch = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/u.exec(plistXml);
  return mntMatch?.[1] ?? null;
}

function copyTreeFast(src: string, dest: string): void {
  const res = spawnSync("cp", ["-cR", src, dest], { stdio: "ignore" });
  if (res.status !== 0) {
    cpSync(src, dest, { recursive: true });
  }
}

export interface StyledDmgOptions {
  appPath: string;
  bundleName: string;
  volumeName: string;
  backgroundPath: string;
  volumeIconPath?: string;
  outputPath: string;
}

export function createStyledDmg({ appPath, bundleName, volumeName, backgroundPath, volumeIconPath, outputPath }: StyledDmgOptions): void {
  const appBundleFilename = `${bundleName}.app`;
  const work = mkdtempSync(join(tmpdir(), "vv-dmg-"));
  const stage = join(work, "stage");
  const rwDmg = join(work, "rw.dmg");
  let device: string | null = null;

  try {
    mkdirSync(join(stage, ".background"), { recursive: true });
    copyTreeFast(appPath, join(stage, appBundleFilename));
    symlinkSync("/Applications", join(stage, "Applications"));
    cpSync(backgroundPath, join(stage, ".background", "background.png"));
    if (volumeIconPath) {
      // Reserve HFS+ volume space for the icon file before Finder layout runs.
      cpSync(volumeIconPath, join(stage, ".VolumeIcon.icns"));
    }

    // HFS+ reliably persists Finder .DS_Store background-picture aliases across macOS versions.
    execFileSync("hdiutil", ["create", "-volname", volumeName, "-srcfolder", stage, "-fs", "HFS+", "-format", "UDRW", "-ov", rwDmg], {
      stdio: "inherit",
    });

    const attachPlist = execFileSync("hdiutil", ["attach", "-readwrite", "-noverify", "-noautoopen", "-plist", rwDmg], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    device = parseAttachDevice(attachPlist);
    const mountPoint = parseAttachMountPoint(attachPlist) ?? `/Volumes/${volumeName}`;

    const script = buildFinderLayoutScript(volumeName, appBundleFilename, mountPoint);
    const layout = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
    if (layout.status !== 0) {
      // Headless CI runners lack a Finder WindowServer session; keep the DMG build succeeding.
      console.warn(`Warning: Finder DMG layout skipped (${layout.stderr.trim() || `exit ${layout.status}`})`);
    }

    // Finder's open/update/close clears volume custom-icon metadata and can drop dotfile icons, so stamp after layout.
    if (volumeIconPath) {
      const targetIcon = join(mountPoint, ".VolumeIcon.icns");
      cpSync(volumeIconPath, targetIcon);
      spawnSync("xcrun", ["SetFile", "-a", "V", targetIcon], { stdio: "ignore" });
      spawnSync("xcrun", ["SetFile", "-a", "C", mountPoint], { stdio: "ignore" });
    }

    execFileSync("sync");
    const detach = spawnSync("hdiutil", ["detach", device], { stdio: "inherit" });
    if (detach.status !== 0) {
      execFileSync("hdiutil", ["detach", "-force", device], { stdio: "inherit" });
    }
    device = null;

    rmSync(outputPath, { force: true });
    execFileSync("hdiutil", ["convert", rwDmg, "-format", "ULFO", "-o", outputPath], {
      stdio: "inherit",
    });
  } finally {
    if (device) {
      spawnSync("hdiutil", ["detach", "-force", device], { stdio: "ignore" });
    }
    rmSync(work, { recursive: true, force: true });
  }
}
