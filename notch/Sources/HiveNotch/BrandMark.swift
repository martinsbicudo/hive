import AppKit
import SwiftUI

struct RoundedHexagon: Shape {
    var cornerRadius: CGFloat

    func path(in rect: CGRect) -> Path {
        let radius = rect.height / 2
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let corners = (0..<6).map { index in
            let angle = Double.pi / 180 * Double(-90 + 60 * index)
            return CGPoint(x: center.x + radius * CGFloat(cos(angle)), y: center.y + radius * CGFloat(sin(angle)))
        }
        var path = Path()
        let firstEdgeMidpoint = CGPoint(x: (corners[5].x + corners[0].x) / 2, y: (corners[5].y + corners[0].y) / 2)
        path.move(to: firstEdgeMidpoint)
        for index in 0..<6 {
            path.addArc(tangent1End: corners[index], tangent2End: corners[(index + 1) % 6], radius: cornerRadius)
        }
        path.closeSubpath()
        return path
    }
}

struct BrandGeometry {
    let cellRadius: CGFloat
    let spacing: CGFloat
    let gap: CGFloat
    let corner: CGFloat
    let eye: CGFloat

    static let regular = BrandGeometry(cellRadius: 58, spacing: 56, gap: 10, corner: 12, eye: 17)
    static let small = BrandGeometry(cellRadius: 60, spacing: 50, gap: 16, corner: 10, eye: 22)
    static let eyeSpread: CGFloat = 19
    static let eyeLift: CGFloat = 5
    static let smallCutBelow: CGFloat = 24

    static func forHeight(_ height: CGFloat) -> BrandGeometry {
        height < smallCutBelow ? .small : .regular
    }

    var cellWidth: CGFloat { cellRadius * sqrt(3) }
    var width: CGFloat { 2 * spacing + cellWidth }
    var height: CGFloat { 2 * cellRadius }
}

struct TeamStackMark: View {
    var height: CGFloat
    var colors: [Color] = [Theme.accent, Theme.accent, Theme.accent]

    var body: some View {
        let geometry = BrandGeometry.forHeight(height)
        let scale = height / geometry.height
        let cell = CGSize(width: geometry.cellWidth * scale, height: geometry.height * scale)
        let gap = geometry.gap * scale
        let hexagon = RoundedHexagon(cornerRadius: geometry.corner * scale)
        ZStack(alignment: .leading) {
            ForEach(Array(colors.enumerated()), id: \.offset) { index, color in
                let x = CGFloat(index) * geometry.spacing * scale
                if index > 0 {
                    hexagon
                        .frame(width: cell.width + 2 * gap, height: cell.height + 2 * gap)
                        .offset(x: x - gap)
                        .blendMode(.destinationOut)
                }
                hexagon.fill(color).frame(width: cell.width, height: cell.height).offset(x: x)
            }
            let face = CGFloat(colors.count - 1) * geometry.spacing * scale + cell.width / 2
            let eye = geometry.eye * scale
            ForEach([-1, 1], id: \.self) { side in
                RoundedRectangle(cornerRadius: eye * 0.15)
                    .frame(width: eye, height: eye)
                    .offset(x: face - eye / 2 + CGFloat(side) * BrandGeometry.eyeSpread * scale, y: -BrandGeometry.eyeLift * scale)
                    .blendMode(.destinationOut)
            }
        }
        .frame(width: geometry.width * scale, height: cell.height, alignment: .leading)
        .drawingGroup()
        .accessibilityLabel("Hive")
    }
}

@MainActor
enum MenuBarIcon {
    static func image(height: CGFloat = 13) -> NSImage? {
        let renderer = ImageRenderer(content: TeamStackMark(height: height, colors: [.black, .black, .black]))
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2
        guard let image = renderer.nsImage else { return nil }
        image.isTemplate = true
        return image
    }
}
