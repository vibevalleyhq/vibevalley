// The window at the notch and what is in it. The panel never becomes key or active, so the app in front stays in front;
// it is on every Space but not over full-screen apps (no fullScreenAuxiliary). Closed it is the strip beside the camera,
// with the count on the left and the waiting on the right; the pointer over it opens it to a row an issue.

import AppKit
import CoreText
import IslandCore
import SwiftUI

@MainActor
final class IslandModel: ObservableObject {
  @Published var glance = Glance.empty
  @Published var open = false
  /** The notch's width (0 without one): the middle of the strip the camera covers. */
  @Published var notchWidth: CGFloat = 0
  @Published var stripHeight: CGFloat = 24
}

/** Over the menu bar, not focusable. */
final class IslandPanel: NSPanel {
  init() {
    super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 3)
    collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    isMovable = false
    hidesOnDeactivate = false
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/** Takes the first click (the panel is never key) and says when the pointer comes and goes, active app or not. */
final class IslandHostingView<Content: View>: NSHostingView<Content> {
  var hovered: (Bool) -> Void = { _ in }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas where area.owner === self { removeTrackingArea(area) }
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { hovered(true) }
  override func mouseExited(with event: NSEvent) { hovered(false) }
}

@MainActor
final class IslandController {
  private let model = IslandModel()
  private let panel = IslandPanel()
  private var closing: DispatchWorkItem?

  private let font: String?

  init(fontPath: String?) {
    let font = fontPath.flatMap(registerFont)
    self.font = font
    let host = IslandHostingView(rootView: IslandView(model: model, font: font, onOpen: { [weak self] in self?.openIssue($0) }))
    host.hovered = { [weak self] inside in self?.hover(inside) }
    panel.contentView = host
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.place(animated: false) }
    }
  }

  func show(_ g: Glance) {
    model.glance = g
    // Nothing in flight and nothing waiting: the notch is left alone.
    guard !g.rows.isEmpty else {
      model.open = false
      panel.orderOut(nil)
      return
    }
    place(animated: panel.isVisible)
    if !panel.isVisible { panel.orderFrontRegardless() }
  }

  /**
   * For checking how it looks without screen recording: draws the island closed and open as it would be on the screen
   * it would use, into closed.png and open.png in dir, and writes where the panel would go to frames.txt.
   */
  func snapshot(into dir: String) {
    guard let screen = islandScreen() else { return }
    let shape = shapeOf(screen)
    var lines: [String] = []
    for open in [false, true] {
      model.open = open
      place(animated: false)
      let frame = IslandLayout.frame(on: shape, open: open, rows: model.glance.rows.count)
      lines.append("\(open ? "open" : "closed") \(frame)")
      let renderer = ImageRenderer(content: IslandView(model: model, font: font, onOpen: { _ in }).frame(width: frame.width, height: frame.height))
      renderer.scale = 2
      if let image = renderer.cgImage {
        let rep = NSBitmapImageRep(cgImage: image)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent(open ? "open.png" : "closed.png"))
      }
    }
    try? lines.joined(separator: "\n").write(toFile: dir + "/frames.txt", atomically: true, encoding: .utf8)
  }

  private func hover(_ inside: Bool) {
    closing?.cancel()
    if inside {
      setOpen(true)
    } else {
      // A short grace, so a pointer passing over the edge does not make it flicker.
      let item = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.setOpen(false) } }
      closing = item
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: item)
    }
  }

  private func setOpen(_ open: Bool) {
    guard model.open != open else { return }
    model.open = open
    place(animated: true)
  }

  private func openIssue(_ issue: String) {
    print(openLine(issue: issue))
    fflush(stdout)
    setOpen(false)
  }

  private func place(animated: Bool) {
    guard let screen = islandScreen() else { return }
    let shape = shapeOf(screen)
    model.notchWidth = shape.notch?.width ?? 0
    model.stripHeight = IslandLayout.stripHeight(shape)
    let frame = IslandLayout.frame(on: shape, open: model.open, rows: model.glance.rows.count)
    guard animated else { return panel.setFrame(frame, display: true) }
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.2
      context.timingFunction = CAMediaTimingFunction(name: .easeOut)
      panel.animator().setFrame(frame, display: true)
    }
  }
}

/** The built-in display when there is one (it has the notch), else the one with the menu bar. */
@MainActor
private func islandScreen() -> NSScreen? {
  let builtIn = NSScreen.screens.first { screen in
    guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { return false }
    return CGDisplayIsBuiltin(id) != 0
  }
  return builtIn ?? NSScreen.screens.first
}

@MainActor
private func shapeOf(_ screen: NSScreen) -> ScreenShape {
  let frame = screen.frame
  let notch = IslandLayout.notch(
    frame: frame,
    topInset: screen.safeAreaInsets.top,
    leftWidth: screen.auxiliaryTopLeftArea?.width ?? 0,
    rightWidth: screen.auxiliaryTopRightArea?.width ?? 0
  )
  return ScreenShape(frame: frame, notch: notch, menuBarHeight: frame.maxY - screen.visibleFrame.maxY)
}

/** The page's pixel font (apps/web public/fonts), for the island to read like the farm; its name, or nil. */
private func registerFont(_ path: String) -> String? {
  let url = URL(fileURLWithPath: path) as CFURL
  CTFontManagerRegisterFontsForURL(url, .process, nil)
  guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url) as? [CTFontDescriptor], let first = descriptors.first else { return nil }
  return CTFontDescriptorCopyAttribute(first, kCTFontNameAttribute) as? String
}

// The farm's colours (apps/web style.css): cream text, leaf for at work, wheat for waiting, red for stuck.
private let cream = Color(red: 0xEE / 255, green: 0xDC / 255, blue: 0xB2 / 255)
private let dim = Color(red: 0xA8 / 255, green: 0x9A / 255, blue: 0x7A / 255)
private func toneColor(_ tone: Tone) -> Color {
  switch tone {
  case .working: Color(red: 0x74 / 255, green: 0xA0 / 255, blue: 0x46 / 255)
  case .waiting: Color(red: 0xE5 / 255, green: 0xA9 / 255, blue: 0x3C / 255)
  case .stuck: Color(red: 0xC8 / 255, green: 0x4A / 255, blue: 0x3A / 255)
  }
}

/** Square at the top, where it meets the screen's edge; round below, like the notch. */
private struct IslandShape: Shape {
  var radius: CGFloat
  var animatableData: CGFloat {
    get { radius }
    set { radius = newValue }
  }

  func path(in r: CGRect) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: r.minX, y: r.minY))
    p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
    p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - radius))
    p.addQuadCurve(to: CGPoint(x: r.maxX - radius, y: r.maxY), control: CGPoint(x: r.maxX, y: r.maxY))
    p.addLine(to: CGPoint(x: r.minX + radius, y: r.maxY))
    p.addQuadCurve(to: CGPoint(x: r.minX, y: r.maxY - radius), control: CGPoint(x: r.minX, y: r.maxY))
    p.closeSubpath()
    return p
  }
}

struct IslandView: View {
  @ObservedObject var model: IslandModel
  let font: String?
  let onOpen: (String) -> Void

  private func text(_ size: CGFloat) -> Font { font.map { Font.custom($0, size: size) } ?? .system(size: size) }

  var body: some View {
    VStack(spacing: 0) {
      strip.frame(height: model.stripHeight)
      if model.open {
        VStack(spacing: 0) {
          ForEach(model.glance.rows.prefix(IslandLayout.maxRows)) { row in
            RowView(row: row, font: text(12), onOpen: onOpen)
          }
        }
        .padding(.vertical, IslandLayout.openPadding)
        .transition(.opacity)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(IslandShape(radius: model.open ? 16 : 10).fill(Color.black))
    .animation(.easeOut(duration: 0.2), value: model.open)
  }

  /** The count beside the camera, the waiting on its other side; on a screen without a notch, the two together. */
  private var strip: some View {
    HStack(spacing: 6) {
      HStack(spacing: 5) {
        Rectangle().fill(toneColor(.working)).frame(width: 7, height: 7)
        Text(model.glance.strip.working).font(text(12)).foregroundStyle(cream)
      }
      Spacer(minLength: model.notchWidth)
      if model.glance.waiting > 0 {
        Text(model.glance.strip.waiting).font(text(12)).foregroundStyle(toneColor(.waiting))
      }
    }
    .padding(.horizontal, 14)
  }
}

private struct RowView: View {
  let row: IslandRow
  let font: Font
  let onOpen: (String) -> Void
  @State private var hovered = false

  var body: some View {
    HStack(spacing: 8) {
      Rectangle().fill(toneColor(row.tone)).frame(width: 7, height: 7)
      Text("#\(row.number)").font(font).foregroundStyle(dim)
      Text(row.title).font(font).foregroundStyle(cream).lineLimit(1).truncationMode(.tail)
      Spacer(minLength: 8)
      Text(row.doing).font(font).foregroundStyle(row.tone == .working ? dim : toneColor(row.tone)).lineLimit(1).truncationMode(.tail)
    }
    .padding(.horizontal, 14)
    .frame(height: IslandLayout.rowHeight)
    .background(hovered ? Color.white.opacity(0.08) : Color.clear)
    .contentShape(Rectangle())
    .onHover { hovered = $0 }
    .onTapGesture { onOpen(row.issue) }
  }
}
