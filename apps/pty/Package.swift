// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "VibeValleyPty",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "CPty", publicHeadersPath: "include"),
    .target(name: "PtyCore", dependencies: ["CPty"]),
    .executableTarget(name: "VibeValleyPty", dependencies: ["PtyCore"]),
    .testTarget(name: "PtyCoreTests", dependencies: ["PtyCore"]),
  ]
)
