import Foundation
import Testing
@testable import PtyCore

private final class EventBox: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [PtyEvent] = []

  func append(_ event: PtyEvent) {
    lock.lock()
    events.append(event)
    lock.unlock()
  }

  func snapshot() -> [PtyEvent] {
    lock.lock()
    defer { lock.unlock() }
    return events
  }

  func decodedText(id: String) -> String {
    let chunks = snapshot().compactMap { ev -> Data? in
      guard ev.event == "data", ev.id == id, let b64 = ev.data else { return nil }
      return Data(base64Encoded: b64)
    }
    var combined = Data()
    for chunk in chunks { combined.append(chunk) }
    return String(decoding: combined, as: UTF8.self)
  }

  func waitUntil(timeoutSeconds: Double = 5.0, _ predicate: ([PtyEvent]) -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
      if predicate(snapshot()) { return true }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return predicate(snapshot())
  }
}

@Suite("PtyCore")
struct PtyCoreTests {
  @Test("decodes requests and encodes events on single JSON lines")
  func messageCodec() {
    #expect(decodePtyRequest(line: "not-json") == nil)
    let line = #"{"op":"spawn","id":"t1","reqId":7,"cwd":"/tmp","cols":100,"rows":30}"#
    let req = decodePtyRequest(line: line)
    #expect(req == PtyRequest(op: "spawn", id: "t1", reqId: 7, cwd: "/tmp", cols: 100, rows: 30))

    let out = encodePtyEvent(PtyEvent(event: "spawned", id: "t1", reqId: 7, pid: 42))
    #expect(!out.contains("\n"))
    #expect(out.contains(#""event":"spawned""#))
    #expect(out.contains(#""pid":42"#))
  }

  @Test("spawns a shell, streams UTF-8 output, resizes, inspects cwd, and exits on kill")
  func ptyLifecycle() async {
    let box = EventBox()
    let manager = PtyManager { box.append($0) }
    defer { manager.closeAll() }

    manager.handle(
      PtyRequest(
        op: "spawn",
        id: "s1",
        reqId: 1,
        cwd: "/tmp",
        shell: "/bin/sh",
        args: [],
        cols: 80,
        rows: 24
      )
    )

    let spawned = await box.waitUntil { events in
      events.contains { $0.event == "spawned" && $0.id == "s1" && $0.reqId == 1 && ($0.pid ?? 0) > 0 }
    }
    #expect(spawned)

    let cmd1 = Data("printf 'CJK:%s\\n' '你好世界'; pwd\n".utf8).base64EncodedString()
    manager.handle(PtyRequest(op: "write", id: "s1", data: cmd1))

    let sawUtf8 = await box.waitUntil { _ in
      let text = box.decodedText(id: "s1")
      return text.contains("CJK:你好世界") && text.contains("/tmp")
    }
    #expect(sawUtf8)

    manager.handle(PtyRequest(op: "resize", id: "s1", cols: 132, rows: 42))
    let cmd2 = Data("cd /var/tmp && stty size && echo READY_INSPECT\n".utf8).base64EncodedString()
    manager.handle(PtyRequest(op: "write", id: "s1", data: cmd2))

    let sawResize = await box.waitUntil { _ in
      let text = box.decodedText(id: "s1")
      return text.contains("42 132") && text.contains("READY_INSPECT")
    }
    #expect(sawResize)

    manager.handle(PtyRequest(op: "inspect", id: "s1", reqId: 2))
    let sawInspect = await box.waitUntil { events in
      events.contains { $0.event == "inspected" && $0.id == "s1" && $0.reqId == 2 }
    }
    #expect(sawInspect)
    let inspected = box.snapshot().first { $0.event == "inspected" && $0.reqId == 2 }
    #expect(inspected?.cwd?.hasSuffix("/var/tmp") == true)
    #expect((inspected?.command ?? "").isEmpty == false)

    manager.handle(PtyRequest(op: "kill", id: "s1"))
    let sawExit = await box.waitUntil { events in
      events.contains { $0.event == "exit" && $0.id == "s1" }
    }
    #expect(sawExit)
  }
}
