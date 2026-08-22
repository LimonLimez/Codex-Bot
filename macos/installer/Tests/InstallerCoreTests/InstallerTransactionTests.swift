import Foundation
import CryptoKit
@testable import InstallerCore

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

private final class CleanupFailingFileManager: FileManager, @unchecked Sendable {
    override func removeItem(at URL: URL) throws {
        if URL.lastPathComponent.hasPrefix("openbot-grok-bot-") {
            throw CocoaError(.fileWriteNoPermission)
        }
        try super.removeItem(at: URL)
    }
}

private func temporaryDirectory() throws -> URL {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("codex-bot-installer-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
}

private let helperVariants: [(suffix: String, vendorIdentifier: String, openBotIdentifier: String)] = [
    ("", "com.anysphere.sand.helper", "com.limonlimez.openbot.helper"),
    (" (GPU)", "com.anysphere.sand.helper.GPU", "com.limonlimez.openbot.helper.GPU"),
    (" (Plugin)", "com.anysphere.sand.helper.Plugin", "com.limonlimez.openbot.helper.Plugin"),
    (" (Renderer)", "com.anysphere.sand.helper.Renderer", "com.limonlimez.openbot.helper.Renderer"),
]

private func writePlist(_ plist: [String: Any], to url: URL) throws {
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: url)
}

private func readPlist(_ url: URL) throws -> [String: Any] {
    guard let plist = try PropertyListSerialization.propertyList(
        from: Data(contentsOf: url), options: [], format: nil
    ) as? [String: Any] else {
        throw InstallerFailure.invalidInput
    }
    return plist
}

private func helperSignatureDisplay(identifier: String, valid: Bool = true) -> Data {
    let flags = valid ? "0x10002(adhoc,runtime)" : "0x2(adhoc)"
    let entitlements = valid
        ? "<dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict>"
        : "<dict><key>com.apple.security.cs.allow-jit</key><true/></dict>"
    return Data("""
    Identifier=\(identifier)
    CodeDirectory v=20500 size=805 flags=\(flags) hashes=14+7 location=embedded
    Signature=adhoc
    # designated => cdhash H"0123456789abcdef0123456789abcdef01234567"
    <?xml version="1.0" encoding="UTF-8"?><plist version="1.0">\(entitlements)</plist>
    """.utf8)
}

private func simulatedInstallCommand(
    _ call: CommandCall,
    invalidSignatureSuffix: String? = nil
) throws -> CommandResult {
    if call.arguments.contains("--target-asar"),
       let index = call.arguments.firstIndex(of: "--target-asar") {
        try Data("patched-asar".utf8).write(to: URL(fileURLWithPath: call.arguments[index + 1]))
    }
    if call.executable.path == "/usr/bin/codesign", call.arguments.contains("--display") {
        guard let targetPath = call.arguments.last,
              let variant = helperVariants.first(where: {
                  URL(fileURLWithPath: targetPath).lastPathComponent == "OpenBot Helper\($0.suffix).app"
              }) else {
            return CommandResult(status: 1, stdout: Data(), stderr: Data("unexpected signature target".utf8))
        }
        return CommandResult(
            status: 0,
            stdout: Data(),
            stderr: helperSignatureDisplay(
                identifier: variant.openBotIdentifier,
                valid: variant.suffix != invalidSignatureSuffix
            )
        )
    }
    return CommandResult(status: 0, stdout: Data(), stderr: Data())
}

private func makeFixture(at root: URL) throws -> InstallerPaths {
    let vendor = root.appendingPathComponent("Grok Bot.app", isDirectory: true)
    let resources = vendor.appendingPathComponent("Contents/Resources", isDirectory: true)
    let macOS = vendor.appendingPathComponent("Contents/MacOS", isDirectory: true)
    let frameworks = vendor.appendingPathComponent("Contents/Frameworks", isDirectory: true)
    try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: frameworks, withIntermediateDirectories: true)
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
    try writePlist(plist, to: vendor.appendingPathComponent("Contents/Info.plist"))
    for variant in helperVariants {
        let helperName = "Grok Bot Helper\(variant.suffix)"
        let helper = frameworks.appendingPathComponent("\(helperName).app", isDirectory: true)
        let helperMacOS = helper.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: helperMacOS, withIntermediateDirectories: true)
        try Data("\(helperName) executable".utf8).write(
            to: helperMacOS.appendingPathComponent(helperName)
        )
        try writePlist([
            "CFBundleIdentifier": variant.vendorIdentifier,
            "CFBundleName": "Electron Helper\(variant.suffix)",
            "CFBundleDisplayName": helperName,
            "CFBundleExecutable": helperName,
            "CFBundlePackageType": "APPL",
            "CFBundleVersion": "0.20.0",
            "LSUIElement": true,
        ], to: helper.appendingPathComponent("Contents/Info.plist"))
    }

    let payload = root.appendingPathComponent("Payload", isDirectory: true)
    try FileManager.default.createDirectory(at: payload, withIntermediateDirectories: true)
    let verifier = payload.appendingPathComponent("verify-vendor-app.cjs")
    let manifest = payload.appendingPathComponent("vendor-manifest.json")
    let patcher = payload.appendingPathComponent("patch-app.cjs")
    let auditor = payload.appendingPathComponent("audit-grok-contract.cjs")
    let sidecar = payload.appendingPathComponent("cli-proxy-api")
    let license = payload.appendingPathComponent("CLIProxyAPI-LICENSE")
    let codexRuntime = payload.appendingPathComponent("codex")
    let codexLicense = payload.appendingPathComponent("Codex-LICENSE")
    let profilePublisher = payload.appendingPathComponent("openbot-profile-publish")
    for file in [verifier, manifest, patcher, auditor, sidecar, license, codexRuntime, codexLicense, profilePublisher] {
        try Data(file.lastPathComponent.utf8).write(to: file)
    }
    try Data(("Apache License\n" + String(repeating: "reviewed fixture\n", count: 10)).utf8).write(to: codexLicense)
    let sidecarData = try Data(contentsOf: sidecar)
    let sidecarHash = SHA256.hash(data: sidecarData).map { String(format: "%02x", $0) }.joined()
    let sidecarLicenseData = try Data(contentsOf: license)
    let sidecarLicenseHash = SHA256.hash(data: sidecarLicenseData).map { String(format: "%02x", $0) }.joined()
    let codexData = try Data(contentsOf: codexRuntime)
    let codexHash = SHA256.hash(data: codexData).map { String(format: "%02x", $0) }.joined()
    let codexLicenseData = try Data(contentsOf: codexLicense)
    let codexLicenseHash = SHA256.hash(data: codexLicenseData).map { String(format: "%02x", $0) }.joined()
    let profilePublisherData = try Data(contentsOf: profilePublisher)
    let profilePublisherHash = SHA256.hash(data: profilePublisherData).map { String(format: "%02x", $0) }.joined()
    let codexReceipt = payload.appendingPathComponent("codex-receipt.json")
    let receipt = try JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1,
        "version": "0.147.0",
        "bytes": codexData.count,
        "sha256": codexHash,
        "identity": [
            "identifier": "codex",
            "architecture": "arm64",
            "version": "0.147.0",
            "signer": "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
            "teamIdentifier": "2DC432GLL2",
            "cdHash": "95686307357ad315175f553a68dce5c62d0ff435",
            "hardenedRuntime": true,
            "timestamped": true,
        ],
    ], options: [.sortedKeys])
    try receipt.write(to: codexReceipt)
    return InstallerPaths(
        vendorApp: vendor,
        destinationApp: root.appendingPathComponent("Applications/OpenBot.app", isDirectory: true),
        workingDirectory: root.appendingPathComponent("Applications", isDirectory: true),
        verifierScript: verifier,
        vendorManifest: manifest,
        patcherScript: patcher,
        contractAuditor: auditor,
        sidecarBinary: sidecar,
        sidecarLicense: license,
        expectedSidecarBytes: sidecarData.count,
        expectedSidecarSHA256: sidecarHash,
        expectedSidecarLicenseBytes: sidecarLicenseData.count,
        expectedSidecarLicenseSHA256: sidecarLicenseHash,
        codexRuntimeBinary: codexRuntime,
        codexRuntimeReceipt: codexReceipt,
        codexRuntimeLicense: codexLicense,
        expectedCodexRuntimeBytes: codexData.count,
        expectedCodexRuntimeSHA256: codexHash,
        expectedCodexRuntimeLicenseBytes: codexLicenseData.count,
        expectedCodexRuntimeLicenseSHA256: codexLicenseHash,
        profilePublisher: profilePublisher,
        expectedProfilePublisherBytes: profilePublisherData.count,
        expectedProfilePublisherSHA256: profilePublisherHash,
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

private func expectAcquisitionFailure(
    _ expected: GrokBotAcquisitionFailure,
    _ operation: () throws -> Void
) throws {
    do {
        try operation()
        throw TestFailure.assertion("expected \(expected)")
    } catch let failure as GrokBotAcquisitionFailure {
        try expect(failure == expected, "expected \(expected), got \(failure)")
    }
}

private func plistData(_ object: Any) throws -> Data {
    try PropertyListSerialization.data(fromPropertyList: object, format: .xml, options: 0)
}

private func acquisitionSpec(bytes: Data, hash: String? = nil) -> GrokBotDownloadSpec {
    GrokBotDownloadSpec(
        sourceURL: GrokBotDownloadSpec.officialSourceURL,
        expectedBytes: bytes.count,
        expectedSHA256: hash ?? SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    )
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
        try expect(!FileManager.default.fileExists(atPath: paths.workingDirectory.path),
                   "fresh-profile working directory fixture unexpectedly exists")
        let original = try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/Resources/app.asar"))
        let originalInfo = try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/Info.plist"))
        let originalExecutable = try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/MacOS/Grok Bot"))
        let originalHelpers = try helperVariants.map { variant in
            let name = "Grok Bot Helper\(variant.suffix)"
            let helper = paths.vendorApp.appendingPathComponent("Contents/Frameworks/\(name).app", isDirectory: true)
            return (
                variant.suffix,
                try Data(contentsOf: helper.appendingPathComponent("Contents/Info.plist")),
                try Data(contentsOf: helper.appendingPathComponent("Contents/MacOS/\(name)"))
            )
        }
        let runner = RecordingRunner()
        runner.handler = { try simulatedInstallCommand($0) }
        let receipt = try InstallerTransaction(paths: paths, runner: runner).install()
        try expect(FileManager.default.fileExists(atPath: paths.workingDirectory.path),
                   "installer did not create the exact safe working-directory leaf")
        try expect(receipt.destination == paths.destinationApp, "destination mismatch")
        try expect(try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/Resources/app.asar")) == original, "vendor ASAR mutated")
        try expect(try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/Info.plist")) == originalInfo, "vendor plist mutated")
        try expect(try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/MacOS/Grok Bot")) == originalExecutable, "vendor executable mutated")
        try expect(!FileManager.default.fileExists(atPath: paths.vendorApp.appendingPathComponent("Contents/MacOS/OpenBot").path), "OpenBot executable leaked into vendor app")
        try expect(String(data: try Data(contentsOf: paths.destinationApp.appendingPathComponent("Contents/Resources/app.asar")), encoding: .utf8) == "patched-asar", "patch missing")
        try expect(FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/cliproxy/cli-proxy-api").path), "sidecar missing")
        let installedRuntime = paths.destinationApp.appendingPathComponent("Contents/Resources/codex/runtime/codex")
        try expect(FileManager.default.fileExists(atPath: installedRuntime.path), "official Codex runtime missing")
        try expect(try Data(contentsOf: installedRuntime) == Data(contentsOf: paths.codexRuntimeBinary), "official Codex runtime changed")
        try expect(FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/runtime/receipt.json").path), "official Codex receipt missing")
        try expect(FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/runtime/LICENSE").path), "official Codex license missing")
        let installedProfilePublisher = paths.destinationApp.appendingPathComponent("Contents/Resources/codex/native/openbot-profile-publish")
        try expect(FileManager.default.fileExists(atPath: installedProfilePublisher.path), "OpenBot profile publisher missing")
        try expect(try Data(contentsOf: installedProfilePublisher) == Data(contentsOf: paths.profilePublisher), "OpenBot profile publisher changed")
        let sidecarReceipt = try JSONSerialization.jsonObject(with: Data(contentsOf: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/cliproxy/receipt.json"))) as? [String: Any]
        let installedSidecarBytes = try Data(contentsOf: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/cliproxy/cli-proxy-api")).count
        try expect(sidecarReceipt?["bytes"] as? Int == installedSidecarBytes, "signed sidecar receipt bytes mismatch")
        try expect((sidecarReceipt?["sha256"] as? String)?.count == 64, "signed sidecar receipt hash missing")
        let installedInfo = try readPlist(paths.destinationApp.appendingPathComponent("Contents/Info.plist"))
        try expect(installedInfo["CFBundleIdentifier"] as? String == "com.limonlimez.openbot", "installed bundle identifier mismatch")
        try expect(installedInfo["CFBundleName"] as? String == "OpenBot", "process and menu bundle name mismatch")
        try expect(installedInfo["CFBundleDisplayName"] as? String == "OpenBot", "Finder display name mismatch")
        try expect(installedInfo["CFBundleExecutable"] as? String == "OpenBot", "root executable metadata mismatch")
        let installedExecutable = paths.destinationApp.appendingPathComponent("Contents/MacOS/OpenBot")
        try expect(FileManager.default.fileExists(atPath: installedExecutable.path), "renamed root executable missing")
        try expect(try Data(contentsOf: installedExecutable) == originalExecutable, "root executable contents changed")
        try expect(!FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/MacOS/Grok Bot").path), "vendor root executable name remained")
        for (variant, source) in zip(helperVariants, originalHelpers) {
            let vendorName = "Grok Bot Helper\(variant.suffix)"
            let openBotName = "OpenBot Helper\(variant.suffix)"
            let installedHelper = paths.destinationApp.appendingPathComponent(
                "Contents/Frameworks/\(openBotName).app", isDirectory: true
            )
            let sourceHelper = paths.vendorApp.appendingPathComponent(
                "Contents/Frameworks/\(vendorName).app", isDirectory: true
            )
            try expect(FileManager.default.fileExists(atPath: installedHelper.path), "renamed \(openBotName) bundle missing")
            try expect(!FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Frameworks/\(vendorName).app").path), "vendor \(vendorName) bundle remained")
            let helperInfo = try readPlist(installedHelper.appendingPathComponent("Contents/Info.plist"))
            try expect(helperInfo["CFBundleIdentifier"] as? String == variant.openBotIdentifier, "\(openBotName) identifier mismatch")
            try expect(helperInfo["CFBundleName"] as? String == openBotName, "\(openBotName) bundle name mismatch")
            try expect(helperInfo["CFBundleDisplayName"] as? String == openBotName, "\(openBotName) display name mismatch")
            try expect(helperInfo["CFBundleExecutable"] as? String == openBotName, "\(openBotName) executable metadata mismatch")
            let installedHelperExecutable = installedHelper.appendingPathComponent("Contents/MacOS/\(openBotName)")
            try expect(FileManager.default.fileExists(atPath: installedHelperExecutable.path), "renamed \(openBotName) executable missing")
            try expect(try Data(contentsOf: installedHelperExecutable) == source.2, "\(openBotName) executable contents changed")
            try expect(!FileManager.default.fileExists(atPath: installedHelper.appendingPathComponent("Contents/MacOS/\(vendorName)").path), "vendor \(vendorName) executable remained")
            try expect(try Data(contentsOf: sourceHelper.appendingPathComponent("Contents/Info.plist")) == source.1, "source \(vendorName) plist mutated")
            try expect(try Data(contentsOf: sourceHelper.appendingPathComponent("Contents/MacOS/\(vendorName)")) == source.2, "source \(vendorName) executable mutated")
            try expect(!FileManager.default.fileExists(atPath: paths.vendorApp.appendingPathComponent("Contents/Frameworks/\(openBotName).app").path), "renamed helper leaked into vendor app")
        }
        try expect(runner.calls.contains { $0.environment["ELECTRON_RUN_AS_NODE"] == "1" && $0.arguments.contains("--source-asar") }, "node boundary missing")
        try expect(runner.calls.filter { $0.environment["ELECTRON_RUN_AS_NODE"] == "1" }.allSatisfy { $0.environment["ELECTRON_NO_ASAR"] == "1" }, "Electron ASAR virtualization was not disabled")
        let signingCalls = runner.calls.filter {
            $0.executable.path == "/usr/bin/codesign"
                && !$0.arguments.contains("--verify")
                && !$0.arguments.contains("--display")
        }
        try expect(signingCalls.count == 7, "unexpected customer signing call count")
        try expect(signingCalls.allSatisfy {
            $0.arguments.contains("--timestamp=none") && $0.arguments.contains("-")
                && !$0.arguments.contains("--timestamp") && !$0.arguments.contains("runtime")
        }, "customer installation did not remain deliberately ad hoc")
        let helperSigningCalls = signingCalls.filter {
            $0.arguments.last.map { URL(fileURLWithPath: $0).lastPathComponent.hasPrefix("OpenBot Helper") } == true
        }
        try expect(helperSigningCalls.map { URL(fileURLWithPath: $0.arguments.last!).lastPathComponent } == helperVariants.map { "OpenBot Helper\($0.suffix).app" }, "helpers were not signed in deterministic bottom-up order")
        try expect(helperSigningCalls.allSatisfy {
            $0.arguments.contains("--preserve-metadata=flags,entitlements")
                && !$0.arguments.contains(where: { $0.contains("identifier") || $0.contains("requirements") })
        }, "helper resigning did not preserve only runtime flags and entitlements")
        let outerSigningIndex = signingCalls.firstIndex(where: {
            $0.arguments.last.map { URL(fileURLWithPath: $0).lastPathComponent == "OpenBot.app" } == true
        })
        let lastHelperIndex = helperSigningCalls.last.flatMap { helper in signingCalls.firstIndex(of: helper) }
        try expect(outerSigningIndex != nil && lastHelperIndex != nil && lastHelperIndex! < outerSigningIndex!, "outer app was signed before its helpers")
        let signatureDisplays = runner.calls.filter {
            $0.executable.path == "/usr/bin/codesign" && $0.arguments.contains("--display")
        }
        try expect(signatureDisplays.count == 4, "every helper signature was not inspected")
        try expect(signatureDisplays.allSatisfy {
            $0.arguments.contains("--entitlements") && $0.arguments.contains("--xml")
        }, "helper signature inspection omitted runtime metadata")
        try expect(runner.calls.contains {
            $0.executable.path == "/usr/bin/codesign"
                && $0.arguments.count == 4
                && Array($0.arguments.prefix(3)) == ["--verify", "--deep", "--strict"]
                && $0.arguments.last?.hasSuffix("/OpenBot.app") == true
        }, "deep strict outer verification missing")
    }

    static func testRejectsUnsafeOrUnexpectedHelperLayoutsBeforeReplacement() throws {
        let mutations: [(String, (InstallerPaths) throws -> Void)] = [
            ("missing helper", { paths in
                try FileManager.default.removeItem(
                    at: paths.vendorApp.appendingPathComponent("Contents/Frameworks/Grok Bot Helper (GPU).app")
                )
            }),
            ("symlinked helper executable", { paths in
                let executable = paths.vendorApp.appendingPathComponent(
                    "Contents/Frameworks/Grok Bot Helper (Plugin).app/Contents/MacOS/Grok Bot Helper (Plugin)"
                )
                try FileManager.default.removeItem(at: executable)
                try FileManager.default.createSymbolicLink(
                    at: executable,
                    withDestinationURL: paths.vendorApp.appendingPathComponent("Contents/MacOS/Grok Bot")
                )
            }),
            ("unexpected helper app", { paths in
                try FileManager.default.createDirectory(
                    at: paths.vendorApp.appendingPathComponent("Contents/Frameworks/Unexpected Helper.app"),
                    withIntermediateDirectories: false
                )
            }),
            ("unexpected root executable", { paths in
                try Data("unexpected".utf8).write(
                    to: paths.vendorApp.appendingPathComponent("Contents/MacOS/Unexpected")
                )
            }),
        ]

        for (label, mutate) in mutations {
            let root = try temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: root) }
            let paths = try makeFixture(at: root)
            try FileManager.default.createDirectory(at: paths.destinationApp, withIntermediateDirectories: true)
            let marker = paths.destinationApp.appendingPathComponent("marker")
            try Data("previous".utf8).write(to: marker)
            try mutate(paths)
            let runner = RecordingRunner()
            runner.handler = { try simulatedInstallCommand($0) }

            try expectInstallerFailure { _ = try InstallerTransaction(paths: paths, runner: runner).install() }
            try expect(try Data(contentsOf: marker) == Data("previous".utf8), "\(label) replaced the previous app")
            try expect(!runner.calls.contains {
                $0.executable.path == "/usr/bin/codesign"
                    && !$0.arguments.contains("--verify")
                    && !$0.arguments.contains("--display")
            }, "\(label) reached signing")
        }
    }

    static func testRejectsHelperSignatureMetadataDriftBeforeReplacement() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = try makeFixture(at: root)
        let sourceInfo = try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/Info.plist"))
        let sourceAsar = try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/Resources/app.asar"))
        try FileManager.default.createDirectory(at: paths.destinationApp, withIntermediateDirectories: true)
        let marker = paths.destinationApp.appendingPathComponent("marker")
        try Data("previous".utf8).write(to: marker)
        let runner = RecordingRunner()
        runner.handler = { try simulatedInstallCommand($0, invalidSignatureSuffix: " (Renderer)") }

        try expectInstallerFailure { _ = try InstallerTransaction(paths: paths, runner: runner).install() }
        try expect(try Data(contentsOf: marker) == Data("previous".utf8), "invalid helper signature replaced the previous app")
        try expect(try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/Info.plist")) == sourceInfo, "signature rejection mutated source plist")
        try expect(try Data(contentsOf: paths.vendorApp.appendingPathComponent("Contents/Resources/app.asar")) == sourceAsar, "signature rejection mutated source ASAR")
        try expect(!runner.calls.contains {
            $0.executable.path == "/usr/bin/codesign"
                && !$0.arguments.contains("--verify")
                && !$0.arguments.contains("--display")
                && $0.arguments.last?.hasSuffix("/OpenBot.app") == true
        }, "invalid helper signature reached outer app signing")
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

    static func testCustomerInstallRejectsDeveloperIdentityBeforeMutation() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        var paths = try makeFixture(at: root)
        paths.signingIdentity = "Developer ID Application: Example (ABCDE12345)"
        let runner = RecordingRunner()
        try expectInstallerFailure { _ = try InstallerTransaction(paths: paths, runner: runner).install() }
        try expect(runner.calls.isEmpty, "customer install attempted to use a developer private key")
        try expect(!FileManager.default.fileExists(atPath: paths.destinationApp.path), "invalid identity mutated destination")
    }

    static func testRejectsWorkingTreeInsideVendorBeforeMutation() throws {
        for useSymlinkAncestor in [false, true] {
            let root = try temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: root) }
            var paths = try makeFixture(at: root)
            let vendorContents = paths.vendorApp.appendingPathComponent("Contents", isDirectory: true)
            let working: URL
            if useSymlinkAncestor {
                let alias = root.appendingPathComponent("VendorAlias", isDirectory: true)
                try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: paths.vendorApp)
                working = alias.appendingPathComponent("Contents", isDirectory: true)
            } else {
                working = vendorContents
            }
            paths.workingDirectory = working
            paths.destinationApp = working.appendingPathComponent("OpenBot.app", isDirectory: true)
            let before = try FileManager.default.contentsOfDirectory(atPath: vendorContents.path).sorted()
            let runner = RecordingRunner()

            try expectInstallerFailure { _ = try InstallerTransaction(paths: paths, runner: runner).install() }
            try expect(runner.calls.isEmpty, "vendor-contained destination reached the process runner")
            try expect(try FileManager.default.contentsOfDirectory(atPath: vendorContents.path).sorted() == before,
                       "vendor-contained destination mutated Grok Bot")
        }
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
              let expectedSidecarSHA256 = installerInfo?["CodexBotSidecarSHA256"] as? String,
              let expectedSidecarLicenseBytes = installerInfo?["CodexBotSidecarLicenseBytes"] as? Int,
              let expectedSidecarLicenseSHA256 = installerInfo?["CodexBotSidecarLicenseSHA256"] as? String,
              let expectedCodexRuntimeBytes = installerInfo?["CodexBotCodexRuntimeBytes"] as? Int,
              let expectedCodexRuntimeSHA256 = installerInfo?["CodexBotCodexRuntimeSHA256"] as? String,
              let expectedCodexRuntimeLicenseBytes = installerInfo?["CodexBotCodexRuntimeLicenseBytes"] as? Int,
              let expectedCodexRuntimeLicenseSHA256 = installerInfo?["CodexBotCodexRuntimeLicenseSHA256"] as? String,
              let expectedProfilePublisherBytes = installerInfo?["OpenBotProfilePublisherBytes"] as? Int,
              let expectedProfilePublisherSHA256 = installerInfo?["OpenBotProfilePublisherSHA256"] as? String else {
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
            destinationApp: root.appendingPathComponent("Applications/OpenBot.app", isDirectory: true),
            workingDirectory: root.appendingPathComponent("Applications", isDirectory: true),
            verifierScript: patcher.appendingPathComponent("scripts/verify-vendor-app.cjs"),
            vendorManifest: patcher.appendingPathComponent("assets/grok-bot-0.20.0-darwin-arm64.manifest.json"),
            patcherScript: patcher.appendingPathComponent("scripts/patch-app.cjs"),
            contractAuditor: patcher.appendingPathComponent("scripts/audit-grok-contract.cjs"),
            sidecarBinary: sidecar,
            sidecarLicense: resources.appendingPathComponent("CLIProxy/LICENSE"),
            expectedSidecarBytes: expectedSidecarBytes,
            expectedSidecarSHA256: expectedSidecarSHA256,
            expectedSidecarLicenseBytes: expectedSidecarLicenseBytes,
            expectedSidecarLicenseSHA256: expectedSidecarLicenseSHA256,
            codexRuntimeBinary: resources.appendingPathComponent("CodexRuntime/codex"),
            codexRuntimeReceipt: resources.appendingPathComponent("CodexRuntime/receipt.json"),
            codexRuntimeLicense: resources.appendingPathComponent("CodexRuntime/LICENSE"),
            expectedCodexRuntimeBytes: expectedCodexRuntimeBytes,
            expectedCodexRuntimeSHA256: expectedCodexRuntimeSHA256,
            expectedCodexRuntimeLicenseBytes: expectedCodexRuntimeLicenseBytes,
            expectedCodexRuntimeLicenseSHA256: expectedCodexRuntimeLicenseSHA256,
            profilePublisher: resources.appendingPathComponent("OpenBotMigration/openbot-profile-publish"),
            expectedProfilePublisherBytes: expectedProfilePublisherBytes,
            expectedProfilePublisherSHA256: expectedProfilePublisherSHA256,
            signingIdentity: "-"
        )
        let receipt = try InstallerTransaction(paths: paths, runner: ExactIntegrationRunner()).install()
        try expect(receipt.destination == paths.destinationApp, "exact install destination mismatch")
        try expect(try fileSHA256(vendorAsar) == before, "exact vendor app was modified")
        let info = try PropertyListSerialization.propertyList(
            from: Data(contentsOf: paths.destinationApp.appendingPathComponent("Contents/Info.plist")),
            options: [], format: nil
        ) as? [String: Any]
        try expect(info?["CFBundleIdentifier"] as? String == "com.limonlimez.openbot", "installed bundle identifier mismatch")
        try expect(info?["CFBundleName"] as? String == "OpenBot", "installed bundle name mismatch")
        try expect(info?["CFBundleDisplayName"] as? String == "OpenBot", "installed display name mismatch")
        try expect(info?["CFBundleExecutable"] as? String == "OpenBot", "installed executable metadata mismatch")
        try expect(info?["CFBundleShortVersionString"] as? String == "0.2.0-macos.1", "installed version mismatch")
        try expect(FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/MacOS/OpenBot").path), "installed OpenBot executable missing")
        try expect(!FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/MacOS/Grok Bot").path), "installed vendor executable remained")
        for variant in helperVariants {
            let vendorName = "Grok Bot Helper\(variant.suffix)"
            let openBotName = "OpenBot Helper\(variant.suffix)"
            let installedHelper = paths.destinationApp.appendingPathComponent(
                "Contents/Frameworks/\(openBotName).app", isDirectory: true
            )
            try expect(FileManager.default.fileExists(atPath: installedHelper.path), "installed \(openBotName) missing")
            try expect(!FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Frameworks/\(vendorName).app").path), "installed \(vendorName) remained")
            let helperInfo = try readPlist(installedHelper.appendingPathComponent("Contents/Info.plist"))
            try expect(helperInfo["CFBundleIdentifier"] as? String == variant.openBotIdentifier, "installed \(openBotName) identifier mismatch")
            try expect(helperInfo["CFBundleName"] as? String == openBotName, "installed \(openBotName) bundle name mismatch")
            try expect(helperInfo["CFBundleDisplayName"] as? String == openBotName, "installed \(openBotName) display name mismatch")
            try expect(helperInfo["CFBundleExecutable"] as? String == openBotName, "installed \(openBotName) executable metadata mismatch")
            try expect(FileManager.default.fileExists(atPath: installedHelper.appendingPathComponent("Contents/MacOS/\(openBotName)").path), "installed \(openBotName) executable missing")
            try expect(!FileManager.default.fileExists(atPath: installedHelper.appendingPathComponent("Contents/MacOS/\(vendorName)").path), "installed \(vendorName) executable remained")
        }
        try expect(FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/cliproxy/cli-proxy-api").path), "installed pinned sidecar missing")
        try expect(FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Resources/codex/runtime/codex").path), "installed official Codex runtime missing")
        try expect(!FileManager.default.fileExists(atPath: paths.destinationApp.appendingPathComponent("Contents/Resources/.codex-vendor.asar").path), "vendor staging artifact leaked")
        print("PASS exact Grok Bot 0.20.0 integration installs an isolated verified OpenBot app")
    }

    static func testOfficialDownloadUsesPinnedCurlArgumentsAndNoShell() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let runner = RecordingRunner()
        runner.handler = { call in
            if call.executable.path == "/usr/bin/curl" {
                if let outputIndex = call.arguments.firstIndex(of: "--output") {
                    try Data().write(to: URL(fileURLWithPath: call.arguments[outputIndex + 1]))
                }
                return CommandResult(status: 0, stdout: Data(), stderr: Data())
            }
            return CommandResult(status: 0, stdout: Data(), stderr: Data())
        }
        let acquisition = GrokBotAcquisition(
            testingSpec: .exact020,
            runner: runner,
            temporaryDirectory: root
        )
        try expectAcquisitionFailure(.sizeMismatch) {
            try acquisition.withOfficialApp { _ in
                throw TestFailure.assertion("download unexpectedly reached mount")
            }
        }
        guard let curl = runner.calls.first(where: { $0.executable.path == "/usr/bin/curl" }) else {
            throw TestFailure.assertion("curl was not invoked")
        }
        try expect(curl.executable.path == "/usr/bin/curl", "download did not use system curl")
        try expect(curl.arguments.contains("--fail"), "curl fail-closed flag missing")
        try expect(curl.arguments.contains("--silent") && curl.arguments.contains("--show-error"), "curl output was not bounded")
        try expect(curl.arguments.contains("--proto") && curl.arguments.contains("=https"), "curl HTTPS-only policy missing")
        try expect(!curl.arguments.contains("--location") && !curl.arguments.contains("--proto-redir"),
                   "curl must not follow a substituted download location")
        try expect(curl.arguments.contains("--max-filesize") && curl.arguments.contains("151151794"), "curl max size was not pinned")
        try expect(curl.arguments.contains("--max-time"), "curl time bound missing")
        try expect(curl.arguments.contains(GrokBotDownloadSpec.officialSourceURL.absoluteString), "official source URL changed")
        try expect(!curl.arguments.contains("sh") && !curl.arguments.contains("-c"), "download attempted to use a shell")
        try expect(!runner.calls.contains { $0.executable.path == "/bin/sh" }, "download was routed through a shell")
    }

    static func testOfficialDownloadRejectsSizeAndHashBeforeMount() throws {
        let payload = Data("dmg".utf8)
        for spec in [
            acquisitionSpec(bytes: payload, hash: nil),
            GrokBotDownloadSpec(
                sourceURL: GrokBotDownloadSpec.officialSourceURL,
                expectedBytes: payload.count,
                expectedSHA256: String(repeating: "0", count: 64)
            )
        ] {
            let root = try temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: root) }
            let runner = RecordingRunner()
            runner.handler = { call in
                if call.executable.path == "/usr/bin/curl",
                   let outputIndex = call.arguments.firstIndex(of: "--output") {
                    try payload.write(to: URL(fileURLWithPath: call.arguments[outputIndex + 1]))
                }
                return CommandResult(status: 0, stdout: Data(), stderr: Data())
            }
            let testedSpec: GrokBotDownloadSpec
            if spec.expectedSHA256 == String(repeating: "0", count: 64) {
                testedSpec = spec
            } else {
                testedSpec = GrokBotDownloadSpec(
                    sourceURL: GrokBotDownloadSpec.officialSourceURL,
                    expectedBytes: payload.count + 1,
                    expectedSHA256: SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
                )
            }
            let acquisition = GrokBotAcquisition(testingSpec: testedSpec, runner: runner, temporaryDirectory: root)
            let expectedFailure: GrokBotAcquisitionFailure = testedSpec.expectedBytes == payload.count
                ? .hashMismatch
                : .sizeMismatch
            try expectAcquisitionFailure(expectedFailure) {
                try acquisition.withOfficialApp { _ in
                    throw TestFailure.assertion("integrity failure reached mount")
                }
            }
            try expect(!runner.calls.contains { $0.executable.path == "/usr/bin/hdiutil" && $0.arguments.first == "attach" },
                       "DMG was mounted before integrity verification")
        }
    }

    static func testOfficialDownloadRejectsHostileOrAmbiguousMountPlist() throws {
        let payload = Data("dmg".utf8)
        let cases: [(Any, GrokBotAcquisitionFailure)] = [
            (["system-entities": [["mount-point": 42]]], .invalidMount),
            (["system-entities": [["mount-point": "/tmp/one"], ["mount-point": "/tmp/two"]]], .ambiguousMount),
            (["system-entities": [["mount-point": "/tmp/one"], ["mount-point": "/tmp/one"]]], .ambiguousMount),
        ]
        for (plist, expectedFailure) in cases {
            let root = try temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: root) }
            let runner = RecordingRunner()
            runner.handler = { call in
                if call.executable.path == "/usr/bin/curl",
                   let outputIndex = call.arguments.firstIndex(of: "--output") {
                    try payload.write(to: URL(fileURLWithPath: call.arguments[outputIndex + 1]))
                }
                if call.executable.path == "/usr/bin/hdiutil", call.arguments.first == "attach" {
                    return CommandResult(status: 0, stdout: try plistData(plist), stderr: Data())
                }
                return CommandResult(status: 0, stdout: Data(), stderr: Data())
            }
            let acquisition = GrokBotAcquisition(
                testingSpec: acquisitionSpec(bytes: payload),
                runner: runner,
                temporaryDirectory: root
            )
            try expectAcquisitionFailure(expectedFailure) {
                try acquisition.withOfficialApp { _ in
                    throw TestFailure.assertion("ambiguous mount unexpectedly resolved")
                }
            }
        }
    }

    static func testOfficialDownloadDetachesAndCleansPrivateWorkDirectory() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data("dmg".utf8)
        let runner = RecordingRunner()
        var expectedMount: URL?
        runner.handler = { call in
            if call.executable.path == "/usr/bin/curl",
               let outputIndex = call.arguments.firstIndex(of: "--output") {
                try payload.write(to: URL(fileURLWithPath: call.arguments[outputIndex + 1]))
            }
            if call.executable.path == "/usr/bin/hdiutil", call.arguments.first == "attach" {
                guard let mountIndex = call.arguments.firstIndex(of: "-mountpoint") else {
                    throw TestFailure.assertion("owned mountpoint was not requested")
                }
                let mount = URL(fileURLWithPath: call.arguments[mountIndex + 1], isDirectory: true)
                expectedMount = mount
                try FileManager.default.createDirectory(
                    at: mount.appendingPathComponent("Grok Bot.app", isDirectory: true),
                    withIntermediateDirectories: true
                )
                return CommandResult(
                    status: 0,
                    stdout: try plistData(["system-entities": [[
                        "mount-point": mount.path.hasPrefix("/var/")
                            ? "/private\(mount.path)"
                            : mount.path,
                    ]]]),
                    stderr: Data()
                )
            }
            return CommandResult(status: 0, stdout: Data(), stderr: Data())
        }
        let acquisition = GrokBotAcquisition(
            testingSpec: acquisitionSpec(bytes: payload),
            runner: runner,
            temporaryDirectory: root
        )
        let returned = try acquisition.withOfficialApp { app in
            try expect(app.lastPathComponent == "Grok Bot.app", "mounted app identity mismatch")
            return app
        }
        guard let mount = expectedMount else {
            throw TestFailure.assertion("owned mountpoint was not captured")
        }
        try expect(returned.path == mount.appendingPathComponent("Grok Bot.app").path, "mounted app path mismatch")
        guard let detach = runner.calls.first(where: { $0.executable.path == "/usr/bin/hdiutil" && $0.arguments.first == "detach" }) else {
            throw TestFailure.assertion("mounted volume was not detached")
        }
        guard let verify = runner.calls.first(where: { $0.executable.path == "/usr/bin/hdiutil" && $0.arguments.first == "verify" }),
              let attach = runner.calls.first(where: { $0.executable.path == "/usr/bin/hdiutil" && $0.arguments.first == "attach" }) else {
            throw TestFailure.assertion("DMG verify or attach was not invoked")
        }
        try expect(runner.calls.firstIndex(of: verify)! < runner.calls.firstIndex(of: attach)!,
                   "DMG was attached before hdiutil verification")
        for flag in ["-readonly", "-nobrowse", "-noautoopen", "-mountpoint", "-plist"] {
            try expect(attach.arguments.contains(flag), "safe attach flag \(flag) missing")
        }
        try expect(detach.arguments.contains(mount.path), "detach targeted a different volume")
        try expect(!FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasPrefix("openbot-grok-bot-") },
                   "private download directory leaked")
    }

    static func testOfficialDownloadSurfacesDetachFailure() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data("dmg".utf8)
        let runner = RecordingRunner()
        runner.handler = { call in
            if call.executable.path == "/usr/bin/curl",
               let outputIndex = call.arguments.firstIndex(of: "--output") {
                try payload.write(to: URL(fileURLWithPath: call.arguments[outputIndex + 1]))
            }
            if call.executable.path == "/usr/bin/hdiutil", call.arguments.first == "attach",
               let mountIndex = call.arguments.firstIndex(of: "-mountpoint") {
                let mount = URL(fileURLWithPath: call.arguments[mountIndex + 1], isDirectory: true)
                try FileManager.default.createDirectory(
                    at: mount.appendingPathComponent("Grok Bot.app", isDirectory: true),
                    withIntermediateDirectories: true
                )
                return CommandResult(
                    status: 0,
                    stdout: try plistData(["system-entities": [["mount-point": mount.path]]]),
                    stderr: Data()
                )
            }
            if call.executable.path == "/usr/bin/hdiutil", call.arguments.first == "detach" {
                return CommandResult(status: 1, stdout: Data(), stderr: Data("busy".utf8))
            }
            return CommandResult(status: 0, stdout: Data(), stderr: Data())
        }
        let acquisition = GrokBotAcquisition(
            testingSpec: acquisitionSpec(bytes: payload),
            runner: runner,
            temporaryDirectory: root
        )
        try expectAcquisitionFailure(.cleanupFailed) {
            let _: Bool = try acquisition.withOfficialApp { _ in true }
        }
        try expect(runner.calls.filter { $0.executable.path == "/usr/bin/hdiutil" && $0.arguments.first == "detach" }.count == 2,
                   "detach did not retry with force after normal detach failed")
        try expect(!FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasPrefix("openbot-grok-bot-") },
                   "cleanup failure left the private download directory behind")
    }

    static func testOfficialDownloadSurfacesPreMountCleanupFailure() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let runner = RecordingRunner()
        runner.handler = { call in
            if call.executable.path == "/usr/bin/curl",
               let outputIndex = call.arguments.firstIndex(of: "--output") {
                try Data().write(to: URL(fileURLWithPath: call.arguments[outputIndex + 1]))
            }
            return CommandResult(status: 0, stdout: Data(), stderr: Data())
        }
        let acquisition = GrokBotAcquisition(
            testingSpec: .exact020,
            runner: runner,
            fileManager: CleanupFailingFileManager(),
            temporaryDirectory: root
        )
        try expectAcquisitionFailure(.cleanupFailed) {
            try acquisition.withOfficialApp { _ in
                throw TestFailure.assertion("invalid download unexpectedly mounted")
            }
        }
        try expect(!runner.calls.contains { $0.executable.path == "/usr/bin/hdiutil" },
                   "invalid download reached image verification")
    }

    static func testLiveOfficialDownloadIfRequested() throws {
        guard ProcessInfo.processInfo.environment["OPENBOT_TEST_LIVE_VENDOR_DOWNLOAD"] == "1" else {
            return
        }
        let acquisition = GrokBotAcquisition(runner: ProcessCommandRunner())
        try acquisition.withOfficialApp { app in
            let info = try readPlist(app.appendingPathComponent("Contents/Info.plist"))
            try expect(info["CFBundleIdentifier"] as? String == "com.anysphere.sand",
                       "downloaded source bundle identifier mismatch")
            try expect(info["CFBundleShortVersionString"] as? String == "0.20.0",
                       "downloaded source version mismatch")
            let asar = app.appendingPathComponent("Contents/Resources/app.asar")
            try expect(fileSHA256(asar) == "1e41f9da52be5d2ff24892b150a74d3d0145659cf6cbd83e9476d025865fb997",
                       "downloaded source ASAR mismatch")
        }
        print("PASS live official Grok Bot download mounts the exact verified 0.20.0 source")
    }

    static func main() throws {
        try testInstallsTransactionally()
        print("PASS installer copies and patches a separate app without modifying Grok Bot")
        try testRejectsUnsafeOrUnexpectedHelperLayoutsBeforeReplacement()
        print("PASS installer rejects unsafe, missing, and unexpected vendor helper layouts before replacement")
        try testRejectsHelperSignatureMetadataDriftBeforeReplacement()
        print("PASS installer rejects helper runtime-signature drift before replacement")
        try testRejectsUnsafeVendor()
        print("PASS installer rejects symlinked vendor input before mutation")
        try testRestoresPreviousApp()
        print("PASS failed installation preserves the exact previous OpenBot app")
        try testCustomerInstallRejectsDeveloperIdentityBeforeMutation()
        print("PASS customer installation cannot request a developer private key")
        try testRejectsWorkingTreeInsideVendorBeforeMutation()
        print("PASS installer rejects direct and symlink-resolved work trees inside Grok Bot")
        try testExactVendorIntegrationIfRequested()
        try testOfficialDownloadUsesPinnedCurlArgumentsAndNoShell()
        print("PASS official Grok Bot download uses pinned HTTPS curl policy")
        try testOfficialDownloadRejectsSizeAndHashBeforeMount()
        print("PASS official Grok Bot download verifies size and hash before mounting")
        try testOfficialDownloadRejectsHostileOrAmbiguousMountPlist()
        print("PASS official Grok Bot mount parser rejects hostile and ambiguous plist output")
        try testOfficialDownloadDetachesAndCleansPrivateWorkDirectory()
        print("PASS official Grok Bot download detaches and cleans its private work directory")
        try testOfficialDownloadSurfacesDetachFailure()
        print("PASS official Grok Bot download surfaces detach failure and retries force")
        try testOfficialDownloadSurfacesPreMountCleanupFailure()
        print("PASS official Grok Bot download surfaces pre-mount cleanup failure")
        try testLiveOfficialDownloadIfRequested()
    }
}
