import WebKit

@MainActor
final class ScreenWebGuard: NSObject, WKNavigationDelegate, WKUIDelegate {
    let daemonPort: Int

    init(daemonPort: Int) {
        self.daemonPort = daemonPort
    }

    static func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = WKUserContentController()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.preferences.isElementFullscreenEnabled = false
        configuration.preferences.isFraudulentWebsiteWarningEnabled = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        return configuration
    }

    func makeWebView() -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: Self.configuration())
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.allowsMagnification = false
        webView.isInspectable = false
        return webView
    }

    func allows(_ action: WKNavigationAction) -> Bool {
        action.targetFrame?.isMainFrame == true && ScreenLink.isAllowedNavigation(action.request.url, daemonPort: daemonPort)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        let allowed = allows(navigationAction)
        preferences.allowsContentJavaScript = allowed
        decisionHandler(allowed ? .allow : .cancel, preferences)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
    ) {
        let allowed = navigationResponse.isForMainFrame && ScreenLink.isAllowedNavigation(navigationResponse.response.url, daemonPort: daemonPort)
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        nil
    }
}
