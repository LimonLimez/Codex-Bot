import AppKit
import Foundation
import InstallerCore
import SwiftUI

@MainActor
private final class InstallerModel: ObservableObject {
    @Published var vendorApp: URL?
    @Published var destinationDirectory: URL
    @Published var state = "Choose an exact Grok Bot 0.20.0 application to begin."
    @Published var installing = false
    @Published var installed = false

    init() {
        let installedVendor = URL(fileURLWithPath: "/Applications/Grok Bot.app", isDirectory: true)
        vendorApp = FileManager.default.fileExists(atPath: installedVendor.path) ? installedVendor : nil
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
        panel.allowedContentTypes = [.application]
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let selected = panel.url {
            vendorApp = selected
            state = "Ready to verify the selected app."
        }
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
        guard !installing, let vendorApp, let resources = Bundle.main.resourceURL,
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
        let payload = resources.appendingPathComponent("Patcher", isDirectory: true)
        let paths = InstallerPaths(
            vendorApp: vendorApp,
            destinationApp: destinationDirectory.appendingPathComponent("OpenBot.app", isDirectory: true),
            workingDirectory: destinationDirectory,
            verifierScript: payload.appendingPathComponent("scripts/verify-vendor-app.cjs"),
            vendorManifest: payload.appendingPathComponent("assets/grok-bot-0.20.0-darwin-arm64.manifest.json"),
            patcherScript: payload.appendingPathComponent("scripts/patch-app.cjs"),
            contractAuditor: payload.appendingPathComponent("scripts/audit-grok-contract.cjs"),
            sidecarBinary: resources.appendingPathComponent("CLIProxy/cli-proxy-api"),
            sidecarLicense: resources.appendingPathComponent("CLIProxy/LICENSE"),
            expectedSidecarBytes: sidecarBytes,
            expectedSidecarSHA256: sidecarSHA256,
            expectedSidecarLicenseBytes: sidecarLicenseBytes,
            expectedSidecarLicenseSHA256: sidecarLicenseSHA256,
            codexRuntimeBinary: resources.appendingPathComponent("CodexRuntime/codex"),
            codexRuntimeReceipt: resources.appendingPathComponent("CodexRuntime/receipt.json"),
            codexRuntimeLicense: resources.appendingPathComponent("CodexRuntime/LICENSE"),
            expectedCodexRuntimeBytes: codexRuntimeBytes,
            expectedCodexRuntimeSHA256: codexRuntimeSHA256,
            expectedCodexRuntimeLicenseBytes: codexRuntimeLicenseBytes,
            expectedCodexRuntimeLicenseSHA256: codexRuntimeLicenseSHA256,
            profilePublisher: resources.appendingPathComponent("OpenBotMigration/openbot-profile-publish"),
            expectedProfilePublisherBytes: profilePublisherBytes,
            expectedProfilePublisherSHA256: profilePublisherSHA256,
            signingIdentity: "-"
        )
        installing = true
        installed = false
        state = "Verifying and creating a separate OpenBot app…"
        Task {
            let succeeded = await Task.detached(priority: .userInitiated) {
                do {
                    _ = try InstallerTransaction(paths: paths, runner: ProcessCommandRunner()).install()
                    return true
                } catch {
                    return false
                }
            }.value
            installing = false
            installed = succeeded
            state = succeeded
                ? "OpenBot was installed without modifying Grok Bot."
                : "Installation stopped safely. Grok Bot and any previous OpenBot or Codex Bot were preserved."
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

            GroupBox("Verified source app") {
                HStack {
                    Text(model.vendorApp?.path ?? "No supported app selected")
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Choose…") { model.chooseVendor() }
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
                    .disabled(model.installing || model.vendorApp == nil)
            }
        }
        .padding(24)
        .frame(width: 620, height: 430)
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
