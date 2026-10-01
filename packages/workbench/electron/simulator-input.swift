import Foundation
import CoreGraphics
import ApplicationServices

struct InputRequest: Decodable {
  let id: Int
  let command: String
  let windowId: UInt32?
  let type: String?
  let x: Double?
  let y: Double?
  let prompt: Bool?
}

struct InputResponse: Encodable {
  let id: Int
  let ok: Bool
  let trusted: Bool?
  let message: String?
}

func writeResponse(_ response: InputResponse) {
  let encoder = JSONEncoder()
  guard
    let data = try? encoder.encode(response),
    let line = String(data: data, encoding: .utf8)
  else {
    return
  }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func accessibilityTrusted(prompt: Bool) -> Bool {
  let options = [
    kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt
  ] as CFDictionary
  return AXIsProcessTrustedWithOptions(options)
}

func windowTarget(windowId: CGWindowID) -> (pid: pid_t, bounds: CGRect)? {
  guard
    let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowId) as? [[String: Any]],
    let row = rows.first,
    let pidNumber = row[kCGWindowOwnerPID as String] as? NSNumber,
    let boundsDictionary = row[kCGWindowBounds as String] as? NSDictionary,
    let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
  else {
    return nil
  }

  return (pidNumber.int32Value, bounds)
}

func eventType(_ type: String) -> CGEventType? {
  switch type {
  case "down":
    return .leftMouseDown
  case "drag":
    return .leftMouseDragged
  case "up":
    return .leftMouseUp
  default:
    return nil
  }
}

func handle(_ request: InputRequest) -> InputResponse {
  if request.command == "permission" {
    let trusted = accessibilityTrusted(prompt: request.prompt == true)
    return InputResponse(id: request.id, ok: true, trusted: trusted, message: nil)
  }

  guard request.command == "pointer" else {
    return InputResponse(id: request.id, ok: false, trusted: nil, message: "Unknown input helper command.")
  }

  guard accessibilityTrusted(prompt: false) else {
    return InputResponse(
      id: request.id,
      ok: false,
      trusted: false,
      message: "Accessibility permission is required for Simulator input forwarding."
    )
  }

  guard
    let rawWindowId = request.windowId,
    let type = request.type,
    let x = request.x,
    let y = request.y,
    let mouseType = eventType(type)
  else {
    return InputResponse(id: request.id, ok: false, trusted: true, message: "Invalid pointer payload.")
  }

  guard let target = windowTarget(windowId: CGWindowID(rawWindowId)) else {
    return InputResponse(id: request.id, ok: false, trusted: true, message: "Simulator window is no longer available.")
  }

  let nx = min(1, max(0, x))
  let ny = min(1, max(0, y))
  let point = CGPoint(
    x: target.bounds.minX + target.bounds.width * nx,
    y: target.bounds.minY + target.bounds.height * ny
  )

  guard let event = CGEvent(
    mouseEventSource: nil,
    mouseType: mouseType,
    mouseCursorPosition: point,
    mouseButton: .left
  ) else {
    return InputResponse(id: request.id, ok: false, trusted: true, message: "Could not create Quartz pointer event.")
  }

  event.postToPid(target.pid)
  return InputResponse(id: request.id, ok: true, trusted: true, message: nil)
}

while let line = readLine() {
  guard
    let data = line.data(using: .utf8),
    let request = try? JSONDecoder().decode(InputRequest.self, from: data)
  else {
    continue
  }

  writeResponse(handle(request))
}