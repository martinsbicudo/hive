import Foundation
import Testing
@testable import HiveNotch

@Suite struct OutwardCardTests {
    private let recipients = (1...10).map { "person\($0)@example.com" }
    private let subject = String(repeating: "Quarterly numbers and the follow-up plan ", count: 5)

    private func approval(_ display: String) throws -> Approval {
        let json = #"{"id":"p1","agentId":"a1","agentName":"Mo","toolName":"mcp__hive__mail_send","summary":"mail_send to person1@example.com +9","createdAt":"2026-10-22T12:00:00.000Z","rememberable":false,"tainted":true,"display":"# + display + "}"
        return try JSONDecoder().decode(Approval.self, from: Data(json.utf8))
    }

    @Test func decodesTenRecipientsALongSubjectAndTheFullBody() throws {
        let to = try String(data: JSONEncoder().encode(recipients), encoding: .utf8) ?? "[]"
        let body = String(repeating: "line of text\n", count: 300)
        let bodyJSON = try String(data: JSONEncoder().encode(body), encoding: .utf8) ?? "\"\""
        let card = try approval(#"{"action":"Send an email","to":"# + to + #","fields":[{"label":"Subject","value":""# + subject + #""}],"body":"# + bodyJSON + "}")
        guard case .mail(let display) = try #require(card.display) else { Issue.record("expected a mail display"); return }
        #expect(card.tainted)
        #expect(display.toHeading == "To (10)")
        #expect(display.shownTo == recipients)
        #expect(display.shownFields.first?.label == "Subject")
        #expect(display.shownFields.first?.value == subject)
        #expect(display.shownBody == body)
    }

    @Test func showsHiddenCharactersAsVisibleEscapes() {
        #expect(OutwardText.visible("Zero\u{200B}width \u{202E}flipped\r\u{E0041}") == "Zero[U+200B]width [U+202E]flipped[U+000D][U+E0041]")
        #expect(OutwardText.visible("Tabs\tand\nlines stay") == "Tabs\tand\nlines stay")
    }

    @Test func escapesEveryDefaultIgnorableAndFormatScalar() {
        let hidden: [UInt32] = [
            0x00AD, 0x034F, 0x061C, 0x115F, 0x17B4, 0x17B5, 0x180B, 0x180D, 0x180F, 0x200D, 0x2065, 0x3164, 0xFE0F, 0xFEFF, 0xFFA0,
            0xFFF9, 0xFFFB, 0x1BCA0, 0x1BCA3, 0x1D173, 0x1D17A, 0xE0001, 0xE0100, 0xE01EF, 0xE0FFF,
        ]
        for value in hidden {
            let scalar = Unicode.Scalar(value) ?? "?"
            var text = "a"
            text.unicodeScalars.append(scalar)
            text += "b"
            #expect(OutwardText.visible(text) == "a[U+\(String(format: "%04X", value))]b")
        }
        #expect(OutwardText.visible("café 日本語 👍") == "café 日本語 👍")
    }

    @Test func plainApprovalsHaveNoDisplay() throws {
        let plain = try JSONDecoder().decode(Approval.self, from: Data(#"{"id":"p2","agentId":"a1","agentName":"Mo","toolName":"Bash","summary":"Bash: ls","createdAt":"2026-10-22T12:00:00.000Z"}"#.utf8))
        #expect(plain.display == nil)
        let calendar = try approval(#"{"action":"Create a calendar event","to":[],"fields":[{"label":"Title","value":"Review"}],"body":null}"#)
        guard case .mail(let display) = try #require(calendar.display) else { Issue.record("expected a mail display"); return }
        #expect(display.to.isEmpty)
        #expect(display.shownBody == nil)
    }
}
