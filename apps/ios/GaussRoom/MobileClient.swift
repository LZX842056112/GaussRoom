import Foundation
import Security
import WebKit

struct UploadStatus: Decodable { let id: String; let offset: Int64; let bytes: Int64; let projectId: String? }
struct ProjectSummary: Decodable {
    struct Scene: Decodable { let viewerUrl: String }
    struct Timing: Decodable { let elapsedMs: Double?; let complete: Bool; let running: Bool }
    struct Step: Decodable, Identifiable { let id: String; let name: String; let status: String; let progress: Double; let timing: Timing? }
    struct Quality: Decodable { let geometry: String; let coverage: String; let appearance: String; let scale: String; let trainingComplete: Bool; let complete: Bool }
    let id: String; let name: String; let state: String; let progress: Double; let timing: Timing?; let steps: [Step]; let quality: Quality?; let scene: Scene?; let lastError: String?
}

final class MobileClient {
    enum Failure: Error { case invalidURL, invalidResponse, server(Int, String), invalidOffset }
    private let base: URL
    private let session: URLSession
    private var token: String
    init(base: URL, token: String = "", session: URLSession = .shared) { self.base = base; self.token = token; self.session = session }
    private func request(_ path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil, range: String? = nil) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: "/api/mobile/v1" + path, relativeTo: base)?.absoluteURL else { throw Failure.invalidURL }
        var req = URLRequest(url: url); req.httpMethod = method; req.httpBody = body
        if !token.isEmpty { req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let range { req.setValue(range, forHTTPHeaderField: "Content-Range") }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw Failure.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let error = (try? JSONDecoder().decode(ServerError.self, from: data).error) ?? "请求失败"
            throw Failure.server(http.statusCode, error)
        }
        return (data, http)
    }
    private struct ServerError: Decodable { let error: String }
    private struct Pair: Decodable { let token: String; let deviceId: String }
    private struct Commit: Decodable { let projectId: String }
    private struct Offset: Decodable { let offset: Int64 }
    private func json(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object) }
    func pair(code: String, deviceName: String) async throws -> String {
        let (data, _) = try await request("/pair", method: "POST", body: json(["code":code,"deviceName":deviceName]), contentType: "application/json")
        let result = try JSONDecoder().decode(Pair.self, from: data); token = result.token
        try TokenStore.save(result.token, for: base.absoluteString); return result.deviceId
    }
    func upload(file: URL, scanId: String) async throws -> String {
        let bytes = try Data(contentsOf: file, options: .mappedIfSafe)
        let hash = PackageIO.sha256(bytes)
        let key = "GaussRoom.upload." + base.absoluteString + "." + scanId + "." + hash
        var status: UploadStatus
        if let id = UserDefaults.standard.string(forKey: key) {
            do {
                let (data, _) = try await request("/uploads/\(id)")
                status = try JSONDecoder().decode(UploadStatus.self, from: data)
            } catch Failure.server(let code, _) where code == 404 {
                UserDefaults.standard.removeObject(forKey: key)
                let (created, _) = try await request("/uploads", method: "POST", body: json(["scanId":scanId,"sha256":hash,"bytes":bytes.count]), contentType: "application/json")
                status = try JSONDecoder().decode(UploadStatus.self, from: created)
                UserDefaults.standard.set(status.id, forKey: key)
            }
        } else {
            let (created, _) = try await request("/uploads", method: "POST", body: json(["scanId":scanId,"sha256":hash,"bytes":bytes.count]), contentType: "application/json")
            status = try JSONDecoder().decode(UploadStatus.self, from: created)
            UserDefaults.standard.set(status.id, forKey: key)
        }
        guard status.bytes == Int64(bytes.count), status.offset >= 0, status.offset <= status.bytes else { throw Failure.invalidOffset }
        while status.offset < status.bytes {
            let end = min(status.bytes, status.offset + 8 * 1024 * 1024)
            let chunk = bytes.subdata(in: Int(status.offset)..<Int(end))
            let (response, _) = try await request("/uploads/\(status.id)", method: "PUT", body: chunk, contentType: "application/octet-stream", range: "bytes \(status.offset)-\(end-1)/\(status.bytes)")
            let offset = try JSONDecoder().decode(Offset.self, from: response).offset
            guard offset == end else { throw Failure.invalidOffset }
            status = UploadStatus(id: status.id, offset: offset, bytes: status.bytes, projectId: status.projectId)
        }
        let (result, _) = try await request("/uploads/\(status.id)/commit", method: "POST")
        let project = try JSONDecoder().decode(Commit.self, from: result).projectId
        UserDefaults.standard.removeObject(forKey: key)
        return project
    }
    func project(_ id: String) async throws -> ProjectSummary {
        let (data, _) = try await request("/projects/\(id)")
        return try JSONDecoder().decode(ProjectSummary.self, from: data)
    }
    func run(_ id: String) async throws { _ = try await request("/projects/\(id)/run", method: "POST", body: json(["trainingPreset":"standard"]), contentType: "application/json") }
    @MainActor func viewerRequest(_ relativeURL: String, store: WKHTTPCookieStore) async throws -> URLRequest {
        let (_, response) = try await request("/session", method: "POST")
        guard let headers = response.allHeaderFields as? [String:String], let url = response.url,
              let target = URL(string: relativeURL, relativeTo: base)?.absoluteURL,
              target.scheme == base.scheme, target.host == base.host, target.port == base.port else { throw Failure.invalidURL }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
        for cookie in cookies { await store.setCookie(cookie) }
        guard !cookies.isEmpty else { throw Failure.invalidResponse }
        return URLRequest(url: target)
    }
}

enum TokenStore {
    static func save(_ token: String, for server: String) throws {
        let query: [String: Any] = [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:"GaussRoom.Mobile", kSecAttrAccount as String:server]
        SecItemDelete(query as CFDictionary)
        var item = query; item[kSecValueData as String] = Data(token.utf8); item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
    static func load(for server: String) -> String? {
        let query: [String: Any] = [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:"GaussRoom.Mobile", kSecAttrAccount as String:server, kSecReturnData as String:true, kSecMatchLimit as String:kSecMatchLimitOne]
        var result: CFTypeRef?; guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
