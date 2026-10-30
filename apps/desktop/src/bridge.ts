// The one IPC channel the desktop's bridge (@vibevalley/protocol/host's desktopBridge) goes over, both ways: the preload
// sends calls on it, and main answers and pushes on it to the window's page.

export const bridgeChannel = "vibevalley:bridge";
