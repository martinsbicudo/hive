import CoreGraphics
import Foundation

/// Size and position of the collapsed shape. For the notch style `width` is each side wing and `height` is added
/// below the menu bar; for the island and minimal styles they are the shape's own size and `offset` is the gap
/// above it.
struct NotchLayout: Codable, Equatable {
    var width: CGFloat
    var height: CGFloat
    var offset: CGFloat
}

struct NotchLayoutLimits {
    let width: ClosedRange<CGFloat>
    let height: ClosedRange<CGFloat>
    /// `nil` when the style is attached to the top edge and can't move down.
    let offset: ClosedRange<CGFloat>?
    let standard: NotchLayout
    /// Below this width the collapsed content drops the extra avatars and the "working" label.
    let compactBelow: CGFloat

    static func of(_ style: NotchStyle) -> NotchLayoutLimits {
        switch style {
        case .notch, .hidden:
            NotchLayoutLimits(
                width: 40...120, height: 0...10, offset: nil,
                standard: NotchLayout(width: NotchGeometry.wingWidth, height: 0, offset: 0), compactBelow: 80
            )
        case .island:
            NotchLayoutLimits(
                width: 150...320, height: 26...44, offset: 0...40,
                standard: NotchLayout(width: NotchGeometry.islandSize.width, height: NotchGeometry.islandSize.height, offset: NotchGeometry.islandGap),
                compactBelow: 190
            )
        case .minimal:
            NotchLayoutLimits(
                width: 36...120, height: 12...28, offset: 0...40,
                standard: NotchLayout(width: NotchGeometry.minimalSize.width, height: NotchGeometry.minimalSize.height, offset: 0),
                compactBelow: 0
            )
        }
    }

    func clamped(_ layout: NotchLayout) -> NotchLayout {
        NotchLayout(
            width: Self.clamp(layout.width, to: width, fallback: standard.width),
            height: Self.clamp(layout.height, to: height, fallback: standard.height),
            offset: offset.map { Self.clamp(layout.offset, to: $0, fallback: standard.offset) } ?? standard.offset
        )
    }

    private static func clamp(_ value: CGFloat, to range: ClosedRange<CGFloat>, fallback: CGFloat) -> CGFloat {
        value.isFinite ? min(max(value, range.lowerBound), range.upperBound) : fallback
    }
}

extension NotchStyleStore {
    private static func layoutKey(_ screen: ScreenInfo, _ style: NotchStyle) -> String {
        "notchLayout.\(screen.id).\(style.rawValue)"
    }

    func layout(for screen: ScreenInfo, style: NotchStyle) -> NotchLayout {
        let limits = NotchLayoutLimits.of(style)
        guard let data = defaults.data(forKey: Self.layoutKey(screen, style)),
              let saved = try? JSONDecoder().decode(NotchLayout.self, from: data) else { return limits.standard }
        return limits.clamped(saved)
    }

    func setLayout(_ layout: NotchLayout, for screen: ScreenInfo, style: NotchStyle) {
        let clamped = NotchLayoutLimits.of(style).clamped(layout)
        guard let data = try? JSONEncoder().encode(clamped) else { return }
        defaults.set(data, forKey: Self.layoutKey(screen, style))
    }

    func resetLayouts(for screen: ScreenInfo) {
        NotchStyle.allCases.forEach { defaults.removeObject(forKey: Self.layoutKey(screen, $0)) }
    }
}
