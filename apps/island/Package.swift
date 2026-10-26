// swift-tools-version: 6.0
// The island at the notch: a native helper the desktop app starts (apps/desktop src/island.ts). IslandCore holds what
// can be tested without a screen (the messages, where the island goes); VibeValleyIsland draws it.

import PackageDescription

let package = Package(
  name: "VibeValleyIsland",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "IslandCore"),
    .executableTarget(name: "VibeValleyIsland", dependencies: ["IslandCore"]),
    .testTarget(name: "IslandCoreTests", dependencies: ["IslandCore"]),
  ]
)
