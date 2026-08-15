import Darwin
import CryptoKit
import Foundation

public enum InstallerFailure: Error, Equatable {
    case invalidInput
    case unsafePath
    case alreadyRunning
    case commandFailed
    case transactionFailed
}

public struct CommandCall: Equatable, Sendable {
    public var executable: URL
    public var arguments: [String]
    public var environment: [String: String]

    public init(executable: URL, arguments: [String], environment: [String: String] = [:]) {
        self.executable = executable
        self.arguments = arguments
        self.environment = environment
    }
}

public struct CommandResult: Equatable, Sendable {
    public var status: Int32
    public var stdout: Data
    public var stderr: Data

    public init(status: Int32, stdout: Data, stderr: Data) {
        self.status = status
        self.stdout = stdout
        self.stderr = stderr
    }
}

public protocol CommandRunning: Sendable {
    func run(_ call: CommandCall) throws -> CommandResult
}

private final class BoundedOutput: @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Int
    private var data = Data()
    private(set) var exceeded = false

    init(limit: Int) { self.limit = limit }

    func append(_ chunk: Data) {
        lock.lock()
        defer { lock.unlock() }
        if data.count < limit + 1 {
            data.append(chunk.prefix(limit + 1 - data.count))
        }
        if chunk.count > 0, data.count > limit { exceeded = true }
    }

    func snapshot() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return data.prefix(limit)
    }
}

public final class ProcessCommandRunner: CommandRunning, @unchecked Sendable {
    private let outputLimit: Int

    public init(outputLimit: Int = 1_048_576) {
        self.outputLimit = max(1, outputLimit)
    }

    public func run(_ call: CommandCall) throws -> CommandResult {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = call.executable
        process.arguments = call.arguments
        process.environment = [
            "LANG": "C",
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": NSTemporaryDirectory(),
        ].merging(call.environment) { _, supplied in supplied }
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdout
        process.standardError = stderr
        let out = BoundedOutput(limit: outputLimit)
        let err = BoundedOutput(limit: outputLimit)
        stdout.fileHandleForReading.readabilityHandler = { out.append($0.availableData) }
        stderr.fileHandleForReading.readabilityHandler = { err.append($0.availableData) }
        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            throw InstallerFailure.commandFailed
        }
        process.waitUntilExit()
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        out.append(stdout.fileHandleForReading.readDataToEndOfFile())
        err.append(stderr.fileHandleForReading.readDataToEndOfFile())
        if out.exceeded || err.exceeded {
            throw InstallerFailure.commandFailed
        }
        return CommandResult(
            status: process.terminationStatus,
            stdout: out.snapshot(),
            stderr: err.snapshot()
        )
    }
}

public struct InstallerPaths: Sendable {
    public var vendorApp: URL
    public var destinationApp: URL
    public var workingDirectory: URL
    public var verifierScript: URL
    public var vendorManifest: URL
    public var patcherScript: URL
    public var contractAuditor: URL
    public var sidecarBinary: URL
    public var sidecarLicense: URL
    public var expectedSidecarBytes: Int
    public var expectedSidecarSHA256: String
    public var expectedSidecarLicenseBytes: Int
    public var expectedSidecarLicenseSHA256: String
    public var codexRuntimeBinary: URL
    public var codexRuntimeReceipt: URL
    public var codexRuntimeLicense: URL
    public var expectedCodexRuntimeBytes: Int
    public var expectedCodexRuntimeSHA256: String
    public var expectedCodexRuntimeLicenseBytes: Int
    public var expectedCodexRuntimeLicenseSHA256: String
    public var profilePublisher: URL
    public var expectedProfilePublisherBytes: Int
    public var expectedProfilePublisherSHA256: String
    public var signingIdentity: String

    public init(
        vendorApp: URL,
        destinationApp: URL,
        workingDirectory: URL,
        verifierScript: URL,
        vendorManifest: URL,
        patcherScript: URL,
        contractAuditor: URL,
        sidecarBinary: URL,
        sidecarLicense: URL,
        expectedSidecarBytes: Int,
        expectedSidecarSHA256: String,
        expectedSidecarLicenseBytes: Int,
        expectedSidecarLicenseSHA256: String,
        codexRuntimeBinary: URL,
        codexRuntimeReceipt: URL,
        codexRuntimeLicense: URL,
        expectedCodexRuntimeBytes: Int,
        expectedCodexRuntimeSHA256: String,
        expectedCodexRuntimeLicenseBytes: Int,
        expectedCodexRuntimeLicenseSHA256: String,
        profilePublisher: URL,
        expectedProfilePublisherBytes: Int,
        expectedProfilePublisherSHA256: String,
        signingIdentity: String
    ) {
        self.vendorApp = vendorApp
        self.destinationApp = destinationApp
        self.workingDirectory = workingDirectory
        self.verifierScript = verifierScript
        self.vendorManifest = vendorManifest
        self.patcherScript = patcherScript
        self.contractAuditor = contractAuditor
        self.sidecarBinary = sidecarBinary
        self.sidecarLicense = sidecarLicense
        self.expectedSidecarBytes = expectedSidecarBytes
        self.expectedSidecarSHA256 = expectedSidecarSHA256
        self.expectedSidecarLicenseBytes = expectedSidecarLicenseBytes
        self.expectedSidecarLicenseSHA256 = expectedSidecarLicenseSHA256
        self.codexRuntimeBinary = codexRuntimeBinary
        self.codexRuntimeReceipt = codexRuntimeReceipt
        self.codexRuntimeLicense = codexRuntimeLicense
        self.expectedCodexRuntimeBytes = expectedCodexRuntimeBytes
        self.expectedCodexRuntimeSHA256 = expectedCodexRuntimeSHA256
        self.expectedCodexRuntimeLicenseBytes = expectedCodexRuntimeLicenseBytes
        self.expectedCodexRuntimeLicenseSHA256 = expectedCodexRuntimeLicenseSHA256
        self.profilePublisher = profilePublisher
        self.expectedProfilePublisherBytes = expectedProfilePublisherBytes
        self.expectedProfilePublisherSHA256 = expectedProfilePublisherSHA256
        self.signingIdentity = signingIdentity
    }
}

public struct InstallerReceipt: Equatable, Sendable {
    public var destination: URL
    public var replacedPrevious: Bool

    public init(destination: URL, replacedPrevious: Bool) {
        self.destination = destination
        self.replacedPrevious = replacedPrevious
    }
}

private func realItem(_ url: URL, directory: Bool) throws {
    guard url.isFileURL, url.path.hasPrefix("/") else { throw InstallerFailure.unsafePath }
    let values: URLResourceValues
    do {
        values = try url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
    } catch {
        throw InstallerFailure.invalidInput
    }
    if values.isSymbolicLink == true { throw InstallerFailure.unsafePath }
    if directory ? values.isDirectory != true : values.isRegularFile != true {
        throw InstallerFailure.invalidInput
    }
}

private func checked(_ runner: CommandRunning, _ call: CommandCall) throws {
    let result = try runner.run(call)
    guard result.status == 0 else { throw InstallerFailure.commandFailed }
}

private func canonicalRealDirectory(_ url: URL) throws -> URL {
    try realItem(url, directory: true)
    return url.resolvingSymlinksInPath().standardizedFileURL
}

private func isSameOrDescendant(_ candidate: URL, of directory: URL) -> Bool {
    let candidatePath = candidate.standardizedFileURL.path
    let directoryPath = directory.standardizedFileURL.path
    return candidatePath == directoryPath || candidatePath.hasPrefix(directoryPath + "/")
}

private func pathEntryExists(_ url: URL) throws -> Bool {
    var information = stat()
    let status = url.path.withCString { lstat($0, &information) }
    if status == 0 { return true }
    if errno == ENOENT { return false }
    throw InstallerFailure.unsafePath
}

public final class InstallerTransaction: @unchecked Sendable {
    private let paths: InstallerPaths
    private let runner: CommandRunning
    private let files: FileManager

    public init(paths: InstallerPaths, runner: CommandRunning, fileManager: FileManager = .default) {
        self.paths = paths
        self.runner = runner
        self.files = fileManager
    }

    public func install() throws -> InstallerReceipt {
        try validateInputs()
        try realItem(paths.workingDirectory, directory: true)
        let lockURL = paths.workingDirectory.appendingPathComponent(".codex-bot-installer.lock")
        let lock = open(lockURL.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard lock >= 0 else {
            if errno == EEXIST { throw InstallerFailure.alreadyRunning }
            throw InstallerFailure.transactionFailed
        }
        close(lock)
        defer { try? files.removeItem(at: lockURL) }

        let token = UUID().uuidString.lowercased()
        let stageRoot = paths.workingDirectory.appendingPathComponent(".codex-bot-stage-\(token)", isDirectory: true)
        let stagedApp = stageRoot.appendingPathComponent("OpenBot.app", isDirectory: true)
        let backup = paths.workingDirectory.appendingPathComponent(".codex-bot-backup-\(token).app", isDirectory: true)
        var movedPrevious = false
        var installed = false
        defer {
            if !installed, movedPrevious, !files.fileExists(atPath: paths.destinationApp.path),
               files.fileExists(atPath: backup.path) {
                try? files.moveItem(at: backup, to: paths.destinationApp)
            }
            try? files.removeItem(at: stageRoot)
            if installed { try? files.removeItem(at: backup) }
        }

        do {
            let vendorExecutable = paths.vendorApp.appendingPathComponent("Contents/MacOS/Grok Bot")
            try realItem(vendorExecutable, directory: false)
            try checked(runner, CommandCall(
                executable: vendorExecutable,
                arguments: [
                    paths.verifierScript.path,
                    "--app", paths.vendorApp.path,
                    "--manifest", paths.vendorManifest.path,
                ],
                environment: ["ELECTRON_RUN_AS_NODE": "1", "ELECTRON_NO_ASAR": "1"]
            ))
            try files.createDirectory(at: stageRoot, withIntermediateDirectories: false)
            try files.copyItem(at: paths.vendorApp, to: stagedApp)
            try patch(stagedApp: stagedApp, nodeExecutable: vendorExecutable)
            try signAndVerify(stagedApp: stagedApp)

            try files.createDirectory(
                at: paths.destinationApp.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if files.fileExists(atPath: paths.destinationApp.path) {
                try realItem(paths.destinationApp, directory: true)
                try files.moveItem(at: paths.destinationApp, to: backup)
                movedPrevious = true
            }
            do {
                try files.moveItem(at: stagedApp, to: paths.destinationApp)
                installed = true
            } catch {
                if movedPrevious, files.fileExists(atPath: backup.path) {
                    try? files.moveItem(at: backup, to: paths.destinationApp)
                    movedPrevious = false
                }
                throw InstallerFailure.transactionFailed
            }
            return InstallerReceipt(destination: paths.destinationApp, replacedPrevious: movedPrevious)
        } catch let failure as InstallerFailure {
            throw failure
        } catch {
            throw InstallerFailure.transactionFailed
        }
    }

    private func validateInputs() throws {
        try realItem(paths.vendorApp, directory: true)
        try realItem(paths.verifierScript, directory: false)
        try realItem(paths.vendorManifest, directory: false)
        try realItem(paths.patcherScript, directory: false)
        try realItem(paths.contractAuditor, directory: false)
        try realItem(paths.sidecarBinary, directory: false)
        try realItem(paths.sidecarLicense, directory: false)
        try realItem(paths.codexRuntimeBinary, directory: false)
        try realItem(paths.codexRuntimeReceipt, directory: false)
        try realItem(paths.codexRuntimeLicense, directory: false)
        try realItem(paths.profilePublisher, directory: false)
        let canonicalVendor = try canonicalRealDirectory(paths.vendorApp)
        let expectedDestination = paths.workingDirectory
            .appendingPathComponent("OpenBot.app", isDirectory: true)
            .standardizedFileURL
        guard paths.workingDirectory.isFileURL,
              !paths.workingDirectory.lastPathComponent.isEmpty,
              paths.destinationApp.isFileURL,
              paths.destinationApp.lastPathComponent == "OpenBot.app",
              paths.destinationApp.standardizedFileURL == expectedDestination,
              paths.destinationApp.standardizedFileURL != paths.vendorApp.standardizedFileURL,
              paths.signingIdentity == "-",
              paths.expectedSidecarBytes > 0,
              paths.expectedSidecarSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              paths.expectedSidecarLicenseBytes > 0,
              paths.expectedSidecarLicenseSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              paths.expectedCodexRuntimeBytes > 0,
              paths.expectedCodexRuntimeSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              paths.expectedCodexRuntimeLicenseBytes > 0,
              paths.expectedCodexRuntimeLicenseSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              paths.expectedProfilePublisherBytes > 0,
              paths.expectedProfilePublisherSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        else { throw InstallerFailure.unsafePath }
        let sidecar = try Data(contentsOf: paths.sidecarBinary, options: .mappedIfSafe)
        let digest = SHA256.hash(data: sidecar).map { String(format: "%02x", $0) }.joined()
        guard sidecar.count == paths.expectedSidecarBytes, digest == paths.expectedSidecarSHA256 else {
            throw InstallerFailure.invalidInput
        }
        let sidecarLicense = try Data(contentsOf: paths.sidecarLicense, options: .mappedIfSafe)
        let sidecarLicenseDigest = SHA256.hash(data: sidecarLicense).map { String(format: "%02x", $0) }.joined()
        guard sidecarLicense.count == paths.expectedSidecarLicenseBytes,
              sidecarLicenseDigest == paths.expectedSidecarLicenseSHA256 else {
            throw InstallerFailure.invalidInput
        }
        let runtime = try Data(contentsOf: paths.codexRuntimeBinary, options: .mappedIfSafe)
        let runtimeDigest = SHA256.hash(data: runtime).map { String(format: "%02x", $0) }.joined()
        guard runtime.count == paths.expectedCodexRuntimeBytes,
              runtimeDigest == paths.expectedCodexRuntimeSHA256 else {
            throw InstallerFailure.invalidInput
        }
        let receiptData = try Data(contentsOf: paths.codexRuntimeReceipt)
        guard receiptData.count >= 100, receiptData.count <= 2_048,
              let receipt = try JSONSerialization.jsonObject(with: receiptData) as? [String: Any],
              Set(receipt.keys) == Set(["schemaVersion", "version", "bytes", "sha256", "identity"]),
              receipt["schemaVersion"] as? Int == 1,
              receipt["version"] as? String == "0.147.0",
              receipt["bytes"] as? Int == paths.expectedCodexRuntimeBytes,
              receipt["sha256"] as? String == paths.expectedCodexRuntimeSHA256,
              let identity = receipt["identity"] as? [String: Any],
              Set(identity.keys) == Set([
                "identifier", "architecture", "version", "signer", "teamIdentifier",
                "cdHash", "hardenedRuntime", "timestamped",
              ]),
              identity["identifier"] as? String == "codex",
              identity["architecture"] as? String == "arm64",
              identity["version"] as? String == "0.147.0",
              identity["signer"] as? String == "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
              identity["teamIdentifier"] as? String == "2DC432GLL2",
              identity["cdHash"] as? String == "95686307357ad315175f553a68dce5c62d0ff435",
              identity["hardenedRuntime"] as? Bool == true,
              identity["timestamped"] as? Bool == true else {
            throw InstallerFailure.invalidInput
        }
        let runtimeLicense = try Data(contentsOf: paths.codexRuntimeLicense, options: .mappedIfSafe)
        let runtimeLicenseDigest = SHA256.hash(data: runtimeLicense).map { String(format: "%02x", $0) }.joined()
        guard runtimeLicense.count == paths.expectedCodexRuntimeLicenseBytes,
              runtimeLicenseDigest == paths.expectedCodexRuntimeLicenseSHA256 else {
            throw InstallerFailure.invalidInput
        }
        let profilePublisher = try Data(contentsOf: paths.profilePublisher, options: .mappedIfSafe)
        let profilePublisherDigest = SHA256.hash(data: profilePublisher).map { String(format: "%02x", $0) }.joined()
        guard profilePublisher.count == paths.expectedProfilePublisherBytes,
              profilePublisherDigest == paths.expectedProfilePublisherSHA256 else {
            throw InstallerFailure.invalidInput
        }
        try prepareWorkingDirectory(canonicalVendor: canonicalVendor)
    }

    private func prepareWorkingDirectory(canonicalVendor: URL) throws {
        if try pathEntryExists(paths.workingDirectory) {
            let canonicalWorking = try canonicalRealDirectory(paths.workingDirectory)
            guard !isSameOrDescendant(canonicalWorking, of: canonicalVendor) else {
                throw InstallerFailure.unsafePath
            }
            return
        }

        let requestedParent = paths.workingDirectory.deletingLastPathComponent()
        let canonicalParent = try canonicalRealDirectory(requestedParent)
        guard !isSameOrDescendant(canonicalParent, of: canonicalVendor) else {
            throw InstallerFailure.unsafePath
        }
        let parentDescriptor = open(canonicalParent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard parentDescriptor >= 0 else { throw InstallerFailure.unsafePath }
        var created = false
        var accepted = false
        defer {
            if created && !accepted {
                _ = paths.workingDirectory.lastPathComponent.withCString {
                    unlinkat(parentDescriptor, $0, AT_REMOVEDIR)
                }
            }
            close(parentDescriptor)
        }
        let createdStatus = paths.workingDirectory.lastPathComponent.withCString {
            mkdirat(parentDescriptor, $0, S_IRWXU)
        }
        guard createdStatus == 0 else { throw InstallerFailure.transactionFailed }
        created = true
        let canonicalWorking = try canonicalRealDirectory(paths.workingDirectory)
        guard !isSameOrDescendant(canonicalWorking, of: canonicalVendor) else {
            throw InstallerFailure.unsafePath
        }
        accepted = true
    }

    private func patch(stagedApp: URL, nodeExecutable: URL) throws {
        let resources = stagedApp.appendingPathComponent("Contents/Resources", isDirectory: true)
        let targetAsar = resources.appendingPathComponent("app.asar")
        let sourceAsar = resources.appendingPathComponent(".codex-vendor.asar")
        try realItem(targetAsar, directory: false)
        try files.moveItem(at: targetAsar, to: sourceAsar)
        let targetUnpacked = resources.appendingPathComponent("app.asar.unpacked", isDirectory: true)
        let sourceUnpacked = resources.appendingPathComponent(".codex-vendor.asar.unpacked", isDirectory: true)
        if files.fileExists(atPath: targetUnpacked.path) {
            try files.moveItem(at: targetUnpacked, to: sourceUnpacked)
        }
        defer {
            try? files.removeItem(at: sourceAsar)
            try? files.removeItem(at: sourceUnpacked)
        }
        try checked(runner, CommandCall(
            executable: nodeExecutable,
            arguments: [
                paths.patcherScript.path,
                "--source-asar", sourceAsar.path,
                "--target-asar", targetAsar.path,
            ],
            environment: ["ELECTRON_RUN_AS_NODE": "1", "ELECTRON_NO_ASAR": "1"]
        ))
        try realItem(targetAsar, directory: false)
        try checked(runner, CommandCall(
            executable: nodeExecutable,
            arguments: [paths.contractAuditor.path, "--asar", targetAsar.path],
            environment: ["ELECTRON_RUN_AS_NODE": "1", "ELECTRON_NO_ASAR": "1"]
        ))

        let sidecarRoot = resources.appendingPathComponent("codex/cliproxy", isDirectory: true)
        try files.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)
        let installedSidecar = sidecarRoot.appendingPathComponent("cli-proxy-api")
        let installedLicense = sidecarRoot.appendingPathComponent("LICENSE")
        try files.copyItem(at: paths.sidecarBinary, to: installedSidecar)
        try files.copyItem(at: paths.sidecarLicense, to: installedLicense)
        try files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: installedSidecar.path)
        try files.setAttributes([.posixPermissions: 0o644], ofItemAtPath: installedLicense.path)

        let runtimeRoot = resources.appendingPathComponent("codex/runtime", isDirectory: true)
        try files.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
        let installedRuntime = runtimeRoot.appendingPathComponent("codex")
        let installedRuntimeReceipt = runtimeRoot.appendingPathComponent("receipt.json")
        let installedRuntimeLicense = runtimeRoot.appendingPathComponent("LICENSE")
        try files.copyItem(at: paths.codexRuntimeBinary, to: installedRuntime)
        try files.copyItem(at: paths.codexRuntimeReceipt, to: installedRuntimeReceipt)
        try files.copyItem(at: paths.codexRuntimeLicense, to: installedRuntimeLicense)
        try files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: installedRuntime.path)
        try files.setAttributes([.posixPermissions: 0o644], ofItemAtPath: installedRuntimeReceipt.path)
        try files.setAttributes([.posixPermissions: 0o644], ofItemAtPath: installedRuntimeLicense.path)

        let nativeRoot = resources.appendingPathComponent("codex/native", isDirectory: true)
        try files.createDirectory(at: nativeRoot, withIntermediateDirectories: true)
        let installedProfilePublisher = nativeRoot.appendingPathComponent("openbot-profile-publish")
        try files.copyItem(at: paths.profilePublisher, to: installedProfilePublisher)
        try files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: installedProfilePublisher.path)
    }

    private func updatePlist(stagedApp: URL, sidecarBytes: Int, sidecarSHA256: String) throws {
        let plistURL = stagedApp.appendingPathComponent("Contents/Info.plist")
        try realItem(plistURL, directory: false)
        guard var plist = try PropertyListSerialization.propertyList(
            from: Data(contentsOf: plistURL), options: [], format: nil
        ) as? [String: Any] else { throw InstallerFailure.invalidInput }
        plist["CFBundleIdentifier"] = "com.limonlimez.openbot"
        plist["CFBundleDisplayName"] = "OpenBot"
        plist["CFBundleShortVersionString"] = "0.2.0-macos.1"
        plist["CFBundleVersion"] = "0.2.0.1"
        plist["CodexBotSidecarBytes"] = sidecarBytes
        plist["CodexBotSidecarSHA256"] = sidecarSHA256
        plist["CodexBotCodexRuntimeBytes"] = paths.expectedCodexRuntimeBytes
        plist["CodexBotCodexRuntimeSHA256"] = paths.expectedCodexRuntimeSHA256
        plist["OpenBotProfilePublisherBytes"] = paths.expectedProfilePublisherBytes
        plist["OpenBotProfilePublisherSHA256"] = paths.expectedProfilePublisherSHA256
        plist["SUFeedURL"] = nil
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .binary, options: 0)
        try data.write(to: plistURL, options: .atomic)
    }

    private func signAndVerify(stagedApp: URL) throws {
        let profilePublisher = stagedApp.appendingPathComponent("Contents/Resources/codex/native/openbot-profile-publish")
        try checked(runner, CommandCall(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: signingArguments(for: profilePublisher)
        ))
        let sidecar = stagedApp.appendingPathComponent("Contents/Resources/codex/cliproxy/cli-proxy-api")
        try checked(runner, CommandCall(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: signingArguments(for: sidecar)
        ))
        let sidecarData = try Data(contentsOf: sidecar, options: .mappedIfSafe)
        let sidecarSHA256 = SHA256.hash(data: sidecarData).map { String(format: "%02x", $0) }.joined()
        let receipt = try JSONSerialization.data(
            withJSONObject: ["bytes": sidecarData.count, "sha256": sidecarSHA256],
            options: [.sortedKeys]
        )
        let receiptURL = sidecar.deletingLastPathComponent().appendingPathComponent("receipt.json")
        try receipt.write(to: receiptURL, options: .atomic)
        try files.setAttributes([.posixPermissions: 0o644], ofItemAtPath: receiptURL.path)
        try updatePlist(stagedApp: stagedApp, sidecarBytes: sidecarData.count, sidecarSHA256: sidecarSHA256)
        try checked(runner, CommandCall(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: signingArguments(for: stagedApp)
        ))
        try checked(runner, CommandCall(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: ["--verify", "--deep", "--strict", stagedApp.path]
        ))
    }

    private func signingArguments(for target: URL) -> [String] {
        ["--force", "--timestamp=none", "--sign", "-", target.path]
    }
}
