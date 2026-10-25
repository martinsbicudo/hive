import AppKit
import CoreGraphics

enum NotchStyle: String, CaseIterable, Identifiable {
    case notch
    case island
    case minimal
    case hidden

    var id: String { rawValue }

    var title: String {
        switch self {
        case .notch: "Notch (attached to the top)"
        case .island: "Island (floating pill)"
        case .minimal: "Minimal (small dot)"
        case .hidden: "Hidden on this screen"
        }
    }

    var shortTitle: String { rawValue.capitalized }
}

enum NotchTab: String, CaseIterable, Identifiable {
    case activity, agents, approvals, usage

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

struct ScreenInfo: Equatable {
    let id: String
    let name: String
    let frame: CGRect
    let menuBarHeight: CGFloat
    let hardwareNotchWidth: CGFloat?

    var hasHardwareNotch: Bool { hardwareNotchWidth != nil }

    @MainActor
    init(screen: NSScreen) {
        let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        let displayID = CGDirectDisplayID(number?.uint32Value ?? 0)
        let uuid = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue()
        id = uuid.flatMap { CFUUIDCreateString(nil, $0) as String? } ?? screen.localizedName
        name = screen.localizedName
        frame = screen.frame
        let safeTop = screen.safeAreaInsets.top
        menuBarHeight = max(safeTop, screen.frame.maxY - screen.visibleFrame.maxY, 24)
        if safeTop > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            hardwareNotchWidth = screen.frame.width - left.width - right.width
        } else {
            hardwareNotchWidth = nil
        }
    }

    init(id: String, name: String, frame: CGRect, menuBarHeight: CGFloat, hardwareNotchWidth: CGFloat?) {
        self.id = id
        self.name = name
        self.frame = frame
        self.menuBarHeight = menuBarHeight
        self.hardwareNotchWidth = hardwareNotchWidth
    }
}

enum NotchGeometry {
    static let expandedSize = CGSize(width: 580, height: 400)
    static let wingWidth: CGFloat = 84
    static let simulatedNotchWidth: CGFloat = 200
    static let islandSize = CGSize(width: 210, height: 34)
    static let islandGap: CGFloat = 6
    static let minimalSize = CGSize(width: 64, height: 18)
    static let hoverMargin: CGFloat = 6

    static func collapsedSize(style: NotchStyle, screen: ScreenInfo, layout: NotchLayout) -> CGSize {
        switch style {
        case .notch:
            let core = screen.hardwareNotchWidth ?? simulatedNotchWidth - 2 * wingWidth
            return CGSize(width: core + 2 * layout.width, height: screen.menuBarHeight + layout.height)
        case .island, .minimal: return CGSize(width: layout.width, height: layout.height)
        case .hidden: return .zero
        }
    }

    static func topInset(style: NotchStyle, layout: NotchLayout) -> CGFloat {
        NotchLayoutLimits.of(style).offset == nil ? 0 : layout.offset
    }

    /// The window always has the expanded size, centered on the top edge, so expanding never moves it.
    static func windowFrame(screen: ScreenInfo) -> CGRect {
        CGRect(
            x: screen.frame.midX - expandedSize.width / 2,
            y: screen.frame.maxY - expandedSize.height,
            width: expandedSize.width,
            height: expandedSize.height
        )
    }

    static func hotZone(style: NotchStyle, screen: ScreenInfo, layout: NotchLayout) -> CGRect {
        let size = collapsedSize(style: style, screen: screen, layout: layout)
        guard size != .zero else { return .null }
        let top = screen.frame.maxY - topInset(style: style, layout: layout)
        return CGRect(x: screen.frame.midX - size.width / 2, y: top - size.height, width: size.width, height: size.height)
            .insetBy(dx: -hoverMargin, dy: -hoverMargin)
    }

    static func expandedZone(screen: ScreenInfo) -> CGRect {
        windowFrame(screen: screen).insetBy(dx: -hoverMargin, dy: -hoverMargin)
    }

    static func defaultStyle(for screen: ScreenInfo) -> NotchStyle {
        screen.hasHardwareNotch ? .notch : .island
    }
}

struct NotchStyleStore {
    let defaults: UserDefaults
    private static let prefix = "notchStyle."

    func style(for screen: ScreenInfo) -> NotchStyle {
        defaults.string(forKey: Self.prefix + screen.id).flatMap(NotchStyle.init(rawValue:)) ?? NotchGeometry.defaultStyle(for: screen)
    }

    func setStyle(_ style: NotchStyle, for screen: ScreenInfo) {
        defaults.set(style.rawValue, forKey: Self.prefix + screen.id)
    }
}
