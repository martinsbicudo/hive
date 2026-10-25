import AppKit

struct NotchActions {
    let openBoard: (String?) -> Void
    let openScreen: (String) -> Void
    let setStyle: (NotchStyle, ScreenInfo) -> Void
    let openSettings: (ScreenInfo) -> Void
}

@MainActor
final class NotchController {
    private let hub: HubClient
    private let store: NotchStyleStore
    private var actions: NotchActions?
    private var panels: [String: NotchPanel] = [:]
    private var monitors: [Any] = []
    private var screenObserver: NSObjectProtocol?
    /// Called after a style or layout changes or the screens change, so the menu and the settings window follow.
    var onChange: (() -> Void)?

    private static let previewTab: NotchTab? = {
        let arguments = CommandLine.arguments
        guard let flag = arguments.firstIndex(of: "--preview"), flag + 1 < arguments.count else { return nil }
        return NotchTab(rawValue: arguments[flag + 1])
    }()

    init(hub: HubClient, store: NotchStyleStore) {
        self.hub = hub
        self.store = store
    }

    var screens: [ScreenInfo] { NSScreen.screens.map(ScreenInfo.init(screen:)) }

    func start(actions: NotchActions) {
        self.actions = actions
        rebuild()
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.rebuild() }
        }
        let handler: (NSEvent) -> Void = { [weak self] _ in
            MainActor.assumeIsolated { self?.mouseMoved() }
        }
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: handler) as Any)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { event in
            handler(event)
            return event
        } as Any)
    }

    func style(for screen: ScreenInfo) -> NotchStyle {
        store.style(for: screen)
    }

    func layout(for screen: ScreenInfo) -> NotchLayout {
        store.layout(for: screen, style: store.style(for: screen))
    }

    func setStyle(_ style: NotchStyle, for screen: ScreenInfo) {
        store.setStyle(style, for: screen)
        refresh(screen)
    }

    func setLayout(_ layout: NotchLayout, for screen: ScreenInfo) {
        store.setLayout(layout, for: screen, style: store.style(for: screen))
        refresh(screen)
    }

    func resetLayouts(for screen: ScreenInfo) {
        store.resetLayouts(for: screen)
        refresh(screen)
    }

    private func refresh(_ screen: ScreenInfo) {
        let style = store.style(for: screen)
        panels[screen.id]?.update(screen: screen, style: style, layout: store.layout(for: screen, style: style))
        onChange?()
    }

    func writeSnapshots(to directory: URL) async {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let tiff = MenuBarIcon.image(height: 64)?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: directory.appendingPathComponent("menubar.png"))
        }
        for (index, panel) in panels.values.enumerated() {
            let name = "screen\(index + 1)-\(panel.model.style.rawValue)"
            panel.setExpanded(false)
            try? await Task.sleep(for: .milliseconds(600))
            try? panel.snapshotPNG()?.write(to: directory.appendingPathComponent("\(name)-collapsed.png"))
            for tab in NotchTab.allCases {
                panel.model.tab = tab
                panel.setExpanded(true)
                try? await Task.sleep(for: .milliseconds(700))
                try? panel.snapshotPNG()?.write(to: directory.appendingPathComponent("\(name)-\(tab.rawValue).png"))
            }
            panel.setExpanded(false)
        }
    }

    func reveal(tab: NotchTab) {
        let id = NSScreen.main.map { ScreenInfo(screen: $0).id }
        guard let panel = id.flatMap({ panels[$0] }) ?? panels.values.first else { return }
        panel.model.tab = tab
        panel.setExpanded(true)
    }

    func collapseAll() {
        panels.values.forEach { $0.setExpanded(false) }
    }

    private func mouseMoved() {
        let point = NSEvent.mouseLocation
        panels.values.forEach { $0.mouseMoved(to: point) }
    }

    private func rebuild() {
        guard let actions else { return }
        let current = screens
        let ids = Set(current.map(\.id))
        for (id, panel) in panels where !ids.contains(id) {
            panel.close()
            panels[id] = nil
        }
        for screen in current {
            let style = store.style(for: screen)
            let layout = store.layout(for: screen, style: style)
            if let panel = panels[screen.id] {
                panel.update(screen: screen, style: style, layout: layout)
            } else {
                let panel = NotchPanel(screen: screen, style: style, layout: layout, hub: hub, actions: actions)
                panels[screen.id] = panel
                if let tab = Self.previewTab {
                    panel.model.tab = tab
                    panel.setExpanded(true)
                }
            }
        }
        onChange?()
    }
}
