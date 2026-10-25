import AppKit
import Observation
import ServiceManagement
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let daemon = Daemon()
    private lazy var hub = HubClient(daemon: daemon)
    private lazy var notches = NotchController(hub: hub, store: NotchStyleStore(defaults: .standard))
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private lazy var screens = ScreenWindows(hub: hub)
    private lazy var notchSettings = NotchSettingsWindow(controller: notches)
    private lazy var notices = NoticeCenter { [weak self] route in self?.open(route) }
    private var pauseItem: NSMenuItem?
    private lazy var board = BoardPage(daemon: daemon) { [weak self] agentId in self?.openScreen(agentId: agentId) }
    private var boardWindow: NSWindow?
    private var terminationSource: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem.button?.image = MenuBarIcon.image()
        statusItem.button?.imagePosition = .imageLeading
        statusItem.menu = buildMenu()
        quitCleanlyOnSIGTERM()
        notches.start(actions: NotchActions(
            openBoard: { [weak self] agentId in self?.openBoard(agentId: agentId) },
            openScreen: { [weak self] agentId in self?.openScreen(agentId: agentId) },
            setStyle: { [weak self] style, screen in self?.notches.setStyle(style, for: screen) },
            openSettings: { [weak self] screen in self?.openNotchSettings(screen: screen) }
        ))
        notches.onChange = { [weak self] in
            self?.statusItem.menu = self?.buildMenu()
            self?.notchSettings.reload()
        }
        notices.start()
        hub.onNotice = { [weak self] notice in self?.notices.post(notice) }
        hub.start()
        showPendingApprovals()
        Task {
            do {
                try await daemon.ensureRunning()
            } catch {
                hub.setProblem(error.localizedDescription)
            }
            if let directory = Self.snapshotDirectory {
                try? await Task.sleep(for: .seconds(3))
                await notches.writeSnapshots(to: directory)
                NSApp.terminate(nil)
            }
        }
    }

    private func showPendingApprovals() {
        withObservationTracking {
            let waiting = hub.waitingApprovals
            statusItem.button?.title = hub.paused ? "⏸" : waiting > 0 ? "\(waiting)" : ""
        } onChange: { [weak self] in
            Task { @MainActor in self?.showPendingApprovals() }
        }
    }

    private func quitCleanlyOnSIGTERM() {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { NSApp.terminate(nil) }
        source.resume()
        terminationSource = source
    }

    private static let snapshotDirectory: URL? = {
        let arguments = CommandLine.arguments
        guard let flag = arguments.firstIndex(of: "--snapshot"), flag + 1 < arguments.count else { return nil }
        return URL(fileURLWithPath: arguments[flag + 1], isDirectory: true)
    }()

    func applicationWillTerminate(_ notification: Notification) {
        hub.stop()
        daemon.stop()
    }

    @objc private func openBoardFromMenu() {
        openBoard(agentId: nil)
    }

    private func open(_ route: NoticeRoute) {
        switch route {
        case .notch: notches.reveal(tab: .approvals)
        case .board(let agentId, let taskId): openBoard(agentId: agentId, taskId: taskId)
        }
    }

    func openBoard(agentId: String?, taskId: String? = nil) {
        notches.collapseAll()
        guard let url = hub.boardURL(agentId: agentId, taskId: taskId) else {
            hub.setProblem("Hive isn't running yet.")
            return
        }
        let window = boardWindow ?? makeBoardWindow()
        boardWindow = window
        if let webView = window.contentView as? WKWebView {
            webView.load(URLRequest(url: url))
        }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    private func makeBoardWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Hive"
        window.isReleasedWhenClosed = false
        window.contentView = board.makeWebView()
        window.setFrameAutosaveName("HiveBoard")
        if !window.setFrameUsingName("HiveBoard") { window.center() }
        return window
    }

    func openScreen(agentId: String) {
        notches.collapseAll()
        screens.open(agentId: agentId)
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(NSMenuItem(title: "Open Board", action: #selector(openBoardFromMenu), keyEquivalent: "b"))
        menu.addItem(.separator())
        for screen in notches.screens {
            let item = NSMenuItem(title: "Notch on \(screen.name)", action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            let current = notches.style(for: screen)
            for style in NotchStyle.allCases {
                let option = NSMenuItem(title: style.title, action: #selector(chooseStyle(_:)), keyEquivalent: "")
                option.representedObject = [screen.id, style.rawValue]
                option.state = style == current ? .on : .off
                option.target = self
                submenu.addItem(option)
            }
            item.submenu = submenu
            menu.addItem(item)
        }
        menu.addItem(NSMenuItem(title: "Notch Settings…", action: #selector(openNotchSettingsFromMenu), keyEquivalent: ","))
        let pause = NSMenuItem(title: pauseTitle, action: #selector(togglePause), keyEquivalent: "")
        pauseItem = pause
        menu.addItem(pause)
        menu.addItem(.separator())
        let login = NSMenuItem(title: "Launch at Login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(NSMenuItem(title: "Quit Hive", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.items.filter { $0.action != #selector(NSApplication.terminate(_:)) }.forEach { $0.target = self }
        return menu
    }

    private var pauseTitle: String { hub.paused ? "Resume" : "Pause Everything" }

    @objc private func togglePause() {
        hub.setPaused(!hub.paused)
    }

    @objc private func chooseStyle(_ sender: NSMenuItem) {
        guard let pair = sender.representedObject as? [String], pair.count == 2,
              let style = NotchStyle(rawValue: pair[1]),
              let screen = notches.screens.first(where: { $0.id == pair[0] }) else { return }
        notches.setStyle(style, for: screen)
    }

    @objc private func openNotchSettingsFromMenu() {
        openNotchSettings(screen: NSScreen.main.map(ScreenInfo.init(screen:)))
    }

    private func openNotchSettings(screen: ScreenInfo?) {
        notches.collapseAll()
        notchSettings.show(screen: screen)
    }

    @objc private func toggleLaunchAtLogin() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled { try service.unregister() } else { try service.register() }
        } catch {
            hub.setProblem("Launch at Login: \(error.localizedDescription)")
        }
        statusItem.menu = buildMenu()
    }
}

extension AppDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        pauseItem?.title = pauseTitle
    }
}
