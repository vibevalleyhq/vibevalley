import CoreGraphics
import Testing

@testable import IslandCore

@Suite struct Messages {
  @Test func readsAGlanceLine() {
    let line = #"{"glance":{"working":2,"waiting":1,"strip":{"working":"2 在干","waiting":"1 等你"},"rows":[{"issue":"i1","number":41,"title":"修登录页","doing":"阿狐 · 跑测试","tone":"working"}]}}"#
    #expect(
      glance(fromLine: line)
        == Glance(working: 2, waiting: 1, strip: Strip(working: "2 在干", waiting: "1 等你"), rows: [IslandRow(issue: "i1", number: 41, title: "修登录页", doing: "阿狐 · 跑测试", tone: .working)]))
  }

  @Test func skipsWhatItDoesNotKnow() {
    #expect(glance(fromLine: "not json") == nil)
    #expect(glance(fromLine: #"{"hello":1}"#) == nil)
    #expect(glance(fromLine: #"{"glance":{"working":1,"waiting":0,"strip":{"working":"1 在干","waiting":""},"rows":[{"issue":"i1","number":1,"title":"x","doing":"","tone":"napping"}]}}"#) == nil)
  }

  @Test func asksToOpenAnIssue() {
    #expect(openLine(issue: #"i"1"#) == #"{"open":"i\"1"}"#)
  }
}

@Suite struct Placement {
  // A 14-inch MacBook Pro: 1512 × 982 points, a 185-point notch 32 points tall.
  let laptop = CGRect(x: 0, y: 0, width: 1512, height: 982)

  @Test func findsTheNotchBetweenTheMenuBarsParts() {
    #expect(IslandLayout.notch(frame: laptop, topInset: 32, leftWidth: 663.5, rightWidth: 663.5) == CGRect(x: 663.5, y: 950, width: 185, height: 32))
    #expect(IslandLayout.notch(frame: laptop, topInset: 0, leftWidth: 0, rightWidth: 0) == nil)
  }

  @Test func growsOutOfTheNotch() {
    let notch = CGRect(x: 663.5, y: 950, width: 185, height: 32)
    let s = ScreenShape(frame: laptop, notch: notch, menuBarHeight: 32)
    let closed = IslandLayout.frame(on: s, open: false, rows: 3)
    #expect(closed.width == 185 + 2 * IslandLayout.wing)
    #expect(closed.maxY == 982 && closed.height == 32)
    #expect(abs(closed.midX - notch.midX) <= 0.5)
    let open = IslandLayout.frame(on: s, open: true, rows: 3)
    #expect(open.width == IslandLayout.openWidth)
    #expect(open.maxY == 982 && open.height == 32 + 10 + 3 * 28 + 10)
  }

  @Test func hangsATabFromAMenuBarWithoutANotch() {
    let screen = CGRect(x: 1512, y: 0, width: 2560, height: 1440)
    let s = ScreenShape(frame: screen, notch: nil, menuBarHeight: 24)
    let closed = IslandLayout.frame(on: s, open: false, rows: 2)
    #expect(closed == CGRect(x: 1512 + 1280 - 100, y: 1416, width: 200, height: 24))
  }

  @Test func showsSixRowsAtMost() {
    let s = ScreenShape(frame: laptop, notch: nil, menuBarHeight: 24)
    #expect(IslandLayout.frame(on: s, open: true, rows: 9).height == IslandLayout.frame(on: s, open: true, rows: 6).height)
    #expect(IslandLayout.frame(on: s, open: true, rows: 0).height == 24)
  }
}
