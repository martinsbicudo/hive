import Foundation
import Testing
import WebKit
@testable import HiveNotch

private let port = 47321
private let board = BoardMessageSource(
    fromBoardWebView: true, isMainFrame: true, originScheme: "http", originHost: "127.0.0.1", originPort: port,
    frameURL: URL(string: "http://127.0.0.1:47321/#agents")
)

private func with(
    fromBoardWebView: Bool? = nil, isMainFrame: Bool? = nil, scheme: String? = nil, host: String? = nil, originPort: Int? = nil, url: String? = nil
) -> BoardMessageSource {
    BoardMessageSource(
        fromBoardWebView: fromBoardWebView ?? board.fromBoardWebView, isMainFrame: isMainFrame ?? board.isMainFrame,
        originScheme: scheme ?? board.originScheme, originHost: host ?? board.originHost, originPort: originPort ?? board.originPort,
        frameURL: url.map { URL(string: $0) } ?? board.frameURL
    )
}

@Suite struct BoardTokenCheckTests {
    @Test func theBoardMainFrameOfAVerifiedDaemonGetsTheToken() {
        #expect(BoardAccess.mayReceiveToken(board, daemonPort: port, verified: true))
        #expect(BoardAccess.mayReceiveToken(with(url: "http://127.0.0.1:47321/agents/x?y=1"), daemonPort: port, verified: true))
    }

    @Test func anUnverifiedDaemonGetsNothing() {
        #expect(!BoardAccess.mayReceiveToken(board, daemonPort: port, verified: false))
    }

    @Test func anotherWebViewOrASubframeGetsNothing() {
        #expect(!BoardAccess.mayReceiveToken(with(fromBoardWebView: false), daemonPort: port, verified: true))
        #expect(!BoardAccess.mayReceiveToken(with(isMainFrame: false), daemonPort: port, verified: true))
    }

    @Test func anotherOriginGetsNothing() {
        let others = [
            with(scheme: "https"), with(host: "localhost"), with(host: "evil.test"), with(originPort: 47322),
            with(url: "http://localhost:47321/"), with(url: "http://127.0.0.1:47322/"), with(url: "https://127.0.0.1:47321/"),
            with(url: "http://user:pw@127.0.0.1:47321/"), with(url: "file:///"), with(url: "about:blank"),
        ]
        for source in others { #expect(!BoardAccess.mayReceiveToken(source, daemonPort: port, verified: true), "\(source)") }
        #expect(!BoardAccess.mayReceiveToken(BoardMessageSource(
            fromBoardWebView: true, isMainFrame: true, originScheme: "http", originHost: "127.0.0.1", originPort: port, frameURL: nil
        ), daemonPort: port, verified: true))
    }

    @Test func theScreenPageGetsNothing() {
        for path in ["/screen/", "/screen/#agent=x", "/screen", "/Screen/", "/%73creen/", "/screen/novnc/core/rfb.js"] {
            #expect(!BoardAccess.mayReceiveToken(with(url: "http://127.0.0.1:47321\(path)"), daemonPort: port, verified: true), "\(path)")
        }
    }
}

@Suite struct BoardNavigationTests {
    @Test func theBoardStaysOnTheDaemonOrigin() {
        let board = URL(string: "http://127.0.0.1:47321/#board")
        #expect(BoardAccess.navigation(to: board, daemonPort: port, isMainFrame: true, userClicked: false) == .allow)
        #expect(BoardAccess.navigation(to: URL(string: "http://127.0.0.1:47321/screen/"), daemonPort: port, isMainFrame: true, userClicked: true) == .cancel)
        #expect(BoardAccess.navigation(to: URL(string: "http://127.0.0.1:47322/"), daemonPort: port, isMainFrame: true, userClicked: false) == .cancel)
    }

    @Test func clickedOutsideLinksOpenInTheBrowserAndNothingElseLeaves() {
        let outside = URL(string: "https://github.com/x")
        #expect(BoardAccess.navigation(to: outside, daemonPort: port, isMainFrame: true, userClicked: true) == .openInBrowser)
        #expect(BoardAccess.navigation(to: outside, daemonPort: port, isMainFrame: true, userClicked: false) == .cancel)
        #expect(BoardAccess.navigation(to: outside, daemonPort: port, isMainFrame: false, userClicked: true) == .cancel)
        for other in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "about:blank"] {
            #expect(BoardAccess.navigation(to: URL(string: other), daemonPort: port, isMainFrame: true, userClicked: true) == .cancel, "\(other)")
        }
    }
}

@MainActor
@Suite struct BoardPageTests {
    @Test func theBoardKeepsNothingAndHasOnlyTheTokenBridge() {
        let page = BoardPage(daemon: Daemon(port: port), openScreen: { _ in }, openExternal: { _ in })
        let webView = page.makeWebView()
        #expect(!webView.configuration.websiteDataStore.isPersistent)
        #expect(webView.navigationDelegate === page.webGuard)
        #expect(webView.uiDelegate === page.links)
        #expect(page.bridge.webView === webView)
        #expect(webView.configuration.userContentController.userScripts.isEmpty)
    }

    @Test func popupsAreNeverCreated() {
        var opened: [String] = []
        let page = BoardPage(daemon: Daemon(port: port), openScreen: { opened.append($0) }, openExternal: { _ in })
        let webView = page.makeWebView()
        let created = page.links.webView(webView, createWebViewWith: WKWebViewConfiguration(), for: WKNavigationAction(), windowFeatures: WKWindowFeatures())
        #expect(created == nil)
        #expect(opened.isEmpty)
    }

    @Test func onlyTheBoardMainFrameCanAskForConfirmation() {
        #expect(BoardLinks.mayAsk(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: port, daemonPort: port))
        #expect(!BoardLinks.mayAsk(isMainFrame: false, scheme: "http", host: "127.0.0.1", port: port, daemonPort: port))
        #expect(!BoardLinks.mayAsk(isMainFrame: true, scheme: "https", host: "127.0.0.1", port: port, daemonPort: port))
        #expect(!BoardLinks.mayAsk(isMainFrame: true, scheme: "http", host: "localhost", port: port, daemonPort: port))
        #expect(!BoardLinks.mayAsk(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: port + 1, daemonPort: port))
    }
}
