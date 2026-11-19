// Where the island goes on a screen, in AppKit's screen coordinates (origin bottom left, y up). On a screen with a
// notch it grows out of the notch: wings either side of the camera, as tall as the notch, and down from it when open.
// On a screen without one (an external display) it is a tab hanging from the middle of the menu bar.

import CoreGraphics

/** What the island needs to know of a screen. */
public struct ScreenShape: Equatable, Sendable {
  public var frame: CGRect
  /** The camera housing; nil on a screen without a notch. */
  public var notch: CGRect?
  public var menuBarHeight: CGFloat

  public init(frame: CGRect, notch: CGRect?, menuBarHeight: CGFloat) {
    self.frame = frame
    self.notch = notch
    self.menuBarHeight = menuBarHeight
  }
}

public enum IslandLayout {
  /** Each wing beside the notch: room for the count on the left and the waiting on the right. */
  public static let wing: CGFloat = 72
  /** The tab on a screen without a notch. */
  public static let tabWidth: CGFloat = 200
  public static let openWidth: CGFloat = 420
  public static let rowHeight: CGFloat = 28
  /** Space under the top strip and under the last row, when open. */
  public static let openPadding: CGFloat = 10
  /** At most this many rows are shown open; the rest are counted in the strip. */
  public static let maxRows = 6

  /** The notch as a rectangle in screen coordinates, from the parts of the menu bar either side of it. */
  public static func notch(frame: CGRect, topInset: CGFloat, leftWidth: CGFloat, rightWidth: CGFloat) -> CGRect? {
    let width = frame.width - leftWidth - rightWidth
    guard topInset > 0, width > 0 else { return nil }
    return CGRect(x: frame.minX + leftWidth, y: frame.maxY - topInset, width: width, height: topInset)
  }

  /** The strip at the top: the notch's height, or the menu bar's. */
  public static func stripHeight(_ s: ScreenShape) -> CGFloat {
    s.notch?.height ?? max(s.menuBarHeight, 24)
  }

  /** The island's frame: closed, the strip; open, the strip and its rows, wider. Centred on the notch (or the screen). */
  public static func frame(on s: ScreenShape, open: Bool, rows: Int) -> CGRect {
    let strip = stripHeight(s)
    let closedWidth = s.notch.map { $0.width + 2 * wing } ?? tabWidth
    let width = open ? max(closedWidth, openWidth) : closedWidth
    let shown = min(max(rows, 0), maxRows)
    let height = open && shown > 0 ? strip + openPadding + CGFloat(shown) * rowHeight + openPadding : strip
    let midX = s.notch?.midX ?? s.frame.midX
    return CGRect(x: (midX - width / 2).rounded(), y: s.frame.maxY - height, width: width, height: height)
  }
}
