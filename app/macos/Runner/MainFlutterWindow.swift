import Cocoa
import FlutterMacOS

// The farm's window: the system's title bar hidden (its traffic lights stay) and the farm drawing its own 28 px bar
// (lib/desktop/desktop.dart desktopTitleBar), which moves the window when dragged. Sized to the pixel farm's screen
// (protocol GAME_SCREEN, 384×256) at the largest whole multiple the screen has room for, and snapped back to a whole
// multiple after a resize. Closing it keeps the farm
// running in the menu bar (AppDelegate).
class MainFlutterWindow: NSWindow, NSWindowDelegate {
  static let titleBar: CGFloat = 28
  static let screen = NSSize(width: 384, height: 256)
  static let minScale: CGFloat = 2
  /// Room kept around a new window on the screen.
  static let margin: CGFloat = 48

  var onHide: (() -> Void)?

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    self.contentViewController = flutterViewController
    RegisterGeneratedPlugins(registry: flutterViewController)
    // Before Dart's main can call it: the channel's first messages come from startDesktop, before the first frame.
    (NSApp.delegate as? AppDelegate)?.attach(flutterViewController)

    styleMask.insert(.fullSizeContentView)
    titlebarAppearsTransparent = true
    titleVisibility = .hidden
    backgroundColor = NSColor(red: 0x2b / 255, green: 0x33 / 255, blue: 0x20 / 255, alpha: 1)
    delegate = self
    let room = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
    contentMinSize = Self.atScale(Self.minScale)
    setContentSize(Self.atScale(Self.fittingScale(room, margin: Self.margin)))
    center()

    super.awakeFromNib()
  }

  static func atScale(_ scale: CGFloat) -> NSSize {
    NSSize(width: screen.width * scale, height: screen.height * scale + titleBar)
  }

  static func fittingScale(_ room: NSSize, margin: CGFloat) -> CGFloat {
    max(minScale, floor(min((room.width - margin) / screen.width, (room.height - margin - titleBar) / screen.height)))
  }

  /// The farm's title bar moves the window; a double click there does what the system's title bar would.
  override func sendEvent(_ event: NSEvent) {
    if event.type == .leftMouseDown, !styleMask.contains(.fullScreen), let view = contentView,
      event.locationInWindow.y >= view.bounds.height - Self.titleBar, !onTrafficLight(event.locationInWindow)
    {
      if event.clickCount == 2 {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        if action == "Minimize" { performMiniaturize(nil) } else if action != "None" { performZoom(nil) }
      } else {
        performDrag(with: event)
      }
      return
    }
    super.sendEvent(event)
  }

  private func onTrafficLight(_ point: NSPoint) -> Bool {
    [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].contains { type in
      guard let button = standardWindowButton(type), let parent = button.superview else { return false }
      return parent.convert(button.frame, to: nil).insetBy(dx: -2, dy: -2).contains(point)
    }
  }

  // The farm keeps its proportions while being resized: the width leads, the title bar is added to the height.
  func windowWillResize(_ sender: NSWindow, to frameSize: NSSize) -> NSSize {
    if styleMask.contains(.fullScreen) { return frameSize }
    let content = contentRect(forFrameRect: NSRect(origin: .zero, size: frameSize)).size
    let height = content.width * Self.screen.height / Self.screen.width + Self.titleBar
    return frameRect(forContentRect: NSRect(origin: .zero, size: NSSize(width: content.width, height: height))).size
  }

  // Let go after a resize: the nearest whole multiple, so the farm fills the window with no border.
  func windowDidEndLiveResize(_ notification: Notification) {
    if styleMask.contains(.fullScreen) || isZoomed { return }
    let now = contentRect(forFrameRect: frame).size
    let room = screen?.visibleFrame.size ?? now
    let nearest = (min(now.width / Self.screen.width, (now.height - Self.titleBar) / Self.screen.height)).rounded()
    let scale = min(Self.fittingScale(room, margin: 0), max(Self.minScale, nearest))
    let fit = Self.atScale(scale)
    if fit != now {
      var next = frameRect(forContentRect: NSRect(origin: .zero, size: fit))
      next.origin = NSPoint(x: frame.minX, y: frame.maxY - next.height)
      setFrame(next, display: true, animate: true)
    }
  }

  // Closing keeps the farm running in the menu bar, out of the Dock.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    orderOut(nil)
    onHide?()
    return false
  }
}
