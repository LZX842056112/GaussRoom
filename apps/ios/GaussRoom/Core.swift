import Foundation
import CryptoKit
import simd

struct Mesh: Codable {
    var vertices: [[Float]]
    var normals: [[Float]]
    var faces: [[Int]]
}
struct Crop: Codable { var min: [Float]; var max: [Float] }
struct Measurement: Codable { var start: [Float]; var end: [Float] }
struct Edits: Codable {
    var crop: Crop?
    var measurements: [Measurement] = []
    enum CodingKeys: String, CodingKey { case crop, measurements }
    init(crop: Crop?, measurements: [Measurement] = []) { self.crop = crop; self.measurements = measurements }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        crop = try values.decodeIfPresent(Crop.self, forKey: .crop)
        measurements = try values.decode([Measurement].self, forKey: .measurements)
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        if let crop { try values.encode(crop, forKey: .crop) } else { try values.encodeNil(forKey: .crop) }
        try values.encode(measurements, forKey: .measurements)
    }
}

enum Geometry {
    enum Error: Swift.Error { case invalidRows }
    static func transform(_ p: SIMD3<Float>, by m: simd_float4x4) -> SIMD3<Float> {
        let v = m * SIMD4<Float>(p.x,p.y,p.z,1)
        return SIMD3<Float>(v.x,v.y,v.z)
    }
    static func isKeyframe(_ current: simd_float4x4, after previous: simd_float4x4) -> Bool {
        let delta = SIMD3(current.columns.3.x-previous.columns.3.x, current.columns.3.y-previous.columns.3.y, current.columns.3.z-previous.columns.3.z)
        let a = simd_quatf(current), b = simd_quatf(previous)
        let cosine = min(Float(1), abs(simd_dot(a.vector, b.vector)))
        return simd_length(delta) >= 0.1 || 2 * acos(cosine) >= 8 * .pi / 180
    }
    static func packedRows(_ data: Data, rowBytes: Int, widthBytes: Int, height: Int) throws -> Data {
        guard rowBytes >= widthBytes, widthBytes >= 0, height >= 0,
              height == 0 || (rowBytes <= Int.max / height && data.count >= rowBytes * height) else { throw Error.invalidRows }
        var result = Data(capacity: widthBytes * height)
        for row in 0..<height { result.append(data.subdata(in: row * rowBytes ..< row * rowBytes + widthBytes)) }
        return result
    }
    static func cropped(_ mesh: Mesh, min: [Float], max: [Float]) -> Mesh {
        guard min.count == 3, max.count == 3 else { return mesh }
        let faces = mesh.faces.filter { face in
            face.count == 3 && face.allSatisfy { i in
                i >= 0 && i < mesh.vertices.count && mesh.vertices[i].count == 3 &&
                (0..<3).allSatisfy { mesh.vertices[i][$0] >= min[$0] && mesh.vertices[i][$0] <= max[$0] }
            }
        }
        return Mesh(vertices: mesh.vertices, normals: mesh.normals, faces: faces)
    }
    // ARKit camera space: image x is right, image y is down, camera forward is -z.
    static func project(_ p: SIMD3<Float>, intrinsics k: [Float], width: Int, height: Int) -> SIMD2<Float>? {
        guard k.count == 9, width > 0, height > 0, p.z < 0 else { return nil }
        let d = -p.z
        let x = (k[0] * p.x / d + k[6]) / Float(width)
        let y = (k[4] * -p.y / d + k[7]) / Float(height)
        guard x.isFinite, y.isFinite, x >= 0, x < 1, y >= 0, y < 1 else { return nil }
        return SIMD2<Float>(x,y)
    }
    static func depthVisible(projected: Float, observed: Float) -> Bool {
        projected.isFinite && observed.isFinite && projected > 0 && observed > 0 && abs(projected-observed) <= max(0.03, projected * 0.03)
    }
    // Test every depth-pixel center covered by the projected triangle. Perspective
    // interpolation uses inverse camera depth, not linear screen-space depth.
    static func triangleVisible(_ p: [SIMD2<Float>], depths: [Float], width: Int, height: Int, depth: Data, confidence: Data, confidenceWidth: Int, confidenceHeight: Int) -> Bool {
        guard p.count == 3, depths.count == 3, depths.allSatisfy({ $0.isFinite && $0 > 0 }), width > 0, height > 0, confidenceWidth > 0, confidenceHeight > 0,
              depth.count == width * height * 4, confidence.count == confidenceWidth * confidenceHeight else { return false }
        func cross(_ a: SIMD2<Float>, _ b: SIMD2<Float>) -> Float { a.x*b.y-a.y*b.x }
        let area = cross(p[1]-p[0], p[2]-p[0])
        guard area.isFinite, abs(area) > 1e-10 else { return false }
        let left = max(0, Int(floor(p.map(\.x).min()! * Float(width))))
        let right = min(width-1, Int(floor(p.map(\.x).max()! * Float(width))))
        let top = max(0, Int(floor(p.map(\.y).min()! * Float(height))))
        let bottom = min(height-1, Int(floor(p.map(\.y).max()! * Float(height))))
        guard left <= right, top <= bottom else { return false }
        for y in top...bottom { for x in left...right {
            let q = SIMD2((Float(x)+0.5)/Float(width), (Float(y)+0.5)/Float(height))
            let a = cross(p[1]-q,p[2]-q)/area, b = cross(p[2]-q,p[0]-q)/area, c = 1-a-b
            if a < 0 || b < 0 || c < 0 { continue }
            let cx = min(Int(q.x * Float(confidenceWidth)), confidenceWidth-1), cy = min(Int(q.y * Float(confidenceHeight)), confidenceHeight-1)
            guard confidence[cy * confidenceWidth + cx] > 0 else { return false }
            let bits: UInt32 = depth.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: (y * width + x)*4, as: UInt32.self) }
            let observed = Float(bitPattern: UInt32(littleEndian: bits)), expected = 1 / (a/depths[0]+b/depths[1]+c/depths[2])
            guard depthVisible(projected: expected, observed: observed) else { return false }
        } }
        return true
    }
    static func distance(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == 3, b.count == 3 else { return .nan }
        return sqrt(zip(a,b).reduce(Float(0)) { $0 + ($1.0-$1.1)*($1.0-$1.1) })
    }
}

enum PackageIO {
    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}

// Owned by the AR delegate queue. One admitted packet may be writing at a time.
struct FrameAdmission {
    private(set) var pending = false
    private(set) var paused = false
    mutating func admit(trackingNormal: Bool) -> Bool {
        guard trackingNormal, !paused, !pending else { return false }
        pending = true; return true
    }
    mutating func finished() { pending = false }
    mutating func pause() { paused = true }
    mutating func resume() { paused = false }
}
