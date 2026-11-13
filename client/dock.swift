import AppKit
import ApplicationServices
import Foundation

let dir = NSHomeDirectory() + "/.claude-desk"
let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : dir + "/badges.json"
let asked = dir + "/.dock-asked"

func write(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj) {
        try? data.write(to: URL(fileURLWithPath: output), options: .atomic)
    }
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func badges() -> [String: Int]? {
    guard let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return nil }
    let app = AXUIElementCreateApplication(dock.processIdentifier)
    guard let lists = attr(app, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
    var out: [String: Int] = [:]
    for list in lists {
        for item in (attr(list, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
            guard let label = attr(item, "AXStatusLabel") as? String, !label.isEmpty,
                  let title = attr(item, kAXTitleAttribute) as? String, !title.isEmpty else { continue }
            let digits = label.filter { $0.isNumber }
            out[title] = Int(digits) ?? -1
        }
    }
    return out
}

if !AXIsProcessTrusted() && !FileManager.default.fileExists(atPath: asked) {
    FileManager.default.createFile(atPath: asked, contents: nil)
    _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
}

while true {
    let now = Int(Date().timeIntervalSince1970)
    if !AXIsProcessTrusted() {
        write(["ok": false, "error": "not_allowed", "at": now])
    } else if let b = badges() {
        write(["ok": true, "at": now, "badges": b])
    } else {
        write(["ok": false, "error": "dock", "at": now])
    }
    Thread.sleep(forTimeInterval: 10)
}
