import AppKit
import WebKit

/// Every connect gets a brand-new web view: loading a new fragment into the old one would be a same-document
/// navigation, so the page wouldn't rerun and the old secrets would stay in its history.
@MainActor
final class ScreenSurface: NSView {
    let webGuard: ScreenWebGuard
    private let background: NSColor
    private(set) var webView: WKWebView?

    init(webGuard: ScreenWebGuard, background: NSColor) {
        self.webGuard = webGuard
        self.background = background
        super.init(frame: .zero)
        wantsLayer = true
    }

    required init?(coder: NSCoder) {
        nil
    }

    @discardableResult
    func load(_ url: URL) -> WKWebView {
        tearDown()
        let fresh = webGuard.makeWebView()
        fresh.underPageBackgroundColor = background
        fresh.translatesAutoresizingMaskIntoConstraints = false
        addSubview(fresh)
        NSLayoutConstraint.activate([
            fresh.leadingAnchor.constraint(equalTo: leadingAnchor),
            fresh.trailingAnchor.constraint(equalTo: trailingAnchor),
            fresh.topAnchor.constraint(equalTo: topAnchor),
            fresh.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        webView = fresh
        fresh.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        window?.makeFirstResponder(fresh)
        return fresh
    }

    func tearDown() {
        guard let old = webView else { return }
        old.stopLoading()
        old.navigationDelegate = nil
        old.uiDelegate = nil
        old.removeFromSuperview()
        webView = nil
    }
}
