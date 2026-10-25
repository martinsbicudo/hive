import Foundation
import Testing
@testable import HiveNotch

private let macBook = ScreenInfo(
    id: "MBP", name: "Built-in", frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
    menuBarHeight: 38, hardwareNotchWidth: 180
)
private let external = ScreenInfo(
    id: "EXT", name: "Ultrawide", frame: CGRect(x: 1512, y: 0, width: 3440, height: 1440),
    menuBarHeight: 25, hardwareNotchWidth: nil
)

private func standard(_ style: NotchStyle) -> NotchLayout { NotchLayoutLimits.of(style).standard }

private func size(_ style: NotchStyle, _ screen: ScreenInfo) -> CGSize {
    NotchGeometry.collapsedSize(style: style, screen: screen, layout: standard(style))
}

private func zone(_ style: NotchStyle, _ screen: ScreenInfo) -> CGRect {
    NotchGeometry.hotZone(style: style, screen: screen, layout: standard(style))
}

@Suite struct NotchGeometryTests {
    @Test func notchStyleWrapsTheHardwareNotchWithWings() {
        #expect(size(.notch, macBook) == CGSize(width: 180 + 2 * NotchGeometry.wingWidth, height: 38))
    }

    @Test func notchStyleOnAScreenWithoutNotchUsesTheSimulatedWidth() {
        #expect(size(.notch, external) == CGSize(width: NotchGeometry.simulatedNotchWidth, height: 25))
    }

    @Test func islandAndMinimalStartAtTheirOriginalSizesAndHiddenHasNone() {
        #expect(size(.island, macBook) == NotchGeometry.islandSize)
        #expect(size(.minimal, external) == NotchGeometry.minimalSize)
        #expect(size(.hidden, macBook) == .zero)
    }

    @Test func windowIsCenteredOnTheTopEdgeOfItsScreen() {
        let frame = NotchGeometry.windowFrame(screen: external)
        #expect(frame.midX == external.frame.midX)
        #expect(frame.maxY == external.frame.maxY)
        #expect(frame.size == NotchGeometry.expandedSize)
    }

    @Test func hoveringTheCollapsedNotchIsInsideTheHotZone() {
        let zone = zone(.notch, macBook)
        #expect(zone.contains(CGPoint(x: macBook.frame.midX, y: macBook.frame.maxY - 1)))
        #expect(!zone.contains(CGPoint(x: macBook.frame.midX, y: macBook.frame.maxY - 100)))
        #expect(!zone.contains(CGPoint(x: 10, y: macBook.frame.maxY - 1)))
    }

    @Test func islandHotZoneSitsBelowTheGap() {
        let zone = zone(.island, external)
        let top = external.frame.maxY - NotchGeometry.islandGap + NotchGeometry.hoverMargin
        #expect(zone.maxY == top)
    }

    @Test func hiddenStyleNeverExpands() {
        #expect(zone(.hidden, macBook).isNull)
    }

    @Test func defaultStyleFollowsTheHardware() {
        #expect(NotchGeometry.defaultStyle(for: macBook) == .notch)
        #expect(NotchGeometry.defaultStyle(for: external) == .island)
    }
}

@Suite struct NotchLayoutTests {
    @Test func narrowerWingsShrinkTheNotchButNeverBelowTheHardwareNotch() {
        let narrow = NotchGeometry.collapsedSize(style: .notch, screen: macBook, layout: NotchLayout(width: 40, height: 0, offset: 0))
        #expect(narrow == CGSize(width: 180 + 80, height: 38))
        let limits = NotchLayoutLimits.of(.notch)
        #expect(limits.clamped(NotchLayout(width: 0, height: -5, offset: 30)) == NotchLayout(width: 40, height: 0, offset: 0))
    }

    @Test func extraHeightHangsTheNotchBelowTheMenuBar() {
        let taller = NotchGeometry.collapsedSize(style: .notch, screen: macBook, layout: NotchLayout(width: 84, height: 8, offset: 0))
        #expect(taller.height == 46)
    }

    @Test func theNotchStaysAttachedToTheTopWhateverTheOffset() {
        let layout = NotchLayout(width: 84, height: 0, offset: 25)
        #expect(NotchGeometry.topInset(style: .notch, layout: layout) == 0)
        #expect(NotchGeometry.hotZone(style: .notch, screen: macBook, layout: layout).maxY == macBook.frame.maxY + NotchGeometry.hoverMargin)
    }

    @Test func movingTheIslandDownMovesWhereHoveringOpensIt() {
        let layout = NotchLayout(width: 180, height: 30, offset: 24)
        let zone = NotchGeometry.hotZone(style: .island, screen: external, layout: layout)
        #expect(zone.maxY == external.frame.maxY - 24 + NotchGeometry.hoverMargin)
        #expect(zone.height == 30 + 2 * NotchGeometry.hoverMargin)
        #expect(zone.width == 180 + 2 * NotchGeometry.hoverMargin)
        #expect(!zone.contains(CGPoint(x: external.frame.midX, y: external.frame.maxY - 2)))
    }

    @Test func limitsKeepEveryStyleInsideTheWindowAndFixBrokenValues() {
        for style in NotchStyle.allCases {
            let limits = NotchLayoutLimits.of(style)
            #expect(limits.clamped(limits.standard) == limits.standard)
            let widest = NotchLayout(width: .greatestFiniteMagnitude, height: .greatestFiniteMagnitude, offset: .greatestFiniteMagnitude)
            let big = NotchGeometry.collapsedSize(style: style, screen: macBook, layout: limits.clamped(widest))
            #expect(big.width <= NotchGeometry.expandedSize.width)
            #expect(big.height + NotchGeometry.topInset(style: style, layout: limits.clamped(widest)) < NotchGeometry.expandedSize.height)
            #expect(limits.clamped(NotchLayout(width: .nan, height: .infinity, offset: .nan)) == limits.standard)
        }
    }

    @MainActor @Test func narrowShapesSwitchToCompactContent() {
        let model = NotchModel(screen: macBook, style: .notch, layout: standard(.notch))
        #expect(!model.compact)
        model.layout.width = 60
        #expect(model.compact)
        model.style = .island
        model.layout = NotchLayout(width: 160, height: 34, offset: 6)
        #expect(model.compact)
        model.style = .minimal
        model.layout = NotchLayout(width: 36, height: 12, offset: 0)
        #expect(!model.compact)
    }
}

@Suite struct NotchStyleStoreTests {
    private func makeStore() -> NotchStyleStore {
        let suite = "hive.tests.\(UUID().uuidString)"
        return NotchStyleStore(defaults: UserDefaults(suiteName: suite) ?? .standard)
    }

    @Test func unknownScreensGetTheDefaultStyle() {
        let store = makeStore()
        #expect(store.style(for: macBook) == .notch)
        #expect(store.style(for: external) == .island)
    }

    @Test func eachScreenRemembersItsOwnStyle() {
        let store = makeStore()
        store.setStyle(.minimal, for: external)
        store.setStyle(.hidden, for: macBook)
        #expect(store.style(for: external) == .minimal)
        #expect(store.style(for: macBook) == .hidden)
    }

    @Test func layoutsAreKeptPerScreenAndPerStyle() {
        let store = makeStore()
        store.setLayout(NotchLayout(width: 50, height: 4, offset: 0), for: macBook, style: .notch)
        store.setLayout(NotchLayout(width: 260, height: 40, offset: 20), for: external, style: .island)
        #expect(store.layout(for: macBook, style: .notch) == NotchLayout(width: 50, height: 4, offset: 0))
        #expect(store.layout(for: external, style: .island) == NotchLayout(width: 260, height: 40, offset: 20))
        #expect(store.layout(for: external, style: .notch) == standard(.notch))
        #expect(store.layout(for: macBook, style: .island) == standard(.island))
    }

    @Test func savedLayoutsAreClampedBothWays() {
        let store = makeStore()
        store.setLayout(NotchLayout(width: 999, height: 1, offset: -9), for: external, style: .island)
        #expect(store.layout(for: external, style: .island) == NotchLayout(width: 320, height: 26, offset: 0))
    }

    @Test func resettingAScreenLeavesTheOthersAlone() {
        let store = makeStore()
        store.setLayout(NotchLayout(width: 50, height: 4, offset: 0), for: macBook, style: .notch)
        store.setLayout(NotchLayout(width: 40, height: 12, offset: 10), for: macBook, style: .minimal)
        store.setLayout(NotchLayout(width: 260, height: 40, offset: 20), for: external, style: .island)
        store.setStyle(.minimal, for: macBook)
        store.resetLayouts(for: macBook)
        #expect(store.layout(for: macBook, style: .notch) == standard(.notch))
        #expect(store.layout(for: macBook, style: .minimal) == standard(.minimal))
        #expect(store.style(for: macBook) == .minimal)
        #expect(store.layout(for: external, style: .island) == NotchLayout(width: 260, height: 40, offset: 20))
    }

    @Test func anUnreadableLayoutFallsBackToTheStandardOne() {
        let suite = "hive.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        defaults.set(Data("not json".utf8), forKey: "notchLayout.EXT.island")
        defaults.set("wide", forKey: "notchLayout.MBP.notch")
        let store = NotchStyleStore(defaults: defaults)
        #expect(store.layout(for: external, style: .island) == standard(.island))
        #expect(store.layout(for: macBook, style: .notch) == standard(.notch))
    }

    @Test func aCorruptedValueFallsBackToTheDefault() {
        let suite = "hive.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        defaults.set("sparkles", forKey: "notchStyle.EXT")
        #expect(NotchStyleStore(defaults: defaults).style(for: external) == .island)
    }
}

@Suite struct FormatTests {
    private let start = "2026-10-21T12:00:00.000Z"

    private func at(_ seconds: TimeInterval) -> Date {
        (Format.date(start) ?? Date.distantPast).addingTimeInterval(seconds)
    }

    @Test func elapsedTimeScalesFromSecondsToHours() {
        #expect(Format.elapsed(since: start, now: at(11)) == "11s")
        #expect(Format.elapsed(since: start, now: at(125)) == "2m 5s")
        #expect(Format.elapsed(since: start, now: at(3 * 3600 + 7 * 60)) == "3h 7m")
    }

    @Test func elapsedNeverGoesNegativeAndIgnoresBadDates() {
        #expect(Format.elapsed(since: start, now: at(-30)) == "0s")
        #expect(Format.elapsed(since: "yesterday", now: at(0)) == "")
    }

    @Test func dollarsShowTinyAmountsHonestly() {
        #expect(Format.usd(0) == "$0")
        #expect(Format.usd(0.004) == "<$0.01")
        #expect(Format.usd(1.236) == "$1.24")
    }

    @Test func tokensUseCompactUnits() {
        #expect(Format.tokens(950) == "950")
        #expect(Format.tokens(63_400) == "63k")
        #expect(Format.tokens(2_450_000) == "2.5M")
    }
}

@Suite struct HubStateDecodingTests {
    @Test func decodesTheDaemonStateMessage() throws {
        let json = """
        {"type":"state","state":{
          "agents":[{"id":"a1","name":"Iris","role":"Software Engineer","engine":"claude-code","model":"auto",
                     "avatarSeed":"iris","status":"waiting-approval","activity":null,"instructions":"extra fields are ignored"}],
          "approvals":[{"id":"p1","agentId":"a1","agentName":"Iris","toolName":"Bash","summary":"Bash: ls","createdAt":"2026-10-21T12:00:00.000Z"}],
          "usage":[{"engine":"codex","agents":1,"activeRuns":0,"todayUsd":0,"weekUsd":0,"monthUsd":0,"todayTokens":1200}],
          "activity":[]
        }}
        """
        let envelope = try JSONDecoder().decode(HubEnvelope.self, from: Data(json.utf8))
        let state = try #require(envelope.state)
        #expect(envelope.type == "state")
        #expect(state.agents.first?.isWorking == true)
        #expect(state.approvals.first?.summary == "Bash: ls")
        #expect(state.usage.first?.displayName == "Codex")
        #expect(state.usage.first?.reportsCost == false)
    }

    @Test func approvalsDecodeRememberableAndDefaultToFalse() throws {
        let base = #""id":"p1","agentId":"a1","agentName":"Iris","toolName":"Bash","summary":"Bash: ls","createdAt":"2026-10-21T12:00:00.000Z""#
        let remembered = try JSONDecoder().decode(Approval.self, from: Data("{\(base),\"rememberable\":true}".utf8))
        let missing = try JSONDecoder().decode(Approval.self, from: Data("{\(base)}".utf8))
        #expect(remembered.rememberable)
        #expect(!missing.rememberable)
        #expect(!missing.isTaskGate)
        let gate = try JSONDecoder().decode(Approval.self, from: Data("{\(base),\"rememberable\":false,\"targetAgentId\":\"a2\"}".utf8))
        #expect(gate.isTaskGate)
        #expect(gate.showsFullText)
        #expect(!missing.showsFullText)
        let github = try JSONDecoder().decode(Approval.self, from: Data(#"{"id":"p2","agentId":"a1","agentName":"Iris","toolName":"mcp__hive__github","summary":"gh pr comment 7 --repo o/r --body 'long'","createdAt":"2026-10-21T12:00:00.000Z"}"#.utf8))
        #expect(github.showsFullText)
        #expect(!github.isTaskGate)
    }

    @Test func activityCarriesTheTaskWhenPresentAndDefaultsToNone() throws {
        let base = #""agentId":"a1","name":"Iris","role":"Engineer","detail":"Thinking…","since":"2026-10-21T12:00:00.000Z","queued":0"#
        let onTask = try JSONDecoder().decode(ActivityItem.self, from: Data("{\(base),\"taskId\":\"t1\",\"taskTitle\":\"Fix the login\"}".utf8))
        let plain = try JSONDecoder().decode(ActivityItem.self, from: Data("{\(base)}".utf8))
        #expect(onTask.taskTitle == "Fix the login")
        #expect(onTask.taskId == "t1")
        #expect(plain.taskTitle == nil)
        #expect(plain.taskId == nil)
    }

    @Test func daemonSecretsAreRandomHex() throws {
        let first = try Daemon.makeSecret()
        #expect(first.count == 64)
        let isHex = first.allSatisfy { $0.isHexDigit }
        #expect(isHex)
        #expect(try Daemon.makeSecret() != first)
    }

    @Test func otherMessagesCarryNoState() throws {
        let envelope = try JSONDecoder().decode(HubEnvelope.self, from: Data(#"{"type":"delta","agentId":"a1","text":"hi"}"#.utf8))
        #expect(envelope.state == nil)
    }

    @Test func sleepingAgentsAreNotWorking() {
        let agent = Agent(id: "a", name: "Josh", role: "", engine: "codex", model: "auto", avatarSeed: "s", status: "sleeping", activity: nil)
        #expect(!agent.isWorking)
    }
}

@Suite struct BrandGeometryTests {
    @Test func smallSizesUseTheSmallCutWithWiderGaps() {
        #expect(BrandGeometry.forHeight(13).gap == BrandGeometry.small.gap)
        #expect(BrandGeometry.forHeight(64).gap == BrandGeometry.regular.gap)
        #expect(BrandGeometry.small.gap > BrandGeometry.regular.gap)
    }

    @Test func theRegularMarkMatchesTheKitProportions() {
        let mark = BrandGeometry.regular
        #expect(abs(mark.width / mark.height - 212.46 / 116) < 0.01)
    }
}

@Suite struct ControlStateTests {
    private let agent = #""id":"a1","name":"Iris","role":"r","engine":"claude-code","model":"auto","avatarSeed":"s","status":"sleeping","activity":null"#

    private func state(_ extra: String, agentExtra: String = "") throws -> HubState {
        let json = #"{"agents":[{\#(agent)\#(agentExtra)}],"approvals":[],"usage":[],"activity":[]\#(extra)}"#
        return try JSONDecoder().decode(HubState.self, from: Data(json.utf8))
    }

    @Test func decodesPausedAndNextWake() throws {
        let paused = try state(#","paused":true,"pausedAt":"2026-10-21T12:00:00.000Z","budgets":{"limits":{}}"#, agentExtra: #","nextWake":"2026-10-22T09:00:00.000Z","dailyBudget":500"#)
        #expect(paused.paused)
        #expect(paused.pausedAt == "2026-10-21T12:00:00.000Z")
        #expect(paused.agents.first?.nextWake == "2026-10-22T09:00:00.000Z")
    }

    @Test func olderStatesDefaultToRunningWithNoWake() throws {
        let plain = try state("", agentExtra: #","nextWake":null"#)
        #expect(!plain.paused)
        #expect(plain.pausedAt == nil)
        #expect(plain.agents.first?.nextWake == nil)
        #expect(!HubState.empty.paused)
    }

    @Test func nextWakeNamesTodayTomorrowOrTheWeekday() throws {
        let calendar = Calendar.current
        let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 10)))
        func wake(_ day: Int, _ hour: Int) throws -> String {
            let date = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: 30)))
            return try #require(Format.nextWake(ISO8601DateFormatter.withFraction.string(from: date), now: now, calendar: calendar))
        }
        #expect(try wake(21, 17) == "17:30")
        #expect(try wake(22, 9) == "tomorrow 09:30")
        #expect(try wake(26, 7) == "Mon 07:30")
        #expect(Format.nextWake("soon") == nil)
    }
}

@MainActor
@Suite struct NoticeTests {
    private func envelope(_ json: String) throws -> HubEnvelope {
        try JSONDecoder().decode(HubEnvelope.self, from: Data(json.utf8))
    }

    @Test func decodesANotifyEvent() throws {
        let notice = try #require(try envelope(#"{"type":"notify","kind":"failed","text":"Iris's run failed.","agentId":"a1","taskId":"t1"}"#).notice)
        #expect(notice == Notice(kind: .failed, text: "Iris's run failed.", agentId: "a1", taskId: "t1"))
        let bare = try #require(try envelope(#"{"type":"notify","kind":"paused","text":"Hive is paused. Every run was stopped."}"#).notice)
        #expect(bare.agentId == nil && bare.taskId == nil)
    }

    @Test func otherEventsAndUnknownKindsAreNotNotices() throws {
        #expect(try envelope(#"{"type":"delta","agentId":"a1","text":"hi"}"#).notice == nil)
        #expect(try envelope(#"{"type":"notify","kind":"spam","text":"x"}"#).notice == nil)
        #expect(try envelope(#"{"type":"notify","kind":"budget","text":""}"#).notice == nil)
    }

    @Test func theBannerBodyIsExactlyTheDaemonText() {
        let text = "Iris is waiting for your approval."
        let content = NoticeContent(Notice(kind: .approval, text: text, agentId: "a1", taskId: nil))
        #expect(content.body == text)
        #expect(content.userInfo == ["kind": "approval", "agentId": "a1"])
    }

    @Test func clicksOpenTheNotchForApprovalsAndTheBoardForTheRest() {
        #expect(NoticeRoute(kind: .approval, agentId: "a1", taskId: "t1") == .notch)
        #expect(NoticeRoute(kind: .paused, agentId: nil, taskId: nil) == .notch)
        #expect(NoticeRoute(kind: .budget, agentId: "a1", taskId: nil) == .board(agentId: "a1", taskId: nil))
        #expect(NoticeRoute(kind: .failed, agentId: "a1", taskId: "t1") == .board(agentId: "a1", taskId: "t1"))
        #expect(NoticeRoute(userInfo: NoticeContent(Notice(kind: .failed, text: "x", agentId: "a1", taskId: "t1")).userInfo) == .board(agentId: "a1", taskId: "t1"))
        #expect(NoticeRoute(userInfo: ["kind": "other"]) == nil)
    }

    @Test func theBoardLinkOpensTheTaskOrTheAgent() {
        let hub = HubClient(daemon: Daemon(port: 47499))
        #expect(hub.boardURL(agentId: "a1", taskId: "t1")?.fragment == "board/t1")
        #expect(hub.boardURL(agentId: "a1")?.fragment == "agents/a1")
        #expect(hub.boardURL()?.fragment == "agents")
    }
}

extension ISO8601DateFormatter {
    static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
