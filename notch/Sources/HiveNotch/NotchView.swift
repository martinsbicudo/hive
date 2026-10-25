import SwiftUI

enum Theme {
    static let accent = Color.white
    static let accentSoft = Color(red: 212 / 255, green: 212 / 255, blue: 216 / 255)
    static let accentDim = Color(red: 161 / 255, green: 161 / 255, blue: 170 / 255)
    static let background = Color.black
    static let ok = Color(red: 111 / 255, green: 211 / 255, blue: 162 / 255)
    static let bad = Color(red: 1, green: 122 / 255, blue: 107 / 255)
    static let surface = Color.white.opacity(0.07)
    static let secondary = Color.white.opacity(0.6)

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "working": ok
        case "waiting-approval": accent
        case "error": bad
        default: Color.white.opacity(0.35)
        }
    }
}

struct NotchRootView: View {
    let model: NotchModel
    let hub: HubClient
    let actions: NotchActions

    private var expandedRadius: CGFloat { 22 }

    var body: some View {
        VStack(spacing: 0) {
            if model.style != .hidden {
                shell
                    .padding(.top, model.expanded ? 0 : model.topInset)
            }
            Spacer(minLength: 0)
        }
        .frame(width: NotchGeometry.expandedSize.width, height: NotchGeometry.expandedSize.height, alignment: .top)
        .environment(\.colorScheme, .dark)
    }

    private var shell: some View {
        let size = model.expanded ? NotchGeometry.expandedSize : model.collapsedSize
        return ZStack(alignment: .top) {
            background
            if model.expanded {
                ExpandedView(model: model, hub: hub, actions: actions)
                    .padding(.top, model.style == .notch ? model.screen.menuBarHeight : 12)
                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
            } else {
                CollapsedView(model: model, hub: hub)
                    .transition(.opacity)
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(shape)
        .shadow(color: .black.opacity(model.expanded ? 0.45 : 0), radius: 18, y: 8)
    }

    private var background: some View {
        shape.fill(Color.black)
    }

    private var shape: AnyShape {
        if model.expanded {
            return AnyShape(UnevenRoundedRectangle(
                topLeadingRadius: model.style == .notch ? 0 : expandedRadius,
                bottomLeadingRadius: expandedRadius,
                bottomTrailingRadius: expandedRadius,
                topTrailingRadius: model.style == .notch ? 0 : expandedRadius
            ))
        }
        switch model.style {
        case .notch: return AnyShape(UnevenRoundedRectangle(bottomLeadingRadius: 12, bottomTrailingRadius: 12))
        case .island, .minimal, .hidden: return AnyShape(Capsule())
        }
    }
}

struct AvatarView: View {
    let agent: Agent
    let hub: HubClient
    var size: CGFloat = 22
    var showsStatus = false

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let image = hub.avatar(for: agent) {
                    Image(nsImage: image).resizable().interpolation(.high)
                } else {
                    Circle().fill(Theme.surface).overlay(Text(agent.name.prefix(1)).font(.system(size: size * 0.45, weight: .semibold)))
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            if showsStatus {
                Circle().fill(Theme.statusColor(agent.status))
                    .frame(width: size * 0.32, height: size * 0.32)
                    .overlay(Circle().stroke(Color.black, lineWidth: 1.5))
            }
        }
        .accessibilityLabel("\(agent.name), \(agent.role)")
    }
}

struct CollapsedView: View {
    let model: NotchModel
    let hub: HubClient

    var body: some View {
        switch model.style {
        case .minimal: minimal
        case .notch: notch
        case .island, .hidden: island
        }
    }

    private var working: [Agent] { hub.workingAgents }

    private var minimal: some View {
        HStack(spacing: 4) {
            Circle().fill(statusColor).frame(width: 7, height: 7)
            if hub.waitingApprovals > 0 {
                Text("\(hub.waitingApprovals)").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.accent)
            } else if !working.isEmpty {
                Text("\(working.count)").font(.system(size: 10, weight: .semibold)).foregroundStyle(.white)
            }
        }
    }

    private var notch: some View {
        HStack(spacing: 0) {
            leftWing.frame(width: model.layout.width - wingPadding, alignment: .leading).padding(.leading, wingPadding)
            Spacer(minLength: 0)
            rightWing.frame(width: model.layout.width - wingPadding, alignment: .trailing).padding(.trailing, wingPadding)
        }
        .frame(maxHeight: .infinity)
    }

    private var wingPadding: CGFloat { model.compact ? 8 : 12 }

    private var island: some View {
        HStack(spacing: 8) {
            leftWing
            Spacer(minLength: 0)
            rightWing
        }
        .padding(.horizontal, 10)
        .frame(maxHeight: .infinity)
    }

    private var leftWing: some View {
        HStack(spacing: -6) {
            if working.isEmpty {
                TeamStackMark(height: 13)
            } else {
                ForEach(working.prefix(model.compact ? 1 : 3)) { agent in
                    AvatarView(agent: agent, hub: hub, size: 20).overlay(Circle().stroke(Color.black, lineWidth: 1.5))
                }
            }
        }
    }

    private var rightWing: some View {
        HStack(spacing: 5) {
            if hub.paused {
                Image(systemName: "pause.fill").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.accent)
                if !model.compact {
                    Text("Paused").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.accent)
                }
            } else if hub.waitingApprovals > 0 {
                Label("\(hub.waitingApprovals)", systemImage: "hand.raised.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.accent)
                    .labelStyle(.titleAndIcon)
            } else if !working.isEmpty {
                Circle().fill(Theme.ok).frame(width: 6, height: 6)
                Text(model.compact ? "\(working.count)" : "\(working.count) working").font(.system(size: 11, weight: .medium)).foregroundStyle(.white)
            } else if !hub.connected {
                Image(systemName: "bolt.horizontal.circle").font(.system(size: 12)).foregroundStyle(Theme.secondary)
            } else {
                Image(systemName: "moon.zzz.fill").font(.system(size: 11)).foregroundStyle(Theme.secondary)
            }
        }
    }

    private var statusColor: Color {
        if hub.waitingApprovals > 0 { return Theme.accent }
        if !working.isEmpty { return Theme.ok }
        return hub.connected ? Color.white.opacity(0.5) : Theme.bad
    }
}
