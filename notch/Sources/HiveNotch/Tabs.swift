import SwiftUI

struct ActivityTab: View {
    let hub: HubClient
    let openBoard: (String?) -> Void

    var body: some View {
        if hub.state.activity.isEmpty {
            EmptyState(symbol: "moon.zzz", text: hub.state.agents.isEmpty ? "No agents yet. Open the board to create one." : "Everyone is sleeping.")
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(hub.state.activity) { item in
                            row(item, now: context.date)
                        }
                    }
                }
            }
        }
    }

    private func row(_ item: ActivityItem, now: Date) -> some View {
        Button {
            openBoard(item.agentId)
        } label: {
            HStack(spacing: 10) {
                if let agent = hub.state.agents.first(where: { $0.id == item.agentId }) {
                    AvatarView(agent: agent, hub: hub, size: 30, showsStatus: true)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(item.name) · \(item.role)").font(.system(size: 12, weight: .semibold))
                    if let title = item.taskTitle, !title.isEmpty {
                        Label(title, systemImage: "checklist").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.accent).lineLimit(1)
                    }
                    Text(Format.step(item.detail)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondary).lineLimit(1)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Format.elapsed(since: item.since, now: now)).font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.secondary)
                    if item.queued > 0 { Text("+\(item.queued) queued").font(.system(size: 10)).foregroundStyle(Theme.accent) }
                }
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
        }
        .buttonStyle(.plain)
    }
}

struct AgentsTab: View {
    @Bindable var model: NotchModel
    let hub: HubClient
    let openBoard: (String?) -> Void
    let openScreen: (String) -> Void

    private var selected: Agent? {
        hub.state.agents.first { $0.id == model.selectedAgentId } ?? hub.state.agents.first
    }

    var body: some View {
        if hub.state.agents.isEmpty {
            EmptyState(symbol: "person.crop.circle.badge.plus", text: "No agents yet. Open the board to create one.")
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(hub.state.agents) { agent in
                            Button {
                                model.selectedAgentId = agent.id
                            } label: {
                                VStack(spacing: 4) {
                                    AvatarView(agent: agent, hub: hub, size: 42, showsStatus: true)
                                        .overlay(Circle().stroke(selected?.id == agent.id ? Theme.accent : .clear, lineWidth: 2).padding(-3))
                                    Text(agent.name).font(.system(size: 11, weight: .medium)).lineLimit(1)
                                }
                                .frame(width: 58)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(4)
                }
                if let agent = selected { detail(agent) }
            }
        }
    }

    private func detail(_ agent: Agent) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(agent.name) · \(agent.role)").font(.system(size: 13, weight: .semibold))
                    Text(agent.activity.map(Format.step) ?? statusText(agent)).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
                    if let wake = agent.nextWake.flatMap({ Format.nextWake($0) }) {
                        Label("Next wake \(wake)", systemImage: "clock").font(.system(size: 11)).foregroundStyle(Theme.accent).lineLimit(1)
                    }
                }
                Spacer()
                if agent.isWorking {
                    Button("Stop") { hub.stopAgent(agent) }.controlSize(.small)
                }
                Button("Virtual computer") { openScreen(agent.id) }
                    .controlSize(.small)
                    .disabled(!agent.isVirtual || !hub.state.computer(for: agent.id).canShowScreen)
                    .help(screenHelp(agent))
                Button("Open chat") { openBoard(agent.id) }.controlSize(.small)
            }
            HStack(spacing: 6) {
                TextField("Message \(agent.name)…", text: $model.draft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { send(to: agent) }
                Button("Send") { send(to: agent) }
                    .disabled(model.draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
    }

    private func send(to agent: Agent) {
        let text = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        hub.send(text, to: agent)
        model.draft = ""
    }

    private func statusText(_ agent: Agent) -> String {
        if agent.isVirtual, agent.status == "sleeping" { return "Virtual computer · \(hub.state.computer(for: agent.id).label)" }
        return switch agent.status {
        case "working": "Working"
        case "waiting-approval": "Waiting for your approval"
        case "error": "Last task failed"
        default: "Sleeping"
        }
    }

    private func screenHelp(_ agent: Agent) -> String {
        guard agent.isVirtual else { return "\(agent.name) works on your Mac" }
        guard hub.state.computer(for: agent.id).canShowScreen else { return "This computer profile has no screen" }
        return "Watch and control its virtual computer"
    }
}

struct ApprovalsTab: View {
    let hub: HubClient

    var body: some View {
        if hub.state.approvals.isEmpty {
            EmptyState(symbol: "checkmark.shield", text: "Nothing waiting for your approval.")
        } else {
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(hub.state.approvals) { approval in
                        VStack(alignment: .leading, spacing: 8) {
                            if let display = approval.display {
                                OutwardCardView(agentName: approval.agentName, display: display)
                            } else {
                                HStack(spacing: 8) {
                                    if let agent = hub.state.agents.first(where: { $0.id == approval.agentId }) {
                                        AvatarView(agent: agent, hub: hub, size: 24)
                                    }
                                    Text(approval.isTaskGate ? "\(approval.agentName) needs your OK" : "\(approval.agentName) wants to run").font(.system(size: 12, weight: .semibold))
                                    Spacer()
                                }
                                ScrollView {
                                    Text(approval.summary)
                                        .font(approval.isTaskGate ? .system(size: 11.5) : .system(size: 11, design: .monospaced))
                                        .textSelection(.enabled)
                                        .lineLimit(approval.showsFullText ? nil : 4)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(8)
                                }
                                .frame(maxHeight: approval.showsFullText ? 140 : nil)
                                .fixedSize(horizontal: false, vertical: !approval.showsFullText)
                                .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.05)))
                            }
                            if approval.tainted {
                                Text("This run read external content.")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(Theme.bad)
                            }
                            HStack {
                                Button("Deny") { hub.decide(approval, allow: false) }
                                Spacer()
                                if approval.rememberable {
                                    Button("Always allow") { hub.decide(approval, allow: true, remember: true) }
                                        .help("Allow this kind of action for this agent from now on")
                                }
                                Button("Allow") { hub.decide(approval, allow: true) }
                                    .buttonStyle(.borderedProminent)
                                    .tint(Theme.accent)
                            }
                            .controlSize(.small)
                        }
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 12).stroke(Theme.accent.opacity(0.5)))
                    }
                }
            }
        }
    }
}

struct UsageTab: View {
    let hub: HubClient

    var body: some View {
        if hub.state.usage.isEmpty {
            EmptyState(symbol: "chart.bar", text: "No agents yet, so nothing has been spent.")
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(hub.state.usage) { usage in
                        card(usage)
                    }
                }
                Text("Claude Code shows the API-equivalent cost of each run; on a plan it counts toward your limits. Codex reports tokens.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Theme.secondary)
            }
        }
    }

    private func card(_ usage: EngineUsage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(usage.displayName).font(.system(size: 13, weight: .semibold))
                Spacer()
                if usage.activeRuns > 0 {
                    Text("\(usage.activeRuns) running").font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.ok)
                }
            }
            if usage.reportsCost {
                metric("Today", Format.usd(usage.todayUsd))
                metric("7 days", Format.usd(usage.weekUsd))
                metric("Month", Format.usd(usage.monthUsd))
            } else {
                metric("Tokens today", Format.tokens(usage.todayTokens))
            }
            Text("\(usage.agents) agent\(usage.agents == 1 ? "" : "s")").font(.system(size: 10.5)).foregroundStyle(Theme.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
    }

    private func metric(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.system(size: 11.5)).foregroundStyle(Theme.secondary)
            Spacer()
            Text(value).font(.system(size: 12.5, weight: .semibold).monospacedDigit())
        }
    }
}
