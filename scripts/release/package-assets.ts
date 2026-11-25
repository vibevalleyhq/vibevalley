/** Excludes website-only (`apps/site`) files when copying `assets/` into the macOS `.app` bundle. */
export function shouldPackageAsset(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalized === "") return true;
  if (normalized === "site" || normalized.startsWith("site/")) return false;
  return true;
}
