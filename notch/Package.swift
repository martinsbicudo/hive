// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "HiveNotch",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(
            name: "HiveNotch",
            path: "Sources/HiveNotch",
            linkerSettings: [.linkedFramework("WebKit"), .linkedFramework("ServiceManagement")]
        ),
        .testTarget(name: "HiveNotchTests", dependencies: ["HiveNotch"], path: "Tests/HiveNotchTests"),
    ],
    swiftLanguageModes: [.v5]
)
