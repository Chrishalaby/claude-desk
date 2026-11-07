import EventKit
import Foundation

let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSHomeDirectory() + "/.claude-desk/calendar.json"

func write(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj) {
        try? data.write(to: URL(fileURLWithPath: output), options: .atomic)
    }
}

func allowed() -> Bool {
    let st = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) { return st == .fullAccess }
    return st.rawValue == 3
}

let now = Date()
if EKEventStore.authorizationStatus(for: .event) == .notDetermined {
    write(["ok": false, "error": "pending", "at": Int(now.timeIntervalSince1970)])
    let ask = EKEventStore()
    let done = DispatchSemaphore(value: 0)
    if #available(macOS 14.0, *) {
        ask.requestFullAccessToEvents { _, _ in done.signal() }
    } else {
        ask.requestAccess(to: .event) { _, _ in done.signal() }
    }
    _ = done.wait(timeout: .now() + 600)
}

guard allowed() else {
    let st = EKEventStore.authorizationStatus(for: .event)
    write(["ok": false, "error": st == .notDetermined ? "pending" : "not_allowed", "at": Int(Date().timeIntervalSince1970)])
    exit(0)
}

let store = EKEventStore()
let from = Date().addingTimeInterval(-3600)
let predicate = store.predicateForEvents(withStart: from, end: from.addingTimeInterval(37 * 3600), calendars: nil)
let events = store.events(matching: predicate)
    .filter { !$0.isAllDay && $0.status != .canceled }
    .sorted { $0.startDate < $1.startDate }
    .prefix(50)
    .map { e -> [String: Any] in
        ["t": e.title ?? "", "s": Int(e.startDate.timeIntervalSince1970), "e": Int(e.endDate.timeIntervalSince1970), "l": e.location ?? ""]
    }
write(["ok": true, "at": Int(Date().timeIntervalSince1970), "events": Array(events)])
