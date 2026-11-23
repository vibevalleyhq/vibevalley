import { computed, safeArea, windowSize, type Accessor, type Edges } from "nsh";

export type LayoutMode = "compact" | "dual_pane";

/** Covers Android Foldables unfolded (~740-840dp), iPhone Duo (~740-840pt), and iPad mini (744pt). */
export const DUAL_PANE_MIN_WIDTH = 600;
export const NAV_RAIL_WIDTH = 72;

const MASTER_MIN_WIDTH = 280;
const MASTER_MAX_WIDTH = 360;
const MASTER_WIDTH_RATIO = 0.38;
const DETAIL_MIN_WIDTH = 220;

export interface MobileLayout {
  readonly mode: LayoutMode;
  readonly masterWidth: number;
  readonly isLandscape: boolean;
  readonly safe: Edges;
}

export function computeMobileLayout(size: { readonly width: number; readonly height: number }, safe: Edges): MobileLayout {
  const width = Number.isFinite(size.width) ? Math.max(0, size.width) : 0;
  const height = Number.isFinite(size.height) ? Math.max(0, size.height) : 0;
  const normalizedSafe: Edges = {
    top: Number.isFinite(safe.top) ? Math.max(0, safe.top) : 0,
    right: Number.isFinite(safe.right) ? Math.max(0, safe.right) : 0,
    bottom: Number.isFinite(safe.bottom) ? Math.max(0, safe.bottom) : 0,
    left: Number.isFinite(safe.left) ? Math.max(0, safe.left) : 0,
  };
  const mode: LayoutMode = width >= DUAL_PANE_MIN_WIDTH ? "dual_pane" : "compact";
  const usableWidth = Math.max(0, width - normalizedSafe.left - normalizedSafe.right);
  const desiredMaster = Math.min(MASTER_MAX_WIDTH, Math.max(MASTER_MIN_WIDTH, Math.round(width * MASTER_WIDTH_RATIO)));
  const maxMasterForDetail = Math.max(200, usableWidth - NAV_RAIL_WIDTH - DETAIL_MIN_WIDTH);
  const masterWidth = mode === "dual_pane" ? Math.min(desiredMaster, maxMasterForDetail) : usableWidth;

  return {
    mode,
    masterWidth,
    isLandscape: width > height,
    safe: normalizedSafe,
  };
}

export function useMobileLayout(): Accessor<MobileLayout> {
  return computed(() => computeMobileLayout(windowSize(), safeArea()));
}
