import SwiftUI

struct ApprovalDisplayField: Codable, Equatable {
    let label: String
    let value: String
}

struct MailDisplay: Codable, Equatable {
    let action: String
    let to: [String]
    let fields: [ApprovalDisplayField]
    let body: String?

    var toHeading: String { "To (\(to.count))" }
    var shownTo: [String] { to.map(OutwardText.visible) }
    var shownFields: [ApprovalDisplayField] { fields.map { ApprovalDisplayField(label: $0.label, value: OutwardText.visible($0.value)) } }
    var shownBody: String? { body.map(OutwardText.visibleBody) }
}

struct GhDisplayFlag: Codable, Equatable {
    let label: String
    let value: String?
}

struct GhDisplayBody: Codable, Equatable {
    let label: String
    let text: String
    let lines: Int
    let chars: Int

    var heading: String { "\(label) · \(lines) line\(lines == 1 ? "" : "s") · \(chars) character\(chars == 1 ? "" : "s")" }
}

struct GhDisplay: Codable, Equatable {
    let kind: String
    let command: String
    let targets: [ApprovalDisplayField]
    let flags: [GhDisplayFlag]
    let body: GhDisplayBody?

    var shownCommand: String { OutwardText.visible(command) }
    var shownTargets: [ApprovalDisplayField] { targets.map { ApprovalDisplayField(label: $0.label, value: OutwardText.visible($0.value)) } }
    var shownFlags: [GhDisplayFlag] { flags.map { GhDisplayFlag(label: $0.label, value: $0.value.map(OutwardText.visible)) } }
    var shownBody: String? { body.map { OutwardText.visibleBody($0.text) } }
}

/// A stored mail, Calendar or Messages card has no `kind`; a gh card has `"kind": "gh"`.
enum ApprovalDisplay: Codable, Equatable {
    case mail(MailDisplay)
    case gh(GhDisplay)

    private enum Keys: String, CodingKey { case kind }

    init(from decoder: Decoder) throws {
        let kind = try decoder.container(keyedBy: Keys.self).decodeIfPresent(String.self, forKey: .kind)
        switch kind {
        case nil: self = .mail(try MailDisplay(from: decoder))
        case "gh": self = .gh(try GhDisplay(from: decoder))
        default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "unknown display kind"))
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .mail(let display): try display.encode(to: encoder)
        case .gh(let display): try display.encode(to: encoder)
        }
    }
}

/// The daemon already escapes these; the notch escapes again so a card never renders a hidden character.
enum OutwardText {
    private static let controls: [ClosedRange<UInt32>] = [0x0000...0x0008, 0x000B...0x001F, 0x007F...0x009F, 0x2028...0x2029]
    private static let blanks: Set<UInt32> = [0x2800, 0x1D159]

    private static func hidden(_ scalar: Unicode.Scalar, body: Bool) -> Bool {
        let properties = scalar.properties
        if properties.isDefaultIgnorableCodePoint || properties.generalCategory == .format { return true }
        if controls.contains(where: { $0.contains(scalar.value) }) || blanks.contains(scalar.value) { return true }
        return properties.generalCategory == .spaceSeparator && scalar.value != 0x20 && !(body && scalar.value == 0x3000)
    }

    private static func escaped(_ text: String, body: Bool) -> String {
        var out = ""
        for scalar in text.unicodeScalars {
            if hidden(scalar, body: body) {
                out += "[U+\(String(format: "%04X", scalar.value))]"
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    /// For one-line fields: subjects, titles, recipients and gh values.
    static func visible(_ text: String) -> String { escaped(text, body: false) }

    /// Bodies keep U+3000, the ideographic space, which CJK prose uses as ordinary spacing.
    static func visibleBody(_ text: String) -> String { escaped(text, body: true) }
}

struct OutwardCardView: View {
    let agentName: String
    let display: ApprovalDisplay

    var body: some View {
        switch display {
        case .mail(let mail): MailCardView(agentName: agentName, display: mail)
        case .gh(let gh): GhCardView(agentName: agentName, display: gh)
        }
    }
}

private struct FieldRow: View {
    let label: String
    let value: String?
    var monospaced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 10.5, weight: .semibold, design: monospaced ? .monospaced : .default)).foregroundStyle(Theme.secondary)
            if let value {
                Text(value).font(.system(size: 11.5, design: monospaced ? .monospaced : .default)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            } else {
                Text("set (takes no value)").font(.system(size: 11.5)).foregroundStyle(Theme.secondary)
            }
        }
    }
}

private struct BodyBlock: View {
    let text: String

    var body: some View {
        ScrollView {
            Text(text)
                .font(.system(size: 11))
                .textSelection(.enabled)
                .lineLimit(nil)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
        }
        .frame(maxHeight: 160)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.05)))
    }
}

private struct GhCardView: View {
    let agentName: String
    let display: GhDisplay

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(agentName) wants to run").font(.system(size: 12, weight: .semibold))
            Text(display.shownCommand).font(.system(size: 11.5, design: .monospaced)).textSelection(.enabled)
            ForEach(Array(display.shownTargets.enumerated()), id: \.offset) { _, entry in
                FieldRow(label: entry.label, value: entry.value)
            }
            ForEach(Array(display.shownFlags.enumerated()), id: \.offset) { _, entry in
                FieldRow(label: entry.label, value: entry.value, monospaced: true)
            }
            if let block = display.body, let text = display.shownBody {
                Text(OutwardText.visible(block.heading)).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Theme.secondary)
                BodyBlock(text: text)
            }
        }
    }
}

private struct MailCardView: View {
    let agentName: String
    let display: MailDisplay

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(agentName) wants to: \(display.action)").font(.system(size: 12, weight: .semibold))
            if !display.to.isEmpty {
                Text(display.toHeading).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Theme.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(display.shownTo.enumerated()), id: \.offset) { _, address in
                        Text(address).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                    }
                }
            }
            ForEach(Array(display.shownFields.enumerated()), id: \.offset) { _, entry in
                FieldRow(label: entry.label, value: entry.value)
            }
            if let text = display.shownBody {
                BodyBlock(text: text)
            }
        }
    }
}
