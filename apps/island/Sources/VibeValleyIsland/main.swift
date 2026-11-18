// The island: a helper with no Dock icon and no menu (an accessory app). The desktop app starts it and writes a glance
// a line on its stdin; it answers with the issue the owner clicked on its stdout. Its stdin closing means the app has
// gone, and so does the island. Usage: VibeValleyIsland [--font <path to the pixel font>] [--snapshot <dir>]
// --snapshot draws each glance into dir as well (Island.swift, snapshot), for checking how it looks.

import AppKit
import IslandCore

let arguments = CommandLine.arguments
func option(_ name: String) -> String? {
  arguments.firstIndex(of: name).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
}
let font = option("--font")
let snapshot = option("--snapshot")

let app = NSApplication.shared
// Before the app finishes launching: set later, AppKit may already have given it a Dock icon.
app.setActivationPolicy(.accessory)

let controller = MainActor.assumeIsolated { IslandController(fontPath: font) }

Thread.detachNewThread {
  while let line = readLine() {
    guard let g = glance(fromLine: line) else { continue }
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        controller.show(g)
        if let snapshot { controller.snapshot(into: snapshot) }
      }
    }
  }
  DispatchQueue.main.async { NSApp.terminate(nil) }
}

app.run()
