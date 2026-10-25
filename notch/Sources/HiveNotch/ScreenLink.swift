import Foundation

struct ScreenSecrets: Decodable, Equatable {
    let port: Int
    let token: String
    let password: String

    var isValid: Bool {
        (1024...65535).contains(port) && ScreenLink.isHex(token, count: 64) && ScreenLink.isHex(password, count: 8)
    }
}

enum ScreenLink {
    static let path = "/screen/"
    private static let host = "127.0.0.1"
    private static let lowercaseHex = Set("0123456789abcdef")

    static func isHex(_ value: String, count: Int) -> Bool {
        value.count == count && value.allSatisfy { lowercaseHex.contains($0) }
    }

    static func isAgentId(_ value: String) -> Bool {
        UUID(uuidString: value) != nil
    }

    /// The secrets go in the fragment, which never reaches a server or a log; the page reads and clears it.
    static func pageURL(daemonPort: Int, secrets: ScreenSecrets) -> URL? {
        guard secrets.isValid else { return nil }
        var components = URLComponents()
        components.scheme = "http"
        components.host = host
        components.port = daemonPort
        components.path = path
        components.fragment = "port=\(secrets.port)&token=\(secrets.token)&password=\(secrets.password)"
        return components.url
    }

    static func apiPath(agentId: String, action: String? = nil) -> String? {
        guard isAgentId(agentId) else { return nil }
        let base = "/api/agents/\(agentId.lowercased())/computer"
        return action.map { "\(base)/\($0)" } ?? base
    }

    static func isAllowedNavigation(_ url: URL?, daemonPort: Int) -> Bool {
        guard let url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return components.scheme == "http"
            && components.host == host
            && components.port == daemonPort
            && components.user == nil
            && components.password == nil
            && components.percentEncodedPath == path
            && components.percentEncodedQuery == nil
    }

    static func agentId(fromBoardRequest url: URL?, daemonPort: Int) -> String? {
        guard isAllowedNavigation(url, daemonPort: daemonPort), let fragment = url?.fragment else { return nil }
        let pairs = fragment.split(separator: "&").map { $0.split(separator: "=", maxSplits: 1).map(String.init) }
        guard let id = pairs.first(where: { $0.first == "agent" && $0.count == 2 })?.last, isAgentId(id) else { return nil }
        return id
    }
}
