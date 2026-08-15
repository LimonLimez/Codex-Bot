// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodexBotInstaller",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "InstallerCore", targets: ["InstallerCore"]),
        .executable(name: "InstallCodexBot", targets: ["InstallCodexBot"]),
    ],
    targets: [
        .target(name: "InstallerCore"),
        .executableTarget(name: "InstallCodexBot", dependencies: ["InstallerCore"]),
        .executableTarget(
            name: "InstallerCoreTests",
            dependencies: ["InstallerCore"],
            path: "Tests/InstallerCoreTests"
        ),
    ]
)
