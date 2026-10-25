import AppKit
import Observation
import SwiftUI

@MainActor
@Observable
final class ScreenSession {
    let agentId: String
    private(set) var problem: String?
    private(set) var loading = false
    @ObservationIgnored private let hub: HubClient
    @ObservationIgnored let surface: ScreenSurface

    init(agentId: String, hub: HubClient, surface: ScreenSurface) {
        self.agentId = agentId
        self.hub = hub
        self.surface = surface
    }

    func connect() {
        guard !loading else { return }
        loading = true
        problem = nil
        Task {
            defer { loading = false }
            do {
                let secrets = try await hub.screenSecrets(agentId: agentId)
                guard let url = ScreenLink.pageURL(daemonPort: hub.daemonPort, secrets: secrets) else { throw ScreenError.invalidReply }
                surface.load(url)
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

struct ScreenControls: View {
    let session: ScreenSession
    let hub: HubClient

    private var agent: Agent? { hub.state.agents.first { $0.id == session.agentId } }
    private var computer: ComputerInfo { hub.state.computer(for: session.agentId) }

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(dotColor).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text("\(agent?.name ?? "Agent") · \(computer.label)").font(.system(size: 12.5, weight: .semibold))
                if let note = session.problem ?? computer.detail {
                    Text(note).font(.system(size: 11)).foregroundStyle(session.problem == nil ? Theme.secondary : Theme.bad).lineLimit(1)
                }
            }
            Spacer()
            if computer.canShowScreen {
                if computer.canStart {
                    Button("Start") { hub.startComputer(agentId: session.agentId) }
                        .buttonStyle(.borderedProminent).tint(Theme.accent).foregroundStyle(.black)
                }
                if computer.canStop {
                    Button("Stop") { hub.stopComputer(agentId: session.agentId) }
                }
                Button("Reconnect") { session.connect() }
                    .disabled(!computer.isRunning || session.loading)
            } else {
                Text("This profile has no live screen").font(.system(size: 11)).foregroundStyle(Theme.secondary)
            }
        }
        .controlSize(.small)
        .padding(.horizontal, 14)
        .frame(height: 44)
        .frame(maxWidth: .infinity)
        .background(Theme.background)
        .foregroundStyle(.white)
        .environment(\.colorScheme, .dark)
        .onChange(of: computer.state, initial: true) { _, state in
            if state == "running", computer.canShowScreen { session.connect() }
        }
    }

    private var dotColor: Color {
        switch computer.state {
        case "running": Theme.ok
        case "error": Theme.bad
        case "building", "starting": Theme.accent
        default: Theme.secondary
        }
    }
}

@MainActor
final class ScreenWindows: NSObject, NSWindowDelegate {
    private let hub: HubClient
    private var windows: [String: NSWindow] = [:]
    private var surfaces: [String: ScreenSurface] = [:]
    private static let windowSize = NSSize(width: 1200, height: 794)

    init(hub: HubClient) {
        self.hub = hub
    }

    func open(agentId: String) {
        guard ScreenLink.isAgentId(agentId),
              hub.state.agents.contains(where: { $0.id == agentId && $0.isVirtual }),
              hub.state.computer(for: agentId).canShowScreen else {
            hub.setProblem("That agent's computer profile doesn't have a screen.")
            return
        }
        let window = windows[agentId] ?? makeWindow(agentId: agentId)
        windows[agentId] = window
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    private func makeWindow(agentId: String) -> NSWindow {
        let surface = ScreenSurface(webGuard: ScreenWebGuard(daemonPort: hub.daemonPort), background: NSColor(Theme.background))
        surfaces[agentId] = surface
        let session = ScreenSession(agentId: agentId, hub: hub, surface: surface)

        let controls = NSHostingView(rootView: ScreenControls(session: session, hub: hub))
        let stack = NSStackView(views: [controls, surface])
        stack.orientation = .vertical
        stack.spacing = 0
        stack.distribution = .fill
        controls.setContentHuggingPriority(.required, for: .vertical)
        surface.setContentHuggingPriority(.defaultLow, for: .vertical)

        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: Self.windowSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        let name = hub.state.agents.first { $0.id == agentId }?.name ?? "Agent"
        window.title = "\(name) · Virtual computer"
        window.isReleasedWhenClosed = false
        window.contentView = stack
        window.delegate = self
        window.center()
        return window
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let entry = windows.first(where: { $0.value === window }) else { return }
        surfaces[entry.key]?.tearDown()
        window.contentView = nil
        windows[entry.key] = nil
        surfaces[entry.key] = nil
    }
}
