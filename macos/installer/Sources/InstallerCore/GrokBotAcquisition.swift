import CryptoKit
import Darwin
import Foundation

struct GrokBotDownloadSpec: Equatable, Sendable {
    static let officialSourceURL = URL(
        string: "https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.20.0/Grok_Bot_0.20.0.dmg"
    )!

    static let exact020 = GrokBotDownloadSpec(
        sourceURL: officialSourceURL,
        expectedBytes: 151_151_794,
        expectedSHA256: "73dfc1656a0e122a9a98bdcf1f49da5ec5475e156977c8730d207bfe01281a42"
    )

    let sourceURL: URL
    let expectedBytes: Int
    let expectedSHA256: String

    init(sourceURL: URL, expectedBytes: Int, expectedSHA256: String) {
        self.sourceURL = sourceURL
        self.expectedBytes = expectedBytes
        self.expectedSHA256 = expectedSHA256
    }
}

public enum GrokBotAcquisitionFailure: Error, Equatable, Sendable {
    case invalidSpec
    case downloadFailed
    case sizeMismatch
    case hashMismatch
    case mountFailed
    case invalidMount
    case ambiguousMount
    case noApplication
    case cleanupFailed
}

/// Downloads the exact official source into one private temporary directory,
/// verifies it before mounting, and exposes it only for the duration of the
/// supplied installation transaction. No vendor bytes enter the installer DMG.
public final class GrokBotAcquisition: @unchecked Sendable {
    private struct MountedSource {
        let app: URL
        let mountPoint: URL
    }

    private let spec: GrokBotDownloadSpec
    private let runner: CommandRunning
    private let files: FileManager
    private let temporaryDirectory: URL

    public init(
        runner: CommandRunning,
        fileManager: FileManager = .default,
        temporaryDirectory: URL? = nil
    ) {
        self.spec = .exact020
        self.runner = runner
        self.files = fileManager
        self.temporaryDirectory = temporaryDirectory ?? fileManager.temporaryDirectory
    }

    init(
        testingSpec spec: GrokBotDownloadSpec,
        runner: CommandRunning,
        fileManager: FileManager = .default,
        temporaryDirectory: URL? = nil
    ) {
        self.spec = spec
        self.runner = runner
        self.files = fileManager
        self.temporaryDirectory = temporaryDirectory ?? fileManager.temporaryDirectory
    }

    public func withOfficialApp<T>(_ operation: (URL) throws -> T) throws -> T {
        try validateSpec()
        let workDirectory = try createPrivateWorkDirectory()
        let result: Result<T, Error>
        do {
            let dmg = workDirectory.appendingPathComponent("Grok_Bot_0.20.0.dmg")
            try download(to: dmg)
            try verify(dmg)
            let mounted = try attach(dmg, inside: workDirectory)
            let operationResult: Result<T, Error>
            do { operationResult = .success(try operation(mounted.app)) }
            catch { operationResult = .failure(error) }
            try detach(mounted.mountPoint)
            result = operationResult
        } catch {
            result = .failure(error)
        }
        do { try files.removeItem(at: workDirectory) }
        catch { throw GrokBotAcquisitionFailure.cleanupFailed }
        return try result.get()
    }

    private func validateSpec() throws {
        guard spec.sourceURL == GrokBotDownloadSpec.officialSourceURL,
              spec.sourceURL.scheme?.lowercased() == "https",
              spec.sourceURL.host?.lowercased() == "downloads.cursor.com",
              spec.expectedBytes > 0,
              spec.expectedSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        else { throw GrokBotAcquisitionFailure.invalidSpec }
    }

    private func createPrivateWorkDirectory() throws -> URL {
        let parent = temporaryDirectory.standardizedFileURL
        guard parent.isFileURL, parent.path.hasPrefix("/"), parent.path != "/" else {
            throw GrokBotAcquisitionFailure.invalidSpec
        }
        let parentValues: URLResourceValues
        do {
            parentValues = try parent.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        } catch {
            throw GrokBotAcquisitionFailure.invalidSpec
        }
        guard parentValues.isDirectory == true, parentValues.isSymbolicLink != true else {
            throw GrokBotAcquisitionFailure.invalidSpec
        }
        for _ in 0..<8 {
            let root = parent.appendingPathComponent(
                "openbot-grok-bot-\(UUID().uuidString.lowercased())",
                isDirectory: true
            )
            do {
                try files.createDirectory(at: root, withIntermediateDirectories: false)
            } catch CocoaError.fileWriteFileExists {
                continue
            } catch {
                throw GrokBotAcquisitionFailure.mountFailed
            }
            do {
                try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
                return root
            } catch {
                do { try files.removeItem(at: root) }
                catch { throw GrokBotAcquisitionFailure.cleanupFailed }
                throw GrokBotAcquisitionFailure.mountFailed
            }
        }
        throw GrokBotAcquisitionFailure.mountFailed
    }

    private func download(to destination: URL) throws {
        let result: CommandResult
        do {
            result = try runner.run(CommandCall(
                executable: URL(fileURLWithPath: "/usr/bin/curl"),
                arguments: [
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--proto", "=https",
                    "--connect-timeout", "30",
                    "--max-time", "900",
                    "--max-filesize", String(spec.expectedBytes),
                    "--output", destination.path,
                    spec.sourceURL.absoluteString,
                ]
            ))
        } catch {
            throw GrokBotAcquisitionFailure.downloadFailed
        }
        guard result.status == 0 else { throw GrokBotAcquisitionFailure.downloadFailed }
        do { try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path) }
        catch { throw GrokBotAcquisitionFailure.downloadFailed }
    }

    private func verify(_ file: URL) throws {
        var information = stat()
        let status = file.path.withCString { lstat($0, &information) }
        guard status == 0, information.st_mode & S_IFMT == S_IFREG,
              information.st_size == spec.expectedBytes else {
            throw GrokBotAcquisitionFailure.sizeMismatch
        }

        let digest: String
        do {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            var hasher = SHA256()
            while true {
                let chunk = try handle.read(upToCount: 1_048_576) ?? Data()
                if chunk.isEmpty { break }
                hasher.update(data: chunk)
            }
            digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        } catch {
            throw GrokBotAcquisitionFailure.hashMismatch
        }
        guard digest == spec.expectedSHA256 else {
            throw GrokBotAcquisitionFailure.hashMismatch
        }
    }

    private func attach(_ dmg: URL, inside workDirectory: URL) throws -> MountedSource {
        let mountPoint = workDirectory.appendingPathComponent("mount", isDirectory: true)
        do {
            try files.createDirectory(at: mountPoint, withIntermediateDirectories: false)
            try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: mountPoint.path)
        } catch {
            throw GrokBotAcquisitionFailure.mountFailed
        }

        let verification: CommandResult
        do {
            verification = try runner.run(CommandCall(
                executable: URL(fileURLWithPath: "/usr/bin/hdiutil"),
                arguments: ["verify", dmg.path]
            ))
        } catch {
            throw GrokBotAcquisitionFailure.mountFailed
        }
        guard verification.status == 0 else { throw GrokBotAcquisitionFailure.mountFailed }

        let result: CommandResult
        do {
            result = try runner.run(CommandCall(
                executable: URL(fileURLWithPath: "/usr/bin/hdiutil"),
                arguments: [
                    "attach", "-readonly", "-nobrowse", "-noautoopen", "-owners", "on",
                    "-mountpoint", mountPoint.path, "-plist", dmg.path,
                ]
            ))
        } catch {
            throw GrokBotAcquisitionFailure.mountFailed
        }
        guard result.status == 0 else { throw GrokBotAcquisitionFailure.mountFailed }

        do {
            try requireExactMountPoint(result.stdout, expected: mountPoint)
            let app = mountPoint.appendingPathComponent("Grok Bot.app", isDirectory: true)
            var applicationInformation = stat()
            let applicationStatus = app.path.withCString { lstat($0, &applicationInformation) }
            guard applicationStatus == 0,
                  applicationInformation.st_mode & S_IFMT == S_IFDIR else {
                throw GrokBotAcquisitionFailure.noApplication
            }
            return MountedSource(app: app, mountPoint: mountPoint)
        } catch {
            do { try detach(mountPoint) }
            catch { throw GrokBotAcquisitionFailure.cleanupFailed }
            throw error
        }
    }

    private func requireExactMountPoint(_ data: Data, expected: URL) throws {
        let propertyList: Any
        do {
            propertyList = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        } catch {
            throw GrokBotAcquisitionFailure.invalidMount
        }
        guard let root = propertyList as? [String: Any],
              let entities = root["system-entities"] as? [[String: Any]],
              !entities.isEmpty else {
            throw GrokBotAcquisitionFailure.invalidMount
        }
        let rawMountPoints = entities.compactMap { $0["mount-point"] }
        guard rawMountPoints.count == 1 else {
            throw rawMountPoints.isEmpty
                ? GrokBotAcquisitionFailure.invalidMount
                : GrokBotAcquisitionFailure.ambiguousMount
        }
        guard let path = rawMountPoints[0] as? String,
              let mounted = safeAbsoluteDirectory(path),
              let mountedCanonical = canonicalDirectory(mounted),
              let expectedCanonical = canonicalDirectory(expected),
              mountedCanonical == expectedCanonical else {
            throw GrokBotAcquisitionFailure.invalidMount
        }
    }

    private func safeAbsoluteDirectory(_ path: String) -> URL? {
        guard path.hasPrefix("/"), path != "/", !path.contains("\0") else { return nil }
        let components = path.split(separator: "/", omittingEmptySubsequences: true)
        guard !components.contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        guard "/" + components.joined(separator: "/") == path else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    private func canonicalDirectory(_ url: URL) -> String? {
        var information = stat()
        guard url.path.withCString({ lstat($0, &information) }) == 0,
              information.st_mode & S_IFMT == S_IFDIR,
              let resolved = url.path.withCString({ realpath($0, nil) }) else {
            return nil
        }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    private func detach(_ mountPoint: URL) throws {
        do {
            let ordinary = try runner.run(CommandCall(
                executable: URL(fileURLWithPath: "/usr/bin/hdiutil"),
                arguments: ["detach", mountPoint.path]
            ))
            if ordinary.status == 0 { return }
        } catch {}
        do {
            let forced = try runner.run(CommandCall(
                executable: URL(fileURLWithPath: "/usr/bin/hdiutil"),
                arguments: ["detach", "-force", mountPoint.path]
            ))
            if forced.status == 0 { return }
        } catch {}
        throw GrokBotAcquisitionFailure.cleanupFailed
    }
}
