import AppKit
import Observation

@MainActor
@Observable
final class HubClient {
    private(set) var state = HubState.empty
    private(set) var connected = false
    private(set) var problem: String?
    private(set) var avatars: [String: NSImage] = [:]

    @ObservationIgnored private let daemon: Daemon
    @ObservationIgnored var onNotice: (Notice) -> Void = { _ in }
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var loadingAvatars: Set<String> = []
    @ObservationIgnored private var stopped = false
    private static let reconnectDelay = Duration.milliseconds(1500)
    private static let avatarSize = 96

    init(daemon: Daemon) {
        self.daemon = daemon
    }

    var daemonPort: Int { daemon.port }
    var waitingApprovals: Int { state.approvals.count }
    var workingAgents: [Agent] { state.agents.filter(\.isWorking) }
    var paused: Bool { state.paused }

    func start() {
        stopped = false
        Task { await connectLoop() }
    }

    func stop() {
        stopped = true
        socket?.cancel(with: .goingAway, reason: nil)
    }

    func setProblem(_ message: String?) {
        problem = message
    }

    /// The board asks the app for the secret over its script bridge, so the URL never carries it.
    func boardURL(agentId: String? = nil, taskId: String? = nil) -> URL? {
        var components = URLComponents(url: daemon.baseURL, resolvingAgainstBaseURL: false)
        components?.path = "/"
        components?.fragment = taskId.map { "board/\($0)" } ?? agentId.map { "agents/\($0)" } ?? "agents"
        return components?.url
    }

    func setPaused(_ paused: Bool) {
        post(paused ? "/api/pause" : "/api/resume", body: [:])
    }

    func reviveDaemon() async {
        do {
            try await daemon.respawnIfExited()
        } catch {
            problem = error.localizedDescription
        }
    }

    func avatar(for agent: Agent) -> NSImage? {
        let key = "\(agent.id)-\(agent.avatarSeed)"
        if let image = avatars[key] { return image }
        if !loadingAvatars.contains(key) {
            loadingAvatars.insert(key)
            Task { await loadAvatar(agent: agent, key: key) }
        }
        return nil
    }

    func decide(_ approval: Approval, allow: Bool, remember: Bool = false) {
        post("/api/approvals/\(approval.id)", body: ["allow": allow, "remember": remember])
    }

    func send(_ text: String, to agent: Agent) {
        post("/api/agents/\(agent.id)/messages", body: ["text": text])
    }

    func stopAgent(_ agent: Agent) {
        post("/api/agents/\(agent.id)/stop", body: [:])
    }

    func startComputer(agentId: String) {
        guard let path = ScreenLink.apiPath(agentId: agentId, action: "start") else { return }
        post(path, body: [:])
    }

    func stopComputer(agentId: String) {
        guard let path = ScreenLink.apiPath(agentId: agentId, action: "stop") else { return }
        post(path, body: [:])
    }

    func screenSecrets(agentId: String) async throws -> ScreenSecrets {
        guard let token = daemon.token() else { throw ScreenError.notRunning }
        guard let path = ScreenLink.apiPath(agentId: agentId, action: "screen") else { throw ScreenError.invalidReply }
        var request = URLRequest(url: daemon.baseURL.appendingPathComponent(path))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (data, response) = try await daemon.session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 409 { throw ScreenError.computerStopped }
        guard status == 200 else { throw ScreenError.answered(status) }
        let secrets = try JSONDecoder().decode(ScreenSecrets.self, from: data)
        guard secrets.isValid else { throw ScreenError.invalidReply }
        return secrets
    }

    private func connectLoop() async {
        while !stopped {
            await reviveDaemon()
            if await daemon.verify(), let token = daemon.token(), let url = socketURL(token: token) {
                let task = daemon.session.webSocketTask(with: url)
                socket = task
                task.resume()
                await receive(on: task)
                daemon.markUnverified()
            }
            connected = false
            if stopped { return }
            try? await Task.sleep(for: Self.reconnectDelay)
        }
    }

    private func socketURL(token: String) -> URL? {
        var components = URLComponents()
        components.scheme = "ws"
        components.host = "127.0.0.1"
        components.port = daemon.port
        components.path = "/ws"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url
    }

    private func receive(on task: URLSessionWebSocketTask) async {
        while true {
            do {
                let message = try await task.receive()
                connected = true
                problem = nil
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let raw): data = raw
                @unknown default: continue
                }
                guard let envelope = try? JSONDecoder().decode(HubEnvelope.self, from: data) else { continue }
                if envelope.type == "state", let next = envelope.state, next != state { state = next }
                if let notice = envelope.notice { onNotice(notice) }
            } catch {
                return
            }
        }
    }

    private func post(_ path: String, body: [String: Any]) {
        guard let token = daemon.token(), let body = try? JSONSerialization.data(withJSONObject: body) else { return }
        var request = URLRequest(url: daemon.baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        Task {
            do {
                let (_, response) = try await daemon.session.data(for: request)
                if let http = response as? HTTPURLResponse, http.statusCode >= 400 { problem = "Hive answered \(http.statusCode)." }
            } catch {
                problem = error.localizedDescription
            }
        }
    }

    private func loadAvatar(agent: Agent, key: String) async {
        var components = URLComponents(url: daemon.baseURL, resolvingAgainstBaseURL: false)
        components?.path = "/avatars/\(agent.id).png"
        components?.queryItems = [URLQueryItem(name: "size", value: String(Self.avatarSize)), URLQueryItem(name: "v", value: agent.avatarSeed)]
        defer { loadingAvatars.remove(key) }
        guard let url = components?.url, let (data, _) = try? await daemon.session.data(from: url), let image = NSImage(data: data) else { return }
        avatars[key] = image
    }
}

enum ScreenError: LocalizedError {
    case notRunning
    case computerStopped
    case invalidReply
    case answered(Int)

    var errorDescription: String? {
        switch self {
        case .notRunning: "Hive isn't running yet."
        case .computerStopped: "The virtual computer isn't running. Press Start."
        case .invalidReply: "Hive sent a screen link that doesn't look right."
        case .answered(let status): "Hive answered \(status)."
        }
    }
}
