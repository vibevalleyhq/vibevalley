/** On macOS the window has no title bar: the page reaches the top edge and leaves a strip to drag the window by (top),
 * whose start the window's buttons take (left). The preload hands this to the page (Host.titleBar). */
export const titleBar = { top: 28, left: 76 };

export const trafficLights = { x: 12, y: 8 };

/** The workbench's page in either theme (apps/web style.css): what the window is painted with between one page and the
 * next, so a reload goes from the page to the same ground (apps/web public/opening.html) and back. */
export const ground = (dark: boolean) => (dark ? "#1d1813" : "#fffaf0");
