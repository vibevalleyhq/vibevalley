import Foundation

public struct PtyRequest: Codable, Equatable, Sendable {
  public var op: String
  public var id: String
  public var reqId: Int?
  public var cwd: String?
  public var shell: String?
  public var args: [String]?
  public var cols: Int?
  public var rows: Int?
  public var env: [String: String]?
  public var data: String?

  public init(
    op: String,
    id: String,
    reqId: Int? = nil,
    cwd: String? = nil,
    shell: String? = nil,
    args: [String]? = nil,
    cols: Int? = nil,
    rows: Int? = nil,
    env: [String: String]? = nil,
    data: String? = nil
  ) {
    self.op = op
    self.id = id
    self.reqId = reqId
    self.cwd = cwd
    self.shell = shell
    self.args = args
    self.cols = cols
    self.rows = rows
    self.env = env
    self.data = data
  }
}

public struct PtyEvent: Codable, Equatable, Sendable {
  public var event: String
  public var id: String
  public var reqId: Int?
  public var pid: Int?
  public var data: String?
  public var code: Int?
  public var cwd: String?
  public var command: String?
  public var message: String?

  public init(
    event: String,
    id: String,
    reqId: Int? = nil,
    pid: Int? = nil,
    data: String? = nil,
    code: Int? = nil,
    cwd: String? = nil,
    command: String? = nil,
    message: String? = nil
  ) {
    self.event = event
    self.id = id
    self.reqId = reqId
    self.pid = pid
    self.data = data
    self.code = code
    self.cwd = cwd
    self.command = command
    self.message = message
  }
}

public func decodePtyRequest(line: String) -> PtyRequest? {
  guard let data = line.data(using: .utf8) else { return nil }
  return try? JSONDecoder().decode(PtyRequest.self, from: data)
}

public func encodePtyEvent(_ event: PtyEvent) -> String {
  let data = (try? JSONEncoder().encode(event)) ?? Data()
  return String(decoding: data, as: UTF8.self)
}
