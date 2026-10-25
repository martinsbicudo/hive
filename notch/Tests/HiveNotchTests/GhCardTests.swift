import Foundation
import Testing
@testable import HiveNotch

@Suite struct GhCardTests {
    private let ghDisplay = #"""
    {"kind":"gh","command":"gh pr create","targets":[{"label":"Repository","value":"o/r"}],
     "flags":[{"label":"--title","value":"Fix[U+00A0]it"},{"label":"--label","value":"bug"},{"label":"--label","value":"ui"},{"label":"--draft","value":null}],
     "body":{"label":"--body","text":"Thanks 👨[U+200D]👩[U+200D]👧\nsecond line","lines":2,"chars":19}}
    """#

    @Test func decodesAHubStateHoldingAGhDisplay() throws {
        let json = """
        {"type":"state","state":{
          "agents":[],
          "approvals":[{"id":"p1","agentId":"a1","agentName":"Rita","toolName":"mcp__hive__github","summary":"gh pr create","createdAt":"2026-10-23T12:00:00.000Z","display":\(ghDisplay)}],
          "usage":[],
          "activity":[]
        }}
        """
        let state = try #require(try JSONDecoder().decode(HubEnvelope.self, from: Data(json.utf8)).state)
        guard case .gh(let gh) = try #require(state.approvals.first?.display) else { Issue.record("expected a gh display"); return }
        #expect(gh.kind == "gh")
        #expect(gh.shownCommand == "gh pr create")
        #expect(gh.shownTargets == [ApprovalDisplayField(label: "Repository", value: "o/r")])
        #expect(gh.shownFlags.map(\.label) == ["--title", "--label", "--label", "--draft"])
        #expect(gh.shownFlags.first?.value == "Fix[U+00A0]it")
        #expect(gh.shownFlags.last?.value == nil)
        #expect(gh.body?.heading == "--body · 2 lines · 19 characters")
        #expect(gh.shownBody == "Thanks 👨[U+200D]👩[U+200D]👧\nsecond line")
    }

    @Test func escapesAgainIfTheDaemonHadNot() throws {
        let raw = #"{"kind":"gh","command":"gh pr comment","targets":[{"label":"Pull request","value":"7\u00a0"}],"flags":[{"label":"--x","value":"a\u200db"}],"body":{"label":"--body","text":"hi\u3000there\u2800","lines":1,"chars":9}}"#
        guard case .gh(let gh) = try JSONDecoder().decode(ApprovalDisplay.self, from: Data(raw.utf8)) else { Issue.record("expected a gh display"); return }
        #expect(gh.shownTargets.first?.value == "7[U+00A0]")
        #expect(gh.shownFlags.first?.value == "a[U+200D]b")
        #expect(gh.shownBody == "hi\u{3000}there[U+2800]")
    }

    @Test func refusesAnUnknownDisplayKind() {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(ApprovalDisplay.self, from: Data(#"{"kind":"other","command":"x"}"#.utf8))
        }
    }

    @Test func storedMailDisplaysWithoutAKindStillDecode() throws {
        let raw = #"{"action":"Send an email","to":["a@example.com"],"fields":[{"label":"Subject","value":"Hi"}],"body":"Hello"}"#
        guard case .mail(let mail) = try JSONDecoder().decode(ApprovalDisplay.self, from: Data(raw.utf8)) else { Issue.record("expected a mail display"); return }
        #expect(mail.shownTo == ["a@example.com"])
        #expect(mail.shownBody == "Hello")
    }
}
