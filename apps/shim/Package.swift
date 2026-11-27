// swift-tools-version: 6.0
// The local app shim for VibeValley notes: ShimCore holds the wire protocol, bundle/CLI configuration, and
// geometry/key mapping that can be tested without a screen; VibeValleyShim runs the NSApplication window.

import PackageDescription

let package = Package(
  name: "VibeValleyShim",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "ShimCore"),
    .executableTarget(name: "VibeValleyShim", dependencies: ["ShimCore"]),
    .testTarget(name: "ShimCoreTests", dependencies: ["ShimCore"]),
  ]
)
