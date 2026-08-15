import Foundation
import CryptoKit
import InstallerCore

private final class RecordingRunner: CommandRunning, @unchecked Sendable {
    private(set) var calls: [CommandCall] = []
    var handler: ((CommandCall) throws -> CommandResult)?

    func run(_ call: CommandCall) throws -> CommandResult {
        calls.append(call)
        return try handler?(call) ?? CommandResult(status: 0, stdout: Data(), stderr: Data())
    }
}

private final class ExactIntegrationRunner: CommandRunning, @unchecked Sendable {
    private let base = ProcessCommandRunner()

    func run(_ call: CommandCall) throws -> CommandResult {
        let phase: String
        if call.arguments.contains("--manifest") { phase = "verify-vendor" }
        else if call.arguments.contains("--source-asar") { phase = "patch-asar" }
        else if call.executable.lastPathComponent == "codesign" && call.arguments.contains("--verify") { phase = "verify-signature" }
        else if call.executable.lastPathComponent == "codesign" { phase = "sign" }
        else { phase = "audit-contract" }
        let result = try base.run(call)
        FileHandle.standardError.write(Data("EXACT \(phase) status=\(result.status)\n".utf8))
        return result
    }
}

private func temporaryDirectory() throws -> URL {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("codex-bot-installer-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
}

private func makeFixture(at root: URL) throws -> InstallerPaths {
    let vendor = root.appendingPathComponent("Grok Bot.app", isDirectory: true)
    let resources = vendor.appendingPathComponent("Contents/Resources", isDirectory: true)
    let macOS = vendor.appendingPathComponent("Contents/MacOS", isDirectory: true)
    try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
    try Data("vendor-asar".utf8).write(to: resources.appendingPathComponent("app.asar"))
    try Data("electron".utf8).write(to: macOS.appendingPathComponent("Grok Bot"))
    let plist: [String: Any] = [
        "CFBundleIdentifier": "com.anysphere.sand",
        "CFBundleName": "Grok Bot",
        "CFBundleDisplayName": "Grok Bot",
        "CFBundleShortVersionString": "0.20.0",
        "CFBundleVersion": "0.20.0",
        "CFBundleExecutable": "Grok Bot",
    ]
    let plistData = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try plistData.write(to: vendor.appendingPathComponent("Contents/Info.plist"))

    let payload = root.appendingPathComponent("Payload", isDirectory: true)
    try FileManager.default.createDirectory(at: payload, withIntermediateDirectories: true)
    let verifier = payload.appendingPathComponent("verify-vendor-app.cjs")
    let manifest = payload.appendingPathComponent("vendor-manifest.json")
    let patcher = payload.appendingPathComponent("patch-app.cjs")
    let auditor = payload.appendingPathComponent("audit-grok-contract.cjs")
    let sidecar = payload.appendingPathComponent("cli-proxy-api")
    let license = payload.appendingPathComponent("CLIProxyAPI-LICENSE")
    for file in [verifier, manifest, patcher, auditor, sidecar, license] {
        try Data(file.lastPathComponent.utf8).write(to: file)
    }
    let sidecarData = try Data(contentsOf: sidecar)
    let sidecarHash = SHA256.hash(data: sidecarData).map { String(format: "%02x", $0) }.joined()
    return InstallerPaths(
        vendorApp: vendor,
        destinationApp: root.appendingPathComponent("Applications/Codex Bot.app", isDirectory: true),
        workingDirectory: root.appendingPathComponent("Applications", isDirectory: true),
        verifierScript: verifier,
        vendorManifest: manifest,
        patcherScript: patcher,
        contractAuditor: auditor,
        sidecarBinary: sidecar,
        sidecarLicense: license,
        expectedSidecarBytes: sidecarData.count,
        expectedSidecarSHA256: sidecarHash,
        signingIdentity: "-"
    )
}

private enum TestFailure: Error { case assertion(String) }

private func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw TestFailure.assertion(message) }
}

private func expectInstallerFailure(_ operation: () throws -> Void) throws {
    do {
        try operation()
        throw TestFailure.assertion("expected InstallerFailure")
    } catch is InstallerFailure {
        return
    }
}

@main
struct InstallerCoreTestMain {
    static func fileSHA256(_ url: URL) throws -> String {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func testInstallsTransactionally() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = try makeFixture(at: root)
        let original = try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/Resources/app.asar"))
        let runner = RecordingRunner()
        runner.handler = { call in
            if call.arguments.contains("--target-asar"), let index = call.arguments.firstIndex(of: "--target-asar") {
                try Data("patched-asar".utf8).write(to: URL(fileURLWithPath: call.arguments[index + 1]))
            }
            return CommandResult(status: 0, stdout: Data(), stderr: Data())
        }
        let receipt = try InstallerTransaction(paths: paths, runner: runner).install()
        try expect(receipt.destination == paths.destinationApp, "destination mismatch")
        try expect(try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/Resources/app.asar")) == original, "vendor mutated")
        try expect(String(data: try Data(contentsOf: paths.destinationApp.appendingPathComponent("Contents/Resources/app.asar")), encoding: .utf8) == "patched-asar", "patch missing")
        try expect(FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/cliproxy/cli-proxy-api").path), "sidecar missing")
        let sidecarReceipt = try JSONSerialization.jsonObject(with: Data(contentsOf: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/cliproxy/receipt.json"))) as? [String: Any]
        let installedSidecarBytes = try Data(contentsOf: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/cliproxy/cli-proxy-api")).count
        try expect(sidecarReceipt?["bytes"] as? Int == installedSidecarBytes, "signed sidecar receipt bytes mismatch")
        try expect((sidecarReceipt?["sha256"] as? String)?.count == 64, "signed sidecar receipt hash missing")
        let installedInfo = try PropertyListSerialization.propertyList(
            from: Data(contentsOf: paths.destinationApp.appendingPathComponent("Contents/Info.plist")),
            options: [], format: nil
        ) as? [String: Any]
        try expect(installedInfo?["CFBundleDisplayName"] as? String == "Codex Bot", "Finder display name mismatch")
        try expect(installedInfo?["CFBundleName"] as? String == "Grok Bot", "Electron helper discovery name changed")
        try expect(runner.calls.contains { $0.environment["ELECTRON_RUN_AS_NODE"] == "1" && $0.arguments.contains("--source-asar") }, "node boundary missing")
        try expect(runner.calls.filter { $0.environment["ELECTRON_RUN_AS_NODE"] == "1" }.allSatisfy { $0.environment["ELECTRON_NO_ASAR"] == "1" }, "Electron ASAR virtualization was not disabled")
    }

    static func testRejectsUnsafeVendor() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        var paths = try makeFixture(at: root)
        let realVendor = paths.vendorApp
        let link = root.appendingPathComponent("Grok Link.app")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: realVendor)
        paths.vendorApp = link
        let runner = RecordingRunner()
        try expectInstallerFailure { _ = try InstallerTransaction(paths: paths, runner: runner).install() }
        try expect(runner.calls.isEmpty, "unsafe vendor reached process runner")
        try expect(!FileManager.default.fileExists(atPath: paths.destinationApp.path), "unsafe vendor mutated destination")
    }

    static func testRestoresPreviousApp() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = try makeFixture(at: root)
        try FileManager.default.createDirectory(at: paths.destinationApp, withIntermediateDirectories: true)
        try Data("previous".utf8).write(to: paths.destinationApp.appendingPathComponent("marker"))
        let runner = RecordingRunner()
        runner.handler = { call in
            if call.arguments.contains("--target-asar"), let index = call.arguments.firstIndex(of: "--target-asar") {
                try Data("patched-asar".utf8).write(to: URL(fileURLWithPath: call.arguments[index + 1]))
            }
            if call.executable.path == "/usr/bin/codesign" { throw InstallerFailure.commandFailed }
            return CommandResult(status: 0, stdout: Data(), stderr: Data())
        }
        try expectInstallerFailure { _ = try InstallerTransaction(paths: paths, runner: runner).install() }
        try expect(String(data: try Data(contentsOf: paths.destinationApp.appendingPathComponent("marker")), encoding: .utf8) == "previous", "previous app changed")
    }

    static func testExactVendorIntegrationIfRequested() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let vendorPath = environment["CODEX_BOT_EXACT_VENDOR_APP"],
              let installerPath = environment["CODEX_BOT_EXACT_INSTALLER_APP"] else { return }
        let vendor = URL(fileURLWithPath: vendorPath, isDirectory: true)
        let installer = URL(fileURLWithPath: installerPath, isDirectory: true)
        let resources = installer.appendingPathComponent("Contents/Resources", isDirectory: true)
        let patcher = resources.appendingPathComponent("Patcher", isDirectory: true)
        let installerInfo = try PropertyListSerialization.propertyList(
            from: Data(contentsOf: installer.appendingPathComponent("Contents/Info.plist")),
            options: [], format: nil
        ) as? [String: Any]
        guard let expectedSidecarBytes = installerInfo?["CodexBotSidecarBytes"] as? Int,
              let expectedSidecarSHA256 = installerInfo?["CodexBotSidecarSHA256"] as? String else {
            throw TestFailure.assertion("installer sidecar receipt missing")
        }
        let requestedOutput = environment["CODEX_BOT_EXACT_OUTPUT_DIRECTORY"]
        let root: URL
        let removeAfterTest: Bool
        if let requestedOutput {
            root = URL(fileURLWithPath: requestedOutput, isDirectory: true).standardizedFileURL
            guard !FileManager.default.fileExists(atPath: root.path) else {
                throw TestFailure.assertion("exact integration output already exists")
            }
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            removeAfterTest = false
        } else {
            root = try temporaryDirectory()
            removeAfterTest = true
        }
        defer { if removeAfterTest { try? FileManager.default.removeItem(at: root) } }
        let vendorAsar = vendor.appendingPathComponent("Contents/Resources/app.asar")
        let before = try fileSHA256(vendorAsar)
        let sidecar = resources.appendingPathComponent("CLIProxy/cli-proxy-api")
        let paths = InstallerPaths(
            vendorApp: vendor,
            destinationApp: root.appendingPathComponent("Applications/Codex Bot.app", isDirectory: true),
            workingDirectory: root.appendingPathComponent("Applications", isDirectory: true),
            verifierScript: patcher.appendingPathComponent("scripts/verify-vendor-app.cjs"),
            vendorManifest: patcher.appendingPathComponent("assets/grok-bot-0.20.0-darwin-arm64.manifest.json"),
            patcherScript: patcher.appendingPathComponent("scripts/patch-app.cjs"),
            contractAuditor: patcher.appendingPathComponent("scripts/audit-grok-contract.cjs"),
            sidecarBinary: sidecar,
            sidecarLicense: resources.appendingPathComponent("CLIProxy/LICENSE"),
            expectedSidecarBytes: expectedSidecarBytes,
            expectedSidecarSHA256: expectedSidecarSHA256,
            signingIdentity: "-"
        )
        let receipt = try InstallerTransaction(paths: paths, runner: ExactIntegrationRunner()).install()
        try expect(receipt.destination == paths.destinationApp, "exact install destination mismatch")
        try expect(try fileSHA256(vendorAsar) == before, "exact vendor app was modified")
        let info = try PropertyListSerialization.propertyList(
            from: Data(contentsOf: paths.destinationApp.appendingPathComponent("Contents/Info.plist")),
            options: [], format: nil
        ) as? [String: Any]
        try expect(info?["CFBundleIdentifier"] as? String == "com.limonlimez.codex-bot", "installed bundle identifier mismatch")
        try expect(info?["CFBundleShortVersionString"] as? String == "0.1.4-macos.1", "installed version mismatch")
        try expect(FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/cliproxy/cli-proxy-api").path), "installed pinned sidecar missing")
        try expect(!FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Resources/.codex-vendor.asar").path), "vendor staging artifact leaked")
        print("PASS exact Grok Bot 0.20.0 integration installs an isolated verified Codex Bot app")
    }

    static func main() throws {
        try testInstallsTransactionally()
        print("PASS installer copies and patches a separate app without modifying Grok Bot")
        try testRejectsUnsafeVendor()
        print("PASS installer rejects symlinked vendor input before mutation")
        try testRestoresPreviousApp()
        print("PASS failed installation preserves the exact previous Codex Bot app")
        try testExactVendorIntegrationIfRequested()
    }
}
