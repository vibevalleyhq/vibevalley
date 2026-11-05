/** On macOS the window has no title bar. The preload hands this to the page (Host.titleBar). */
export const titleBar = { top: 28, left: 76 };

export const trafficLights = { x: 12, y: 8 };

/** The workbench's page in either theme (apps/web style.css). */
export const ground = (dark: boolean) => (dark ? "#151413" : "#fcfcfb");
