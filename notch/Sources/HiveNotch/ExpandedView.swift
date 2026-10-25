import SwiftUI

struct ExpandedView: View {
    @Bindable var model: NotchModel
    let hub: HubClient
    let actions: NotchActions

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider().overlay(Color.white.opacity(0.08))
            if hub.paused { pausedBar }
            Group {
                switch model.tab {
                case .activity: ActivityTab(hub: hub, openBoard: actions.openBoard)
                case .agents: AgentsTab(model: model, hub: hub, openBoard: actions.openBoard, openScreen: actions.openScreen)
                case .approvals: ApprovalsTab(hub: hub)
                case .usage: UsageTab(hub: hub)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            if let problem = hub.problem {
                Text(problem).font(.system(size: 11)).foregroundStyle(Theme.bad).lineLimit(2)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 14)
        .foregroundStyle(.white)
    }

    private var header: some View {
        HStack(spacing: 6) {
            ForEach(NotchTab.allCases) { tab in
                Button {
                    model.tab = tab
                } label: {
                    HStack(spacing: 4) {
                        Text(tab.title)
                        if tab == .approvals, hub.waitingApprovals > 0 {
                            Text("\(hub.waitingApprovals)")
                                .font(.system(size: 10, weight: .bold))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Capsule().fill(Theme.accent))
                                .foregroundStyle(.black)
                        }
                    }
                    .font(.system(size: 12, weight: model.tab == tab ? .semibold : .regular))
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .background(Capsule().fill(model.tab == tab ? Theme.surface : .clear))
                    .foregroundStyle(model.tab == tab ? .white : Theme.secondary)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 4)
            IconButton(symbol: hub.paused ? "play.fill" : "pause.fill", help: hub.paused ? "Resume Hive" : "Pause everything", tint: hub.paused ? Theme.accent : nil) {
                hub.setPaused(!hub.paused)
            }
            .disabled(!hub.paused && hub.state.agents.isEmpty)
            IconButton(symbol: "rectangle.3.group", help: "Open the board") { actions.openBoard(nil) }
            IconButton(symbol: "desktopcomputer", help: screenAgent.map { "\($0.name)'s virtual computer" } ?? "No agent works on a virtual computer") {
                if let agent = screenAgent { actions.openScreen(agent.id) }
            }
            .disabled(screenAgent == nil)
            .opacity(screenAgent == nil ? 0.4 : 1)
            IconButton(symbol: "slider.horizontal.3", help: "Notch style on this screen") { model.showingStyles.toggle() }
                .popover(isPresented: $model.showingStyles, arrowEdge: .bottom) { stylePicker }
        }
    }

    private var pausedBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "pause.circle.fill").foregroundStyle(Theme.accent)
            Text("Hive is paused. Nothing runs until you resume.").font(.system(size: 11.5, weight: .medium))
            Spacer()
            Button("Resume") { hub.setPaused(false) }.controlSize(.small)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.accent.opacity(0.14)))
    }

    private var screenAgent: Agent? {
        let virtual = hub.state.agents.filter { $0.isVirtual && hub.state.computer(for: $0.id).canShowScreen }
        return virtual.first { $0.id == model.selectedAgentId } ?? virtual.first
    }

    private var stylePicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Style on \(model.screen.name)").font(.headline)
            ForEach(NotchStyle.allCases) { style in
                Button {
                    actions.setStyle(style, model.screen)
                    model.showingStyles = false
                } label: {
                    HStack {
                        Image(systemName: model.style == style ? "largecircle.fill.circle" : "circle")
                        Text(style.title)
                    }
                }
                .buttonStyle(.plain)
            }
            Divider()
            Button("Size and position…") {
                model.showingStyles = false
                actions.openSettings(model.screen)
            }
        }
        .padding(14)
        .frame(width: 260)
    }
}

struct IconButton: View {
    let symbol: String
    let help: String
    var tint: Color?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(tint ?? .white)
                .frame(width: 28, height: 26)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
    }
}

struct EmptyState: View {
    let symbol: String
    let text: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 22)).foregroundStyle(Theme.secondary)
            Text(text).font(.system(size: 12)).foregroundStyle(Theme.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
