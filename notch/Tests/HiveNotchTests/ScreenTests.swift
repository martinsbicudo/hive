import Foundation
import Testing
import WebKit
@testable import HiveNotch

private let agentId = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b"
private let secrets = ScreenSecrets(port: 49153, token: String(repeating: "ab", count: 32), password: "0f1e2d3c")
private let daemonPort = 47321

@Suite struct ComputerDecodingTests {
    private let agentJSON = #""id":"a1","name":"Iris","role":"Engineer","engine":"claude-code","model":"auto","avatarSeed":"iris","status":"sleeping","activity":null"#

    @Test func agentsWithoutAComputerFieldWorkOnTheMac() throws {
        let agent = try JSONDecoder().decode(Agent.self, from: Data("{\(agentJSON)}".utf8))
        #expect(agent.computer == "mac")
        #expect(!agent.isVirtual)
    }

    @Test func virtualAgentsAndTheirComputersDecode() throws {
        let json = """
        {"agents":[{\(agentJSON),"computer":"virtual"}],"approvals":[],"usage":[],"activity":[],
         "computers":[{"agentId":"a1","state":"error","detail":"Docker isn't running"}]}
        """
        let state = try JSONDecoder().decode(HubState.self, from: Data(json.utf8))
        #expect(state.agents.first?.isVirtual == true)
        let computer = state.computer(for: "a1")
        #expect(computer.state == "error")
        #expect(computer.detail == "Docker isn't running")
        #expect(computer.canStart && !computer.canStop && !computer.isRunning)
        #expect(computer.canShowScreen)
        #expect(state.computer(for: "other").state == "stopped")
    }

    @Test func terminalProfileHidesScreenButOldStatusKeepsScreenFallback() throws {
        let terminal = try JSONDecoder().decode(ComputerInfo.self, from: Data(#"{"agentId":"a1","state":"running","profile":"terminal","hasScreen":false}"#.utf8))
        let oldStatus = try JSONDecoder().decode(ComputerInfo.self, from: Data(#"{"agentId":"a2","state":"running"}"#.utf8))
        #expect(!terminal.canShowScreen)
        #expect(oldStatus.canShowScreen)
    }

    @Test func stateWithoutComputersDecodesToNone() throws {
        let state = try JSONDecoder().decode(HubState.self, from: Data(#"{"agents":[],"approvals":[],"usage":[],"activity":[]}"#.utf8))
        #expect(state.computers.isEmpty)
    }

    @Test func computerStepsReadAsComputerActions() {
        #expect(Format.step("mcp__hive__computer_run: uname -a") == "Computer: uname -a")
        #expect(Format.step("mcp__hive__computer_screenshot") == "Computer: screenshot")
        #expect(Format.step("mcp__hive__computer_read_file: notes.txt") == "Computer: read notes.txt")
        #expect(Format.step("Bash: ls") == "Bash: ls")
    }
}

@Suite struct ScreenLinkTests {
    @Test func pageURLCarriesTheSecretsInTheFragmentOnly() throws {
        let url = try #require(ScreenLink.pageURL(daemonPort: daemonPort, secrets: secrets))
        #expect(url.absoluteString == "http://127.0.0.1:47321/screen/#port=49153&token=\(secrets.token)&password=0f1e2d3c")
        #expect(url.query == nil)
        #expect(ScreenLink.isAllowedNavigation(url, daemonPort: daemonPort))
    }

    @Test func malformedSecretsBuildNoURL() {
        let bad = [
            ScreenSecrets(port: 80, token: secrets.token, password: secrets.password),
            ScreenSecrets(port: 70000, token: secrets.token, password: secrets.password),
            ScreenSecrets(port: secrets.port, token: "&token=" + String(repeating: "a", count: 57), password: secrets.password),
            ScreenSecrets(port: secrets.port, token: secrets.token.uppercased(), password: secrets.password),
            ScreenSecrets(port: secrets.port, token: secrets.token, password: "pass#word"),
        ]
        for value in bad { #expect(ScreenLink.pageURL(daemonPort: daemonPort, secrets: value) == nil) }
    }

    @Test func navigationIsLimitedToTheDaemonScreenPage() {
        let allowed = ["http://127.0.0.1:47321/screen/", "http://127.0.0.1:47321/screen/#port=1"]
        let denied = [
            "http://127.0.0.1:47322/screen/", "http://localhost:47321/screen/", "https://127.0.0.1:47321/screen/",
            "http://127.0.0.1:47321/", "http://127.0.0.1:47321/screen", "http://127.0.0.1:47321/screen/novnc/core/rfb.js",
            "http://127.0.0.1:47321/screen/?x=1", "http://user:pw@127.0.0.1:47321/screen/", "http://127.0.0.1.evil.test:47321/screen/",
            "http://127.0.0.1:47321/screen/%2e%2e/api/state", "file:///screen/", "about:blank", "javascript:alert(1)",
            "data:text/html,hi", "https://example.com/screen/",
        ]
        for value in allowed { #expect(ScreenLink.isAllowedNavigation(URL(string: value), daemonPort: daemonPort), "\(value)") }
        for value in denied { #expect(!ScreenLink.isAllowedNavigation(URL(string: value), daemonPort: daemonPort), "\(value)") }
        #expect(!ScreenLink.isAllowedNavigation(nil, daemonPort: daemonPort))
    }

    @Test func apiPathsNeedARealAgentId() {
        #expect(ScreenLink.apiPath(agentId: agentId, action: "screen") == "/api/agents/\(agentId)/computer/screen")
        #expect(ScreenLink.apiPath(agentId: "../../state") == nil)
        #expect(ScreenLink.apiPath(agentId: "\(agentId)/../x") == nil)
    }

    @Test func boardScreenRequestsOpenOnlyForAValidAgent() {
        let link = "http://127.0.0.1:47321/screen/#port=49153&token=\(secrets.token)&password=0f1e2d3c&agent="
        #expect(ScreenLink.agentId(fromBoardRequest: URL(string: link + agentId), daemonPort: daemonPort) == agentId)
        #expect(ScreenLink.agentId(fromBoardRequest: URL(string: link + "nope"), daemonPort: daemonPort) == nil)
        #expect(ScreenLink.agentId(fromBoardRequest: URL(string: "https://evil.test/screen/#agent=\(agentId)"), daemonPort: daemonPort) == nil)
    }
}

@MainActor
@Suite struct ScreenWebGuardTests {
    @Test func theScreenWebViewKeepsNothingAndHasNoBridges() {
        let configuration = ScreenWebGuard.configuration()
        #expect(!configuration.websiteDataStore.isPersistent)
        #expect(configuration.userContentController.userScripts.isEmpty)
        #expect(!configuration.preferences.javaScriptCanOpenWindowsAutomatically)
        #expect(!configuration.defaultWebpagePreferences.allowsContentJavaScript)
    }

    @Test func popupsAreNeverCreated() {
        let webGuard = ScreenWebGuard(daemonPort: daemonPort)
        let webView = webGuard.makeWebView()
        let created = webGuard.webView(webView, createWebViewWith: WKWebViewConfiguration(), for: WKNavigationAction(), windowFeatures: WKWindowFeatures())
        #expect(created == nil)
        #expect(webView.navigationDelegate === webGuard)
        #expect(!webView.isInspectable)
    }

    @Test func everyConnectGetsAFreshLockedDownWebView() throws {
        let surface = ScreenSurface(webGuard: ScreenWebGuard(daemonPort: daemonPort), background: .black)
        let url = try #require(ScreenLink.pageURL(daemonPort: daemonPort, secrets: secrets))
        let first = surface.load(url)
        let second = surface.load(url)
        #expect(first !== second)
        #expect(first.superview == nil)
        #expect(second.superview === surface)
        #expect(surface.subviews.count == 1)
        #expect(surface.webView === second)
        #expect(first.configuration.websiteDataStore !== second.configuration.websiteDataStore)
        #expect(!second.configuration.websiteDataStore.isPersistent)
        #expect(second.navigationDelegate === surface.webGuard)
        #expect(second.uiDelegate === surface.webGuard)
        #expect(second.backForwardList.backItem == nil)
        surface.tearDown()
        #expect(surface.webView == nil && surface.subviews.isEmpty)
    }
}
