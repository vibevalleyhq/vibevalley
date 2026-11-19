// What the desktop app and the island say to each other: one JSON object a line, the app's on the island's stdin, the
// island's on its stdout. The shapes are apps/desktop src/island.ts's (Glance, IslandRow); keep the two the same.

import Foundation

/** How a row is drawn: at work, waiting on the owner, or stuck. */
public enum Tone: String, Codable, Sendable {
  case working
  case waiting
  case stuck
}

/** One issue in flight: who works it and what it is doing this moment, said by the app. */
public struct IslandRow: Codable, Equatable, Sendable, Identifiable {
  public var issue: String
  public var number: Int
  public var title: String
  public var doing: String
  public var tone: Tone

  public var id: String { issue }

  public init(issue: String, number: Int, title: String, doing: String, tone: Tone) {
    self.issue = issue
    self.number = number
    self.title = title
    self.doing = doing
    self.tone = tone
  }
}

/** The strip's two words, in the farm's language: the app writes them, the island only shows them. */
public struct Strip: Codable, Equatable, Sendable {
  public var working: String
  public var waiting: String

  public init(working: String, waiting: String) {
    self.working = working
    self.waiting = waiting
  }
}

/** The farm at a glance: how many at work, how many wait on the owner, the strip's words, and the rows, those waiting
 * first. */
public struct Glance: Codable, Equatable, Sendable {
  public var working: Int
  public var waiting: Int
  public var strip: Strip
  public var rows: [IslandRow]

  public init(working: Int, waiting: Int, strip: Strip, rows: [IslandRow]) {
    self.working = working
    self.waiting = waiting
    self.strip = strip
    self.rows = rows
  }

  public static let empty = Glance(working: 0, waiting: 0, strip: Strip(working: "", waiting: ""), rows: [])
}

private struct GlanceLine: Decodable {
  let glance: Glance
}

private struct OpenLine: Encodable {
  let open: String
}

/** A line from the app: {"glance": …}. Anything else (a line it does not know, a broken one) is nil. */
public func glance(fromLine line: String) -> Glance? {
  guard let data = line.data(using: .utf8) else { return nil }
  return try? JSONDecoder().decode(GlanceLine.self, from: data).glance
}

/** The line that asks the app to open an issue: {"open": "<issue id>"}. */
public func openLine(issue: String) -> String {
  let data = (try? JSONEncoder().encode(OpenLine(open: issue))) ?? Data()
  return String(decoding: data, as: UTF8.self)
}
