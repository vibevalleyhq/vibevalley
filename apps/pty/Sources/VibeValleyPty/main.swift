import Darwin
import Foundation
import PtyCore

signal(SIGPIPE, SIG_IGN)

let outQueue = DispatchQueue(label: "dev.vibevalley.pty.stdout")

let manager = PtyManager { event in
  let line = encodePtyEvent(event) + "\n"
  outQueue.async {
    FileHandle.standardOutput.write(Data(line.utf8))
  }
}

Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    guard let req = decodePtyRequest(line: line) else { continue }
    manager.handle(req)
  }
  manager.closeAll()
  outQueue.sync {}
  Darwin.exit(0)
}

dispatchMain()
