import AppKit
import Observation
import SwiftUI

@MainActor
@Observable
final class NotchModel {
    var screen: ScreenInfo
    var style: NotchStyle
    var layout: NotchLayout
    var expanded = false
    var tab: NotchTab = .activity
    var selectedAgentId: String?
    var showingStyles = false
    var draft = ""

    init(screen: ScreenInfo, style: NotchStyle, layout: NotchLayout) {
        self.screen = screen
        self.style = style
        self.layout = layout
    }

    var collapsedSize: CGSize { NotchGeometry.collapsedSize(style: style, screen: screen, layout: layout) }
    var topInset: CGFloat { NotchGeometry.topInset(style: style, layout: layout) }
    var compact: Bool { layout.width < NotchLayoutLimits.of(style).compactBelow }
}

final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// One floating panel per display. The window keeps the expanded size; while collapsed it ignores the
/// mouse so the menu bar under it stays clickable, and a global mouse monitor detects hovering.
@MainActor
final class NotchPanel {
    let model: NotchModel
    private let panel: KeyablePanel
    private var collapseTask: Task<Void, Never>?
    private static let collapseDelay = Duration.milliseconds(350)

    init(screen: ScreenInfo, style: NotchStyle, layout: NotchLayout, hub: HubClient, actions: NotchActions) {
        model = NotchModel(screen: screen, style: style, layout: layout)
        panel = KeyablePanel(
            contentRect: NotchGeometry.windowFrame(screen: screen),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 2)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        let root = NotchRootView(model: model, hub: hub, actions: actions)
        let hosting = NSHostingView(rootView: root)
        hosting.sizingOptions = []
        panel.contentView = hosting
        apply()
    }

    func update(screen: ScreenInfo, style: NotchStyle, layout: NotchLayout) {
        model.screen = screen
        model.style = style
        model.layout = layout
        apply()
    }

    func close() {
        panel.orderOut(nil)
    }

    func snapshotPNG() -> Data? {
        guard let view = panel.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep.representation(using: .png, properties: [:])
    }

    func mouseMoved(to point: CGPoint) {
        guard model.style != .hidden else { return }
        if model.expanded {
            if NotchGeometry.expandedZone(screen: model.screen).contains(point) {
                collapseTask?.cancel()
                collapseTask = nil
            } else if collapseTask == nil {
                collapseTask = Task { [weak self] in
                    try? await Task.sleep(for: Self.collapseDelay)
                    guard !Task.isCancelled else { return }
                    self?.setExpanded(false)
                }
            }
        } else if NotchGeometry.hotZone(style: model.style, screen: model.screen, layout: model.layout).contains(point) {
            setExpanded(true)
        }
    }

    func setExpanded(_ expanded: Bool) {
        collapseTask?.cancel()
        collapseTask = nil
        guard model.expanded != expanded else { return }
        withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) { model.expanded = expanded }
        panel.ignoresMouseEvents = !expanded
        if !expanded, panel.isKeyWindow { panel.resignKey() }
    }

    private func apply() {
        panel.setFrame(NotchGeometry.windowFrame(screen: model.screen), display: true)
        if model.style == .hidden {
            panel.orderOut(nil)
        } else {
            panel.orderFrontRegardless()
        }
    }
}
