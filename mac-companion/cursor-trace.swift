// cursor-trace.swift — measure how the cursor actually moves on this Mac.
//
// The point is to see the *arrival* cadence of HID reports, not the cursor's
// speed. Poll the pointer as fast as CoreGraphics allows and record every
// position change with a timestamp. A smooth BLE link at the 7.5 ms
// connection interval shows regular 7-9 ms steps; a stuttering one shows
// clusters of 20-60 ms gaps.
//
// Usage:
//   swiftc -O cursor-trace.swift -o cursor-trace
//   ./cursor-trace [seconds] [output.csv]
//
// Coordinates are bottom-left origin, in points, as macOS reports them.

import CoreGraphics
import Foundation

let args = CommandLine.arguments
let duration = args.count > 1 ? (Double(args[1]) ?? 8.0) : 8.0
let csvPath = args.count > 2 ? args[2] : nil

func nowMs() -> Double {
    // mach_absolute_time is monotonic and cheap; Date() is not.
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    let t = mach_absolute_time()
    return Double(t) * Double(info.numer) / Double(info.denom) / 1_000_000.0
}

func cursor() -> CGPoint? {
    CGEvent(source: nil)?.location
}

guard var last = cursor() else {
    FileHandle.standardError.write(Data("cannot read cursor position\n".utf8))
    exit(1)
}

struct Step {
    let t: Double        // ms since start
    let dx: Double
    let dy: Double
    let x: Double
    let y: Double
}

var steps: [Step] = []
let start = nowMs()
var polls = 0

while true {
    let elapsed = nowMs() - start
    if elapsed >= duration * 1000.0 { break }
    polls += 1

    if let p = cursor(), p.x != last.x || p.y != last.y {
        steps.append(Step(t: elapsed, dx: Double(p.x - last.x),
                          dy: Double(p.y - last.y), x: Double(p.x), y: Double(p.y)))
        last = p
    }

    // 0.5 ms keeps us well below any plausible report interval while leaving
    // the CPU idle enough not to disturb the host scheduler.
    usleep(500)
}

let wall = nowMs() - start

func percentile(_ values: [Double], _ p: Double) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let idx = min(sorted.count - 1, max(0, Int((Double(sorted.count) - 1) * p)))
    return sorted[idx]
}

let gaps = zip(steps.dropFirst(), steps).map { $0.t - $1.t }
let absSteps = steps.map { abs($0.dx) + abs($0.dy) }
let totalUnits = absSteps.reduce(0, +)
let movementTime = (steps.first.map { steps.last!.t - $0.t }) ?? 0

print("cursor-trace: \(String(format: "%.1f", wall / 1000)) s, \(polls) polls")
print("updates: \(steps.count)  movement \(String(format: "%.0f", totalUnits)) units over \(String(format: "%.0f", movementTime)) ms")
if let first = steps.first, let lastStep = steps.last {
    print("from (\(String(format: "%.0f", first.x)), \(String(format: "%.0f", first.y))) to (\(String(format: "%.0f", lastStep.x)), \(String(format: "%.0f", lastStep.y)))")
}

if gaps.isEmpty {
    print("no movement seen — is the pointer inside the screen and BLE awake?")
} else {
    let mean = gaps.reduce(0, +) / Double(gaps.count)
    let variance = gaps.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(gaps.count)
    let sd = variance.squareRoot()
    let over20 = gaps.filter { $0 > 20 }.count
    let over30 = gaps.filter { $0 > 30 }.count
    let over50 = gaps.filter { $0 > 50 }.count

    print("")
    print("inter-update gap (ms)")
    print("  mean   \(String(format: "%6.2f", mean))   sd \(String(format: "%5.2f", sd))")
    print("  median \(String(format: "%6.2f", percentile(gaps, 0.50)))")
    print("  p90    \(String(format: "%6.2f", percentile(gaps, 0.90)))")
    print("  p99    \(String(format: "%6.2f", percentile(gaps, 0.99)))")
    print("  max    \(String(format: "%6.2f", gaps.max() ?? 0))")
    print("  >20 ms \(over20)   >30 ms \(over30)   >50 ms \(over50)")

    // A fixed 1-unit self-test should produce 1-unit steps. Anything larger
    // means reports were merged (the host or radio batched them).
    let multi = absSteps.filter { $0 > 1.5 }.count
    print("  multi-unit updates: \(multi) of \(steps.count)")

    var buckets = [Int](repeating: 0, count: 8)
    for g in gaps {
        let b: Int
        switch g {
        case ..<4: b = 0
        case ..<8: b = 1
        case ..<12: b = 2
        case ..<16: b = 3
        case ..<24: b = 4
        case ..<32: b = 5
        case ..<48: b = 6
        default: b = 7
        }
        buckets[b] += 1
    }
    let labels = ["<4", "4-8", "8-12", "12-16", "16-24", "24-32", "32-48", ">=48"]
    print("")
    print("gap histogram")
    for (i, n) in buckets.enumerated() where n > 0 {
        let bar = String(repeating: "#", count: max(1, n * 40 / max(1, buckets.max()!)))
        print("  \(labels[i].padding(toLength: 6, withPad: " ", startingAt: 0)) \(String(format: "%4d", n))  \(bar)")
    }
}

if let path = csvPath {
    var out = "t_ms,dx,dy,x,y\n"
    for s in steps {
        out += String(format: "%.3f,%.1f,%.1f,%.1f,%.1f\n", s.t, s.dx, s.dy, s.x, s.y)
    }
    try? out.write(toFile: path, atomically: true, encoding: .utf8)
    print("\nwrote \(path)")
}
