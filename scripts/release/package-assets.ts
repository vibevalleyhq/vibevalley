/** Excludes website-only (`apps/site`) files when copying `assets/` into the macOS `.app` bundle. */
export function shouldPackageAsset(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalized === "") return true;
  if (normalized === "title" || normalized.startsWith("title/")) return false;
  if (/^pixel\/title-[^/]+\.jpg$/u.test(normalized)) return false;
  return true;
}
