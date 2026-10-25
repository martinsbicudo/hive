import AppKit
import WebKit

struct BoardMessageSource: Equatable {
    let fromBoardWebView: Bool
    let isMainFrame: Bool
    let originScheme: String
    let originHost: String
    let originPort: Int
    let frameURL: URL?
}

enum BoardNavigation: Equatable {
    case allow
    case openInBrowser
    case cancel
}

enum BoardAccess {
    private static let host = "127.0.0.1"

    static func isBoardPage(_ url: URL?, daemonPort: Int) -> Bool {
        guard let url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return components.scheme == "http"
            && components.host == host
            && components.port == daemonPort
            && components.user == nil
            && components.password == nil
            && !components.percentEncodedPath.lowercased().hasPrefix("/screen")
            && !components.path.lowercased().hasPrefix("/screen")
    }

    /// WKScriptMessage and WKFrameInfo can't be built in tests, so the handler reduces a message to this check.
    static func mayReceiveToken(_ source: BoardMessageSource, daemonPort: Int, verified: Bool) -> Bool {
        verified
            && source.fromBoardWebView
            && source.isMainFrame
            && source.originScheme == "http"
            && source.originHost == host
            && source.originPort == daemonPort
            && isBoardPage(source.frameURL, daemonPort: daemonPort)
    }

    static func navigation(to url: URL?, daemonPort: Int, isMainFrame: Bool, userClicked: Bool) -> BoardNavigation {
        if isBoardPage(url, daemonPort: daemonPort) { return .allow }
        guard isMainFrame, userClicked, let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host != host || url.port != daemonPort else { return .cancel }
        return .openInBrowser
    }
}

@MainActor
final class BoardTokenBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "hiveToken"
    private let daemon: Daemon
    weak var webView: WKWebView?

    init(daemon: Daemon) {
        self.daemon = daemon
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        let origin = message.frameInfo.securityOrigin
        let source = BoardMessageSource(
            fromBoardWebView: webView != nil && message.webView === webView,
            isMainFrame: message.frameInfo.isMainFrame,
            originScheme: origin.protocol,
            originHost: origin.host,
            originPort: origin.port,
            frameURL: message.frameInfo.request.url
        )
        let port = daemon.port
        guard BoardAccess.mayReceiveToken(source, daemonPort: port, verified: true) else {
            replyHandler(nil, "refused")
            return
        }
        Task {
            let verified = await daemon.verify()
            if BoardAccess.mayReceiveToken(source, daemonPort: port, verified: verified), let token = daemon.token() {
                replyHandler(token, nil)
            } else {
                replyHandler(nil, "Hive isn't ready yet.")
            }
        }
    }
}

@MainActor
final class BoardWebGuard: NSObject, WKNavigationDelegate {
    let daemonPort: Int
    private let openExternal: (URL) -> Void

    init(daemonPort: Int, openExternal: @escaping (URL) -> Void) {
        self.daemonPort = daemonPort
        self.openExternal = openExternal
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        let decision = BoardAccess.navigation(
            to: url, daemonPort: daemonPort,
            isMainFrame: navigationAction.targetFrame?.isMainFrame == true,
            userClicked: navigationAction.navigationType == .linkActivated
        )
        if decision == .openInBrowser, let url { openExternal(url) }
        decisionHandler(decision == .allow ? .allow : .cancel)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(BoardAccess.isBoardPage(navigationResponse.response.url, daemonPort: daemonPort) ? .allow : .cancel)
    }
}

/// The board opens the screen with window.open; in the app that becomes the native screen window, which fetches
/// its own fresh secrets. Every other popup is refused.
@MainActor
final class BoardLinks: NSObject, WKUIDelegate {
    private let daemonPort: Int
    private let openScreen: (String) -> Void

    init(daemonPort: Int, openScreen: @escaping (String) -> Void) {
        self.daemonPort = daemonPort
        self.openScreen = openScreen
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let agentId = ScreenLink.agentId(fromBoardRequest: navigationAction.request.url, daemonPort: daemonPort) { openScreen(agentId) }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let origin = frame.securityOrigin
        guard Self.mayAsk(isMainFrame: frame.isMainFrame, scheme: origin.protocol, host: origin.host, port: origin.port, daemonPort: daemonPort) else {
            return completionHandler(false)
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        guard let window = webView.window else { return completionHandler(alert.runModal() == .alertFirstButtonReturn) }
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    nonisolated static func mayAsk(isMainFrame: Bool, scheme: String, host: String, port: Int, daemonPort: Int) -> Bool {
        isMainFrame && scheme == "http" && host == "127.0.0.1" && port == daemonPort
    }
}

@MainActor
final class BoardPage {
    let bridge: BoardTokenBridge
    let webGuard: BoardWebGuard
    let links: BoardLinks

    init(daemon: Daemon, openScreen: @escaping (String) -> Void, openExternal: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) }) {
        bridge = BoardTokenBridge(daemon: daemon)
        webGuard = BoardWebGuard(daemonPort: daemon.port, openExternal: openExternal)
        links = BoardLinks(daemonPort: daemon.port, openScreen: openScreen)
    }

    func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let controller = WKUserContentController()
        controller.addScriptMessageHandler(bridge, contentWorld: .page, name: BoardTokenBridge.name)
        configuration.userContentController = controller
        return configuration
    }

    func makeWebView() -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: configuration())
        bridge.webView = webView
        webView.navigationDelegate = webGuard
        webView.uiDelegate = links
        return webView
    }
}
