import CryptoKit
import Foundation
import Security

enum DaemonError: LocalizedError, Equatable {
    case nodeMissing
    case daemonMissing
    case didNotStart(String)
    case noRandomness
    case portTaken(Int)

    var errorDescription: String? {
        switch self {
        case .nodeMissing: "Node.js 24+ wasn't found. Install it with `brew install node`."
        case .daemonMissing: "The Hive daemon isn't bundled in the app. Rebuild with `make install`."
        case .didNotStart(let detail): "The Hive daemon didn't start. \(detail)"
        case .noRandomness: "Couldn't generate a secret for the Hive daemon."
        case .portTaken(let port): "Port \(port) is used by another program."
        }
    }
}

@MainActor
protocol DaemonProcess: AnyObject {
    var isRunning: Bool { get }
    func terminate()
}

typealias DaemonLauncher = @MainActor (_ secret: String) throws -> DaemonProcess

enum HealthAnswer: Equatable {
    case noAnswer
    case proven
    case unproven
}

enum HealthProof {
    static let domain = "hive-health-v1:"

    static func makeNonce() throws -> String {
        try Daemon.randomHex(bytes: 16)
    }

    static func matches(proof: String, secret: String, nonce: String) -> Bool {
        guard ScreenLink.isHex(nonce, count: 32), let code = bytes(ofHex: proof, count: 32) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: Data((domain + nonce).utf8), using: SymmetricKey(data: Data(secret.utf8)))
    }

    private static func bytes(ofHex text: String, count: Int) -> Data? {
        guard ScreenLink.isHex(text, count: count * 2) else { return nil }
        let digits = Array(text)
        var bytes = [UInt8]()
        for index in stride(from: 0, to: digits.count, by: 2) {
            guard let byte = UInt8(String(digits[index...index + 1]), radix: 16) else { return nil }
            bytes.append(byte)
        }
        return Data(bytes)
    }
}

private struct HealthReply: Decodable {
    let proof: String?
}

/// The app hands out the secret only after the daemon on the port proved, for a fresh nonce, that it holds it.
@MainActor
final class Daemon {
    nonisolated static let defaultPort = 47321
    nonisolated static let defaultHome: URL = ProcessInfo.processInfo.environment["HIVE_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hive", isDirectory: true)

    let port: Int
    let home: URL
    let session: URLSession
    private let launcher: DaemonLauncher?
    private let adoptWindow: Duration
    private let retryDelay: Duration
    private var child: DaemonProcess?
    private var childSecret: String?
    private var verifiedSecret: String?
    private static let searchPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    private static let startPolls = 40
    private static let startPollDelay = Duration.milliseconds(250)

    init(
        port: Int = Int(ProcessInfo.processInfo.environment["HIVE_PORT"] ?? "") ?? Daemon.defaultPort,
        home: URL = Daemon.defaultHome,
        session: URLSession = .shared,
        adoptWindow: Duration = .seconds(10),
        retryDelay: Duration = .milliseconds(500),
        launcher: DaemonLauncher? = nil
    ) {
        self.port = port
        self.home = home
        self.session = session
        self.adoptWindow = adoptWindow
        self.retryDelay = retryDelay
        self.launcher = launcher
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)") ?? URL(fileURLWithPath: "/") }
    private var logURL: URL { home.appendingPathComponent("daemon.out") }

    func token() -> String? {
        verifiedSecret
    }

    var childExited: Bool {
        child.map { !$0.isRunning } ?? false
    }

    /// A daemon this app started and verified can die later. It is started again through the same proof flow.
    func respawnIfExited() async throws {
        guard childExited else { return }
        abandonChild()
        try await ensureRunning()
    }

    func markUnverified() {
        verifiedSecret = nil
    }

    func verify() async -> Bool {
        let candidate = child == nil ? fileToken() : childSecret
        guard let candidate, await probe(secret: candidate) == .proven else {
            verifiedSecret = nil
            return false
        }
        verifiedSecret = candidate
        return true
    }

    func ensureRunning() async throws {
        let deadline = ContinuousClock.now.advanced(by: adoptWindow)
        while true {
            let secret = fileToken()
            switch await probe(secret: secret) {
            case .proven:
                verifiedSecret = secret
                return
            case .noAnswer:
                try await spawn()
                return
            case .unproven:
                guard ContinuousClock.now < deadline else { throw DaemonError.portTaken(port) }
                try await Task.sleep(for: retryDelay)
            }
        }
    }

    func stop() {
        child?.terminate()
        abandonChild()
    }

    func probe(secret: String?) async -> HealthAnswer {
        guard let nonce = try? HealthProof.makeNonce(), var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return .unproven }
        components.path = "/health"
        components.queryItems = [URLQueryItem(name: "nonce", value: nonce)]
        guard let url = components.url else { return .unproven }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        guard let (data, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse else { return .noAnswer }
        guard http.statusCode == 200, let secret, let proof = (try? JSONDecoder().decode(HealthReply.self, from: data))?.proof,
              HealthProof.matches(proof: proof, secret: secret, nonce: nonce) else { return .unproven }
        return .proven
    }

    nonisolated static func makeSecret() throws -> String {
        try randomHex(bytes: 32)
    }

    nonisolated static func randomHex(bytes count: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw DaemonError.noRandomness }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func spawn() async throws {
        let secret = try Self.makeSecret()
        let started = try launcher.map { try $0(secret) } ?? launchNode(secret: secret)
        child = started
        childSecret = secret
        for _ in 0..<Self.startPolls {
            try await Task.sleep(for: Self.startPollDelay)
            switch await probe(secret: secret) {
            case .proven:
                verifiedSecret = secret
                return
            case .unproven:
                started.terminate()
                abandonChild()
                throw DaemonError.portTaken(port)
            case .noAnswer:
                if !started.isRunning { throw DaemonError.didNotStart("See \(logURL.path).") }
            }
        }
        throw DaemonError.didNotStart("See \(logURL.path).")
    }

    private func abandonChild() {
        child = nil
        childSecret = nil
        verifiedSecret = nil
    }

    private func fileToken() -> String? {
        let value = (try? String(contentsOf: home.appendingPathComponent("token"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : nil
    }

    private func launchNode(secret: String) throws -> DaemonProcess {
        guard let node = Self.findNode() else { throw DaemonError.nodeMissing }
        guard let entry = Self.daemonEntry() else { throw DaemonError.daemonMissing }

        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try FileHandle(forWritingTo: logURL)
        log.seekToEndOfFile()

        let process = Process()
        process.executableURL = node
        process.arguments = [entry.path]
        var environment = ProcessInfo.processInfo.environment
        environment["HIVE_PORT"] = String(port)
        environment["HIVE_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        environment["PATH"] = (Self.searchPaths + [environment["PATH"] ?? ""]).joined(separator: ":")
        if let web = Bundle.main.resourceURL?.appendingPathComponent("web"), FileManager.default.fileExists(atPath: web.path) {
            environment["HIVE_WEB_DIR"] = web.path
        }
        environment["HIVE_SECRET_STDIN"] = "1"
        process.environment = environment
        process.standardOutput = log
        process.standardError = log
        let pipe = Pipe()
        _ = fcntl(pipe.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        process.standardInput = pipe
        try process.run()
        try pipe.fileHandleForWriting.write(contentsOf: Data((secret + "\n").utf8))
        return LaunchedDaemon(process: process, secretPipe: pipe)
    }

    private static func findNode() -> URL? {
        searchPaths.map { URL(fileURLWithPath: $0).appendingPathComponent("node") }
            .first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }

    private static func daemonEntry() -> URL? {
        if let dev = ProcessInfo.processInfo.environment["HIVE_DAEMON_DIR"] {
            return URL(fileURLWithPath: dev).appendingPathComponent("src/main.ts")
        }
        guard let bundled = Bundle.main.resourceURL?.appendingPathComponent("daemon/src/main.ts"),
              FileManager.default.fileExists(atPath: bundled.path) else { return nil }
        return bundled
    }
}

@MainActor
private final class LaunchedDaemon: DaemonProcess {
    private let process: Process
    private let secretPipe: Pipe

    init(process: Process, secretPipe: Pipe) {
        self.process = process
        self.secretPipe = secretPipe
    }

    var isRunning: Bool { process.isRunning }

    func terminate() {
        process.terminate()
    }
}
