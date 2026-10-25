import Foundation
import Testing
@testable import HiveNotch

private struct BlankGlyphs: Decodable {
    let escapedEverywhere: [String]
    let escapedOnLinesOnly: [String]
    let neverEscaped: [String]
}

/// The list is shared with daemon/test/blankGlyphs.test.ts, so the notch and the daemon escape the same blanks.
@Suite struct BlankGlyphTests {
    private func glyphs() throws -> BlankGlyphs {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("daemon/test/blankGlyphs.json"))
        return try JSONDecoder().decode(BlankGlyphs.self, from: data)
    }

    private func sample(_ hex: String) throws -> (text: String, escaped: String) {
        let value = try #require(UInt32(hex, radix: 16))
        let scalar = try #require(Unicode.Scalar(value))
        var text = "a"
        text.unicodeScalars.append(scalar)
        return (text + "b", "a[U+\(hex)]b")
    }

    @Test func escapesTheSharedListOnLinesAndInBodies() throws {
        let list = try glyphs()
        for hex in list.escapedEverywhere {
            let (text, escaped) = try sample(hex)
            #expect(OutwardText.visible(text) == escaped, "line \(hex)")
            #expect(OutwardText.visibleBody(text) == escaped, "body \(hex)")
        }
        for hex in list.escapedOnLinesOnly {
            let (text, escaped) = try sample(hex)
            #expect(OutwardText.visible(text) == escaped, "line \(hex)")
            #expect(OutwardText.visibleBody(text) == text, "body \(hex)")
        }
        for hex in list.neverEscaped {
            let (text, _) = try sample(hex)
            #expect(OutwardText.visible(text) == text, "line \(hex)")
            #expect(OutwardText.visibleBody(text) == text, "body \(hex)")
        }
    }

    @Test func theSharedListHoldsEverySpaceSeparatorButThePlainSpace() throws {
        let list = try glyphs()
        let listed = Set((list.escapedEverywhere + list.escapedOnLinesOnly).compactMap { UInt32($0, radix: 16) })
        var missing: [UInt32] = []
        for value in UInt32(0)...UInt32(0x10FFFF) {
            guard let scalar = Unicode.Scalar(value), value != 0x20, scalar.properties.generalCategory == .spaceSeparator else { continue }
            if !listed.contains(value) { missing.append(value) }
        }
        #expect(missing.isEmpty)
    }
}
