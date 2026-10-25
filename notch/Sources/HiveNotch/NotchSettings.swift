import AppKit
import Observation
import SwiftUI

/// What the settings window shows: one screen at a time, read back from the controller after every change.
@MainActor
@Observable
final class NotchSettingsModel {
    private let controller: NotchController
    var screens: [ScreenInfo] = []
    var screenId = ""
    var style: NotchStyle = .notch
    var layout = NotchLayoutLimits.of(.notch).standard

    init(controller: NotchController) {
        self.controller = controller
    }

    var screen: ScreenInfo? { screens.first { $0.id == screenId } }
    var limits: NotchLayoutLimits { NotchLayoutLimits.of(style) }

    func show(_ screen: ScreenInfo?) {
        if let screen { screenId = screen.id }
        reload()
    }

    func reload() {
        screens = controller.screens
        if screen == nil { screenId = screens.first?.id ?? "" }
        guard let screen else { return }
        style = controller.style(for: screen)
        layout = controller.layout(for: screen)
    }

    func choose(screenId: String) {
        self.screenId = screenId
        reload()
    }

    func choose(style: NotchStyle) {
        guard let screen else { return }
        controller.setStyle(style, for: screen)
    }

    func change(_ edit: (inout NotchLayout) -> Void) {
        guard let screen else { return }
        var next = layout
        edit(&next)
        controller.setLayout(next, for: screen)
    }

    func reset() {
        guard let screen else { return }
        controller.resetLayouts(for: screen)
    }
}

struct NotchSettingsView: View {
    @Bindable var model: NotchSettingsModel

    var body: some View {
        Form {
            if model.screens.count > 1 {
                Picker("Screen", selection: Binding(get: { model.screenId }, set: { model.choose(screenId: $0) })) {
                    ForEach(model.screens, id: \.id) { Text($0.name).tag($0.id) }
                }
            }
            Picker("Style", selection: Binding(get: { model.style }, set: { model.choose(style: $0) })) {
                ForEach(NotchStyle.allCases) { Text($0.shortTitle).tag($0) }
            }
            .pickerStyle(.segmented)
            if model.style == .hidden {
                Text("Hive shows nothing on this screen.").foregroundStyle(.secondary)
            } else {
                sliders
            }
            Section {
                HStack {
                    Text("Saved for \(model.screen?.name ?? "this screen") only. Each style keeps its own size.")
                        .font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button("Reset this screen") { model.reset() }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 440)
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var sliders: some View {
        let attached = model.style == .notch
        Section {
            row(attached ? "Side width" : "Width", value: \.width, range: model.limits.width)
            row(attached ? "Extra height" : "Height", value: \.height, range: model.limits.height)
            if let offset = model.limits.offset {
                row("Distance from top", value: \.offset, range: offset)
            }
        } footer: {
            if attached {
                Text(model.screen?.hasHardwareNotch == true
                    ? "Attached to the camera notch. Narrow sides show one avatar and a count."
                    : "Attached to the top edge, like a MacBook notch.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private func row(_ title: String, value: WritableKeyPath<NotchLayout, CGFloat>, range: ClosedRange<CGFloat>) -> some View {
        LabeledContent(title) {
            HStack {
                Slider(value: Binding(get: { model.layout[keyPath: value] }, set: { new in model.change { $0[keyPath: value] = new.rounded() } }), in: range)
                    .accessibilityLabel(title)
                Text("\(Int(model.layout[keyPath: value])) pt").monospacedDigit().frame(width: 44, alignment: .trailing)
            }
        }
    }
}

/// The "Notch Settings" window. It sits in the middle of the screen it edits so the notch stays visible above it.
@MainActor
final class NotchSettingsWindow {
    private let model: NotchSettingsModel
    private var window: NSWindow?

    init(controller: NotchController) {
        model = NotchSettingsModel(controller: controller)
    }

    func reload() {
        guard window?.isVisible == true else { return }
        model.reload()
    }

    func show(screen: ScreenInfo?) {
        model.show(screen)
        let window = self.window ?? makeWindow()
        self.window = window
        if let frame = model.screen?.frame {
            let size = window.frame.size
            window.setFrameOrigin(CGPoint(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2))
        }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    private func makeWindow() -> NSWindow {
        let hosting = NSHostingView(rootView: NotchSettingsView(model: model))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: hosting.fittingSize), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Notch Settings"
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        return window
    }
}
