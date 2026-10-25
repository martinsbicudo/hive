import CryptoKit
import Foundation
import Testing
@testable import HiveNotch

private let sharedSecret = "hive-shared-test-secret-0123456789abcdef"
private let sharedNonce = "00112233445566778899aabbccddeeff"
private let sharedProof = "350438b5bd9942c2c2b828767702058730140fd144381c0a4e207387b8dfb2fb"
private let fileSecret = String(repeating: "f1", count: 32)

enum FakeReply {
    case refuse
    case json(Int, String)
}

final class FakeServer: @unchecked Sendable {
    static let shared = FakeServer()
    private let lock = NSLock()
    private var handlers: [Int: @Sendable (URLRequest) -> FakeReply] = [:]
    private var seen: [Int: [URLRequest]] = [:]

    func serve(port: Int, _ handler: @escaping @Sendable (URLRequest) -> FakeReply) {
        lock.withLock { handlers[port] = handler }
    }

    func answer(_ request: URLRequest) -> FakeReply {
        let port = request.url?.port ?? 0
        return lock.withLock {
            seen[port, default: []].append(request)
            return handlers[port]?(request) ?? .refuse
        }
    }

    func requests(port: Int) -> [URLRequest] {
        lock.withLock { seen[port] ?? [] }
    }
}

final class FakeServerProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, case .json(let status, let body) = FakeServer.shared.answer(request),
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
final class FakeChild: DaemonProcess {
    private(set) var terminated = 0
    var isRunning: Bool { terminated == 0 }
    func terminate() { terminated += 1 }
}

private func session() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FakeServerProtocol.self]
    return URLSession(configuration: configuration)
}

private func home(token: String?) throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("hive-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if let token { try Data((token + "\n").utf8).write(to: directory.appendingPathComponent("token")) }
    return directory
}

private func nonce(of request: URLRequest) -> String? {
    request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems?.first { $0.name == "nonce" }?.value
}

private func proof(secret: String, nonce: String) -> String {
    let code = HMAC<SHA256>.authenticationCode(for: Data(("hive-health-v1:" + nonce).utf8), using: SymmetricKey(data: Data(secret.utf8)))
    return code.map { String(format: "%02x", $0) }.joined()
}

private func health(proof: String?) -> FakeReply {
    .json(200, proof.map { #"{"ok":true,"version":"0","proof":"\#($0)"}"# } ?? #"{"ok":true,"version":"0"}"#)
}

private func carriesSecret(_ request: URLRequest) -> Bool {
    let query = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems ?? []
    return request.value(forHTTPHeaderField: "Authorization") != nil || query.contains { $0.name == "token" }
}

@MainActor
private func daemon(port: Int, token: String?, launcher: DaemonLauncher? = nil) throws -> Daemon {
    Daemon(port: port, home: try home(token: token), session: session(), adoptWindow: .milliseconds(400), retryDelay: .milliseconds(50), launcher: launcher)
}

@MainActor
private func neverLaunch(_ secret: String) throws -> DaemonProcess {
    Issue.record("the app spawned a daemon while the port was taken")
    throw DaemonError.daemonMissing
}

@Suite struct HealthProofTests {
    @Test func theSharedVectorMatches() {
        #expect(HealthProof.matches(proof: sharedProof, secret: sharedSecret, nonce: sharedNonce))
    }

    @Test func anythingElseDoesNot() {
        let flipped = "4" + sharedProof.dropFirst()
        #expect(!HealthProof.matches(proof: flipped, secret: sharedSecret, nonce: sharedNonce))
        #expect(!HealthProof.matches(proof: sharedProof.uppercased(), secret: sharedSecret, nonce: sharedNonce))
        #expect(!HealthProof.matches(proof: String(sharedProof.dropLast(2)), secret: sharedSecret, nonce: sharedNonce))
        #expect(!HealthProof.matches(proof: sharedProof, secret: sharedSecret + "x", nonce: sharedNonce))
        #expect(!HealthProof.matches(proof: sharedProof, secret: sharedSecret, nonce: "ffeeddccbbaa99887766554433221100"))
        #expect(!HealthProof.matches(proof: "", secret: sharedSecret, nonce: sharedNonce))
    }

    @Test func noncesAreFreshLowercaseHex() throws {
        let first = try HealthProof.makeNonce()
        #expect(ScreenLink.isHex(first, count: 32))
        #expect(first != (try HealthProof.makeNonce()))
    }
}

@MainActor
@Suite struct DaemonSquatterTests {
    @Test(arguments: [(47401, String(repeating: "0", count: 64)), (47402, nil)])
    func aSquatterWithAWrongOrMissingProofNeverGetsTheSecret(port: Int, wrongProof: String?) async throws {
        FakeServer.shared.serve(port: port) { _ in health(proof: wrongProof) }
        let daemon = try daemon(port: port, token: fileSecret, launcher: neverLaunch)
        await #expect(throws: DaemonError.portTaken(port)) { try await daemon.ensureRunning() }
        #expect(DaemonError.portTaken(port).errorDescription == "Port \(port) is used by another program.")
        #expect(daemon.token() == nil)
        #expect(!(await daemon.verify()))

        let hub = HubClient(daemon: daemon)
        hub.start()
        try await Task.sleep(for: .milliseconds(200))
        hub.send("hello", to: try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"a1","name":"Iris","role":"r","engine":"claude-code","model":"auto","avatarSeed":"s","status":"sleeping","activity":null}"#.utf8)))
        try await Task.sleep(for: .milliseconds(100))
        hub.stop()

        let requests = FakeServer.shared.requests(port: port)
        #expect(requests.count >= 3)
        #expect(requests.allSatisfy { $0.url?.path == "/health" && !carriesSecret($0) })
        let nonces = requests.compactMap(nonce(of:))
        #expect(nonces.count == requests.count && Set(nonces).count == nonces.count)
        #expect(hub.boardURL()?.absoluteString == "http://127.0.0.1:\(port)/#agents")
    }

    @Test func aWrongProofAfterSpawningStopsTheChildOnce() async throws {
        let port = 47403
        var launched: [FakeChild] = []
        let daemon = try daemon(port: port, token: fileSecret) { _ in
            let child = FakeChild()
            launched.append(child)
            FakeServer.shared.serve(port: port) { _ in health(proof: String(repeating: "ab", count: 32)) }
            return child
        }
        await #expect(throws: DaemonError.portTaken(port)) { try await daemon.ensureRunning() }
        #expect(launched.count == 1)
        #expect(launched.first?.terminated == 1)
        #expect(daemon.token() == nil)
        #expect(!(await daemon.verify()))
        #expect(FakeServer.shared.requests(port: port).allSatisfy { $0.url?.path == "/health" && !carriesSecret($0) })
    }

    @Test func aDaemonProvingTheTokenFileIsAdoptedAndUsed() async throws {
        let port = 47404
        FakeServer.shared.serve(port: port) { request in
            guard request.url?.path == "/health" else { return .json(202, "{}") }
            return health(proof: nonce(of: request).map { proof(secret: fileSecret, nonce: $0) })
        }
        let daemon = try daemon(port: port, token: fileSecret, launcher: neverLaunch)
        try await daemon.ensureRunning()
        #expect(daemon.token() == fileSecret)
        daemon.markUnverified()
        #expect(daemon.token() == nil)
        #expect(await daemon.verify())

        let hub = HubClient(daemon: daemon)
        hub.decide(try JSONDecoder().decode(Approval.self, from: Data(#"{"id":"p1","agentId":"a1","agentName":"Iris","toolName":"Bash","summary":"ls","createdAt":"2026-10-21T12:00:00.000Z"}"#.utf8)), allow: false)
        try await Task.sleep(for: .milliseconds(200))
        let posted = FakeServer.shared.requests(port: port).filter { $0.url?.path == "/api/approvals/p1" }
        #expect(posted.count == 1)
        #expect(posted.first?.value(forHTTPHeaderField: "Authorization") == "Bearer \(fileSecret)")
    }

    @Test func aSpawnedDaemonIsVerifiedAgainstItsOwnSecret() async throws {
        let port = 47405
        var given: String?
        let daemon = try daemon(port: port, token: fileSecret) { secret in
            given = secret
            FakeServer.shared.serve(port: port) { request in health(proof: nonce(of: request).map { proof(secret: secret, nonce: $0) }) }
            return FakeChild()
        }
        try await daemon.ensureRunning()
        #expect(given != nil && given != fileSecret)
        #expect(daemon.token() == given)
    }

    @Test func aSpawnedDaemonThatDiesLaterIsRespawnedThroughTheSameProof() async throws {
        let port = 47406
        var launched: [FakeChild] = []
        var secrets: [String] = []
        let daemon = try daemon(port: port, token: fileSecret) { secret in
            secrets.append(secret)
            FakeServer.shared.serve(port: port) { request in health(proof: nonce(of: request).map { proof(secret: secret, nonce: $0) }) }
            let child = FakeChild()
            launched.append(child)
            return child
        }
        try await daemon.ensureRunning()
        #expect(daemon.token() == secrets.first)
        #expect(!daemon.childExited)

        launched[0].terminate()
        FakeServer.shared.serve(port: port) { _ in .refuse }
        #expect(daemon.childExited)
        let hub = HubClient(daemon: daemon)
        await hub.reviveDaemon()

        #expect(launched.count == 2)
        #expect(secrets.count == 2 && secrets[0] != secrets[1])
        #expect(daemon.token() == secrets.last)
        #expect(hub.problem == nil)
        #expect(FakeServer.shared.requests(port: port).allSatisfy { $0.url?.path == "/health" && !carriesSecret($0) })
    }

    @Test func ifAnotherProgramTookThePortAfterTheChildDiedItShowsTheSingleMessageAndSendsNoSecret() async throws {
        let port = 47407
        var launched: [FakeChild] = []
        let daemon = try daemon(port: port, token: fileSecret) { secret in
            FakeServer.shared.serve(port: port) { request in health(proof: nonce(of: request).map { proof(secret: secret, nonce: $0) }) }
            let child = FakeChild()
            launched.append(child)
            return child
        }
        try await daemon.ensureRunning()
        launched[0].terminate()
        FakeServer.shared.serve(port: port) { _ in health(proof: String(repeating: "0", count: 64)) }
        let hub = HubClient(daemon: daemon)
        await hub.reviveDaemon()
        await hub.reviveDaemon()

        #expect(launched.count == 1)
        #expect(hub.problem == "Port \(port) is used by another program.")
        #expect(daemon.token() == nil)
        #expect(!(await daemon.verify()))
        #expect(FakeServer.shared.requests(port: port).allSatisfy { $0.url?.path == "/health" && !carriesSecret($0) })
    }
}
