import Foundation

struct Agent: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let role: String
    let engine: String
    let model: String
    let avatarSeed: String
    let status: String
    let activity: String?
    var computer: String = "mac"
    var nextWake: String?

    var isWorking: Bool { status == "working" || status == "waiting-approval" }
    var isVirtual: Bool { computer == "virtual" }

    enum CodingKeys: String, CodingKey {
        case id, name, role, engine, model, avatarSeed, status, activity, computer, nextWake
    }
}

extension Agent {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        role = try container.decode(String.self, forKey: .role)
        engine = try container.decode(String.self, forKey: .engine)
        model = try container.decode(String.self, forKey: .model)
        avatarSeed = try container.decode(String.self, forKey: .avatarSeed)
        status = try container.decode(String.self, forKey: .status)
        activity = try container.decodeIfPresent(String.self, forKey: .activity)
        computer = try container.decodeIfPresent(String.self, forKey: .computer) ?? "mac"
        nextWake = try container.decodeIfPresent(String.self, forKey: .nextWake)
    }
}

struct ComputerInfo: Codable, Identifiable, Equatable {
    let agentId: String
    let state: String
    let detail: String?
    var computerId: String? = nil
    var profile: String? = nil
    var hasScreen: Bool? = nil

    var id: String { agentId }

    var label: String {
        switch state {
        case "missing": "Not set up yet"
        case "building": "Preparing the virtual computer…"
        case "starting": "Starting…"
        case "running": "Running"
        case "error": "Couldn't start"
        default: "Stopped"
        }
    }

    var canStart: Bool { ["missing", "stopped", "error"].contains(state) }
    var canStop: Bool { ["starting", "running"].contains(state) }
    var isRunning: Bool { state == "running" }
    var canShowScreen: Bool { hasScreen ?? true }
}

struct Approval: Codable, Identifiable, Equatable {
    let id: String
    let agentId: String
    let agentName: String
    let toolName: String
    let summary: String
    let createdAt: String
    let rememberable: Bool
    let targetAgentId: String?
    let tainted: Bool
    let display: ApprovalDisplay?

    var isTaskGate: Bool { targetAgentId != nil }
    var showsFullText: Bool { isTaskGate || toolName == "mcp__hive__github" }

    enum CodingKeys: String, CodingKey {
        case id, agentId, agentName, toolName, summary, createdAt, rememberable, targetAgentId, tainted, display
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        agentId = try container.decode(String.self, forKey: .agentId)
        agentName = try container.decode(String.self, forKey: .agentName)
        toolName = try container.decode(String.self, forKey: .toolName)
        summary = try container.decode(String.self, forKey: .summary)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        rememberable = try container.decodeIfPresent(Bool.self, forKey: .rememberable) ?? false
        targetAgentId = try container.decodeIfPresent(String.self, forKey: .targetAgentId)
        tainted = try container.decodeIfPresent(Bool.self, forKey: .tainted) ?? false
        display = try container.decodeIfPresent(ApprovalDisplay.self, forKey: .display)
    }
}

struct EngineUsage: Codable, Identifiable, Equatable {
    let engine: String
    let agents: Int
    let activeRuns: Int
    let todayUsd: Double
    let weekUsd: Double
    let monthUsd: Double
    let todayTokens: Int

    var id: String { engine }
    var displayName: String { engine == "codex" ? "Codex" : "Claude Code" }
    var reportsCost: Bool { engine == "claude-code" }
}

struct ActivityItem: Codable, Identifiable, Equatable {
    let agentId: String
    let name: String
    let role: String
    let detail: String
    let since: String
    let queued: Int
    var taskId: String?
    var taskTitle: String?

    var id: String { agentId }
}

struct HubState: Codable, Equatable {
    let agents: [Agent]
    let approvals: [Approval]
    let usage: [EngineUsage]
    let activity: [ActivityItem]
    var computers: [ComputerInfo] = []
    var paused = false
    var pausedAt: String?

    static let empty = HubState(agents: [], approvals: [], usage: [], activity: [])

    func computer(for agentId: String) -> ComputerInfo {
        computers.first { $0.agentId == agentId } ?? ComputerInfo(agentId: agentId, state: "stopped", detail: nil)
    }

    enum CodingKeys: String, CodingKey {
        case agents, approvals, usage, activity, computers, paused, pausedAt
    }
}

extension HubState {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agents = try container.decode([Agent].self, forKey: .agents)
        approvals = try container.decode([Approval].self, forKey: .approvals)
        usage = try container.decode([EngineUsage].self, forKey: .usage)
        activity = try container.decode([ActivityItem].self, forKey: .activity)
        computers = try container.decodeIfPresent([ComputerInfo].self, forKey: .computers) ?? []
        paused = try container.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        pausedAt = try container.decodeIfPresent(String.self, forKey: .pausedAt)
    }
}

enum NoticeKind: String, Equatable {
    case approval, budget, failed, paused
}

/// The text is the daemon's own sentence for a banner; it never carries tool input.
struct Notice: Equatable {
    let kind: NoticeKind
    let text: String
    let agentId: String?
    let taskId: String?
}

struct HubEnvelope: Decodable {
    let type: String
    let state: HubState?
    let kind: String?
    let text: String?
    let agentId: String?
    let taskId: String?

    var notice: Notice? {
        guard type == "notify", let kind = kind.flatMap(NoticeKind.init(rawValue:)), let text, !text.isEmpty else { return nil }
        return Notice(kind: kind, text: text, agentId: agentId, taskId: taskId)
    }
}

enum Format {
    private static let isoParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func date(_ iso: String) -> Date? {
        isoParser.date(from: iso)
    }

    static func elapsed(since iso: String, now: Date = Date()) -> String {
        guard let start = date(iso) else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s" }
        return "\(seconds / 3600)h \(seconds % 3600 / 60)m"
    }

    static func nextWake(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let date = self.date(iso) else { return nil }
        let clock = date.formatted(.dateTime.hour().minute().locale(Locale(identifier: "en_GB")))
        if calendar.isDate(date, inSameDayAs: now) { return clock }
        if calendar.isDate(date, inSameDayAs: calendar.date(byAdding: .day, value: 1, to: now) ?? now) { return "tomorrow \(clock)" }
        let day = date.formatted(.dateTime.weekday(.abbreviated).locale(Locale(identifier: "en_US")))
        return "\(day) \(clock)"
    }

    static func step(_ text: String) -> String {
        let prefix = "mcp__hive__computer_"
        guard text.hasPrefix(prefix) else { return text }
        let rest = text.dropFirst(prefix.count)
        let parts = rest.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        let action = (parts.first ?? "").replacingOccurrences(of: "_file", with: "").replacingOccurrences(of: "_", with: " ")
        let detail = parts.count > 1 ? parts[1] : ""
        if action == "run" { return "Computer: \(detail)" }
        return detail.isEmpty ? "Computer: \(action)" : "Computer: \(action) \(detail)"
    }

    static func usd(_ value: Double) -> String {
        if value == 0 { return "$0" }
        if value < 0.01 { return "<$0.01" }
        return String(format: "$%.2f", value)
    }

    static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1000 { return "\(Int((Double(value) / 1000).rounded()))k" }
        return "\(value)"
    }
}
