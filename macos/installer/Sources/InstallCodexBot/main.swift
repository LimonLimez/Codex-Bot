import AppKit
import Foundation
import InstallerCore
import SwiftUI

private enum VendorSourceChoice: Equatable, Sendable {
    case none
    case existing(URL)
    case officialDownload
}

private enum InstallOutcome: Sendable {
    case succeeded(downloaded: Bool)
    case failed
    case failedWithCleanupWarning
    case installedWithCleanupWarning
}

private struct InstallerMetadata: Sendable {
    let sidecarBytes: Int
    let sidecarSHA256: String
    let sidecarLicenseBytes: Int
    let sidecarLicenseSHA256: String
    let codexRuntimeBytes: Int
    let codexRuntimeSHA256: String
    let codexRuntimeLicenseBytes: Int
    let codexRuntimeLicenseSHA256: String
    let profilePublisherBytes: Int
    let profilePublisherSHA256: String
}

private func makeInstallerPaths(
    vendorApp: URL,
    destinationDirectory: URL,
    resources: URL,
    metadata: InstallerMetadata
) -> InstallerPaths {
    let payload = resources.appendingPathComponent("Patcher", isDirectory: true)
    return InstallerPaths(
        vendorApp: vendorApp,
        destinationApp: destinationDirectory.appendingPathComponent("OpenBot.app", isDirectory: true),
        workingDirectory: destinationDirectory,
        verifierScript: payload.appendingPathComponent("scripts/verify-vendor-app.cjs"),
        vendorManifest: payload.appendingPathComponent("assets/grok-bot-0.20.0-darwin-arm64.manifest.json"),
        patcherScript: payload.appendingPathComponent("scripts/patch-app.cjs"),
        contractAuditor: payload.appendingPathComponent("scripts/audit-grok-contract.cjs"),
        sidecarBinary: resources.appendingPathComponent("CLIProxy/cli-proxy-api"),
        sidecarLicense: resources.appendingPathComponent("CLIProxy/LICENSE"),
        expectedSidecarBytes: metadata.sidecarBytes,
        expectedSidecarSHA256: metadata.sidecarSHA256,
        expectedSidecarLicenseBytes: metadata.sidecarLicenseBytes,
        expectedSidecarLicenseSHA256: metadata.sidecarLicenseSHA256,
        codexRuntimeBinary: resources.appendingPathComponent("CodexRuntime/codex"),
        codexRuntimeReceipt: resources.appendingPathComponent("CodexRuntime/receipt.json"),
        codexRuntimeLicense: resources.appendingPathComponent("CodexRuntime/LICENSE"),
        expectedCodexRuntimeBytes: metadata.codexRuntimeBytes,
        expectedCodexRuntimeSHA256: metadata.codexRuntimeSHA256,
        expectedCodexRuntimeLicenseBytes: metadata.codexRuntimeLicenseBytes,
        expectedCodexRuntimeLicenseSHA256: metadata.codexRuntimeLicenseSHA256,
        profilePublisher: resources.appendingPathComponent("OpenBotMigration/openbot-profile-publish"),
        expectedProfilePublisherBytes: metadata.profilePublisherBytes,
        expectedProfilePublisherSHA256: metadata.profilePublisherSHA256,
        signingIdentity: "-"
    )
}

@MainActor
private final class InstallerModel: ObservableObject {
    @Published var vendorApp: URL?
    @Published var sourceChoice: VendorSourceChoice
    @Published var destinationDirectory: URL
    @Published var state = "Choose an exact Grok Bot 0.20.0 application or opt in to the official download."
    @Published var installing = false
    @Published var installed = false

    init() {
        let installedVendor = URL(fileURLWithPath: "/Applications/Grok Bot.app", isDirectory: true)
        if FileManager.default.fileExists(atPath: installedVendor.path) {
            vendorApp = installedVendor
            sourceChoice = .existing(installedVendor)
        } else {
            vendorApp = nil
            sourceChoice = .none
        }
        let userApplications = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications", isDirectory: true)
        destinationDirectory = userApplications
        if vendorApp != nil {
            state = "Exact app verification will run before any copy or patch."
        }
    }

    func chooseVendor() {
        let panel = NSOpenPanel()
        panel.title = "Choose Grok Bot 0.20.0"
        panel.prompt = "Choose Grok Bot"
        panel.allowedContentTypes = [.applicationBundle]
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let selected = panel.url {
            vendorApp = selected
            sourceChoice = .existing(selected)
            state = "Ready to verify the selected app."
        }
    }

    func chooseOfficialDownload() {
        vendorApp = nil
        sourceChoice = .officialDownload
        state = "Official Grok Bot 0.20.0 download selected. Size and SHA-256 are pinned before mounting."
    }

    func chooseDestination() {
        let panel = NSOpenPanel()
        panel.title = "Choose installation folder"
        panel.prompt = "Use This Folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = destinationDirectory
        if panel.runModal() == .OK, let selected = panel.url {
            destinationDirectory = selected
        }
    }

    func install() {
        guard !installing, sourceChoice != .none, let resources = Bundle.main.resourceURL,
              let sidecarBytes = (Bundle.main.object(forInfoDictionaryKey: "CodexBotSidecarBytes") as? NSNumber)?.intValue,
              let sidecarSHA256 = Bundle.main.object(forInfoDictionaryKey: "CodexBotSidecarSHA256") as? String,
              let sidecarLicenseBytes = (Bundle.main.object(forInfoDictionaryKey: "CodexBotSidecarLicenseBytes") as? NSNumber)?.intValue,
              let sidecarLicenseSHA256 = Bundle.main.object(forInfoDictionaryKey: "CodexBotSidecarLicenseSHA256") as? String,
              let codexRuntimeBytes = (Bundle.main.object(forInfoDictionaryKey: "CodexBotCodexRuntimeBytes") as? NSNumber)?.intValue,
              let codexRuntimeSHA256 = Bundle.main.object(forInfoDictionaryKey: "CodexBotCodexRuntimeSHA256") as? String,
              let codexRuntimeLicenseBytes = (Bundle.main.object(forInfoDictionaryKey: "CodexBotCodexRuntimeLicenseBytes") as? NSNumber)?.intValue,
              let codexRuntimeLicenseSHA256 = Bundle.main.object(forInfoDictionaryKey: "CodexBotCodexRuntimeLicenseSHA256") as? String,
              let profilePublisherBytes = (Bundle.main.object(forInfoDictionaryKey: "OpenBotProfilePublisherBytes") as? NSNumber)?.intValue,
              let profilePublisherSHA256 = Bundle.main.object(forInfoDictionaryKey: "OpenBotProfilePublisherSHA256") as? String else {
            state = "Installer resources or vendor input are unavailable."
            return
        }
        let metadata = InstallerMetadata(
            sidecarBytes: sidecarBytes,
            sidecarSHA256: sidecarSHA256,
            sidecarLicenseBytes: sidecarLicenseBytes,
            sidecarLicenseSHA256: sidecarLicenseSHA256,
            codexRuntimeBytes: codexRuntimeBytes,
            codexRuntimeSHA256: codexRuntimeSHA256,
            codexRuntimeLicenseBytes: codexRuntimeLicenseBytes,
            codexRuntimeLicenseSHA256: codexRuntimeLicenseSHA256,
            profilePublisherBytes: profilePublisherBytes,
            profilePublisherSHA256: profilePublisherSHA256
        )
        let selectedSource = sourceChoice
        let selectedDestination = destinationDirectory
        installing = true
        installed = false
        state = selectedSource == .officialDownload
            ? "Downloading and verifying the exact official source…"
            : "Verifying and creating a separate OpenBot app…"
        Task {
            let outcome = await Task.detached(priority: .userInitiated) {
                do {
                    let runner = ProcessCommandRunner()
                    switch selectedSource {
                    case .none:
                        return InstallOutcome.failed
                    case .existing(let vendorApp):
                        let paths = makeInstallerPaths(
                            vendorApp: vendorApp,
                            destinationDirectory: selectedDestination,
                            resources: resources,
                            metadata: metadata
                        )
                        _ = try InstallerTransaction(paths: paths, runner: runner).install()
                        return InstallOutcome.succeeded(downloaded: false)
                    case .officialDownload:
                        let acquisition = GrokBotAcquisition(runner: runner)
                        var transactionInstalled = false
                        do {
                            _ = try acquisition.withOfficialApp { vendorApp in
                                let paths = makeInstallerPaths(
                                    vendorApp: vendorApp,
                                    destinationDirectory: selectedDestination,
                                    resources: resources,
                                    metadata: metadata
                                )
                                let receipt = try InstallerTransaction(paths: paths, runner: runner).install()
                                transactionInstalled = true
                                return receipt
                            }
                        } catch GrokBotAcquisitionFailure.cleanupFailed {
                            return transactionInstalled
                                ? InstallOutcome.installedWithCleanupWarning
                                : InstallOutcome.failedWithCleanupWarning
                        }
                        return InstallOutcome.succeeded(downloaded: true)
                    }
                } catch {
                    return InstallOutcome.failed
                }
            }.value
            installing = false
            switch outcome {
            case .succeeded(let downloaded):
                installed = true
                state = downloaded
                    ? "OpenBot was installed and the verified temporary source was removed."
                    : "OpenBot was installed without modifying the selected source app."
            case .installedWithCleanupWarning:
                installed = true
                state = "OpenBot was installed, but the temporary source image could not be detached. Eject it before removing the installer."
            case .failedWithCleanupWarning:
                installed = false
                state = "Installation did not complete, and the temporary source could not be fully cleaned up. Eject its mounted image before retrying."
            case .failed:
                installed = false
                state = "Installation stopped safely. The source app, any previous OpenBot, and any previous Codex Bot were preserved."
            }
        }
    }
}

private struct InstallerView: View {
    @StateObject private var model = InstallerModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: "shippingbox.and.arrow.backward.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Install OpenBot")
                        .font(.title2.weight(.semibold))
                    Text("macOS Apple Silicon · 0.2.0-macos.1")
                        .foregroundStyle(.secondary)
                }
            }

            Text("This installer verifies your exact Grok Bot 0.20.0 app, copies it, applies the reviewed OpenBot patch, and creates a separate OpenBot app. Grok Bot and any previous Codex Bot are never modified. No account, conversation, log, or developer profile is included in this installer.")
                .fixedSize(horizontal: false, vertical: true)

            GroupBox("Source app (choose one)") {
                VStack(alignment: .leading, spacing: 8) {
                    switch model.sourceChoice {
                    case .existing:
                        Text(model.vendorApp?.path ?? "Existing app selected")
                            .lineLimit(1)
                            .truncationMode(.middle)
                    case .officialDownload:
                        Text("Official Cursor download · Grok Bot 0.20.0")
                            .lineLimit(1)
                        Text("151,151,794 bytes · SHA-256 pinned · downloaded only after you click Install")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    case .none:
                        Text("No source selected")
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Button("Choose existing Grok Bot…") { model.chooseVendor() }
                        Button("Download official 0.20.0…") { model.chooseOfficialDownload() }
                    }
                }
                .padding(6)
            }

            GroupBox("Install location") {
                HStack {
                    Text(model.destinationDirectory.path)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Choose…") { model.chooseDestination() }
                }
                .padding(6)
            }

            HStack(spacing: 8) {
                if model.installing { ProgressView().controlSize(.small) }
                Image(systemName: model.installed ? "checkmark.seal.fill" : "info.circle")
                    .foregroundStyle(model.installed ? .green : .secondary)
                Text(model.state)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)

            HStack {
                Text("Development builds are ad-hoc signed and are not a notarized public release.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Install") { model.install() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.installing || model.sourceChoice == .none)
            }
        }
        .padding(24)
        .frame(width: 620, height: 470)
    }
}

@main
private struct InstallCodexBotApp: App {
    var body: some Scene {
        WindowGroup {
            InstallerView()
        }
        .windowResizability(.contentSize)
        .commands {
            CommandGroup(replacing: .newItem) { }
        }
    }
}
