//
//  JSONValue.swift
//  cu-helper
//
//  A Sendable, Codable dynamic JSON value plus the wire envelopes shared by
//  BOTH execution modes:
//
//    * CLI one-shot  — `cu-helper <command> --payload '<json>'` prints exactly
//      ONE `{"ok":...}` line to stdout (the existing TS bridge in
//      src/utils/computerUse/pythonBridge.ts reads one line and `JSON.parse`s
//      it as `{ ok: boolean; result?: T; error?: { message?: string } }`).
//    * Daemon        — NDJSON over an AF_UNIX socket. Each request is one JSON
//      object + '\n' carrying an `id`; each response mirrors the id.
//
//  Why a dynamic value rather than per-command structs at the boundary:
//  payloads arrive as opaque JSON on a background IO queue and must hop the
//  isolation boundary onto @MainActor before the CommandRouter decodes them
//  into typed structs. `JSONValue` is `Sendable`, so it crosses that boundary
//  cleanly under Swift 6 strict concurrency, and it round-trips losslessly so
//  `decode(_:)` can rebuild any `Decodable` the router asks for.
//
//  ENCODING CONTRACT (load-bearing for the TS bridge):
//    - The envelope OMITS `result` when there is no result and OMITS `error`
//      when there is none — matching `{ ok, result?, error? }`. The bridge
//      reads `parsed.error?.message`, so a present-but-null error would be
//      wrong; absence is correct.
//    - `line()` appends a single trailing '\n'. JSONEncoder (no
//      `.prettyPrinted`) never emits interior newlines, so each frame is
//      exactly one line — stdout stays parseable.
//

import Foundation

// MARK: - JSONValue

/// A fully dynamic, `Sendable`, `Codable`, `Equatable` JSON value.
///
/// Integers and doubles are kept distinct on decode (an integral number
/// decodes to `.int`, a fractional one to `.double`) so re-encoding a payload
/// preserves `42` vs `42.0`. `null` is represented explicitly so it survives a
/// round-trip rather than collapsing to "absent".
public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    // MARK: Parsing

    /// Parse a JSON document from a string (e.g. the `--payload` argument).
    ///
    /// Allows top-level fragments (`42`, `"x"`, `true`, `null`) in addition to
    /// objects/arrays, matching what `JSON.stringify` may hand us for scalar
    /// payloads.
    public init(jsonString: String) throws {
        let data = Data(jsonString.utf8)
        self = try JSONValue.decoder.decode(JSONValue.self, from: data)
    }

    /// Build directly from already-parsed Foundation JSON
    /// (`JSONSerialization.jsonObject`). Used by callers that obtain a
    /// `Data`/`Any` graph elsewhere and want it as a `JSONValue` without a
    /// second encode/decode hop.
    public init(foundation object: Any) {
        switch object {
        case is NSNull:
            self = .null
        case let n as NSNumber:
            self = JSONValue(number: n)
        case let s as String:
            self = .string(s)
        case let b as Bool:
            // Reached only if a raw Swift Bool slips through (NSNumber handled
            // above for the JSONSerialization path).
            self = .bool(b)
        case let i as Int:
            self = .int(i)
        case let d as Double:
            self = .double(d)
        case let arr as [Any]:
            self = .array(arr.map { JSONValue(foundation: $0) })
        case let dict as [String: Any]:
            var out: [String: JSONValue] = [:]
            out.reserveCapacity(dict.count)
            for (k, v) in dict { out[k] = JSONValue(foundation: v) }
            self = .object(out)
        default:
            self = .null
        }
    }

    /// Disambiguate an `NSNumber` (which boxes Bool, Int, and Double alike) into
    /// the correct case. `__NSCFBoolean` is the canonical CoreFoundation boolean
    /// type; everything integral becomes `.int`, the rest `.double`.
    private init(number: NSNumber) {
        let typeID = CFGetTypeID(number)
        if typeID == CFBooleanGetTypeID() {
            self = .bool(number.boolValue)
            return
        }
        // `objCType` is "q"/"i"/"l"… for integers, "d"/"f" for floats.
        let objcType = String(cString: number.objCType)
        if objcType == "d" || objcType == "f" {
            self = .double(number.doubleValue)
        } else {
            self = .int(number.intValue)
        }
    }

    // MARK: Codable

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
            return
        }
        // Bool MUST be tried before Int: some decoders will happily turn
        // `true`/`false` into `1`/`0`. We want them to stay booleans.
        if let b = try? container.decode(Bool.self) {
            self = .bool(b)
            return
        }
        if let i = try? container.decode(Int.self) {
            self = .int(i)
            return
        }
        if let d = try? container.decode(Double.self) {
            self = .double(d)
            return
        }
        if let s = try? container.decode(String.self) {
            self = .string(s)
            return
        }
        if let arr = try? container.decode([JSONValue].self) {
            self = .array(arr)
            return
        }
        if let obj = try? container.decode([String: JSONValue].self) {
            self = .object(obj)
            return
        }
        throw DecodingError.dataCorrupted(
            DecodingError.Context(
                codingPath: decoder.codingPath,
                debugDescription: "Unsupported JSON value"
            )
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let b):
            try container.encode(b)
        case .int(let i):
            try container.encode(i)
        case .double(let d):
            try container.encode(d)
        case .string(let s):
            try container.encode(s)
        case .array(let arr):
            try container.encode(arr)
        case .object(let obj):
            try container.encode(obj)
        }
    }

    // MARK: Typed re-decode

    /// Re-encode this value and decode it into a concrete `Decodable`.
    ///
    /// This is the bridge between the dynamic boundary representation and the
    /// typed payload structs the `CommandRouter` works with. It round-trips
    /// through JSON bytes so any `Decodable` shape (including ones with custom
    /// `CodingKeys`/defaults) is honored exactly as if it had been decoded from
    /// the original document.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let data = try JSONValue.encoder.encode(self)
        return try JSONValue.decoder.decode(T.self, from: data)
    }

    // MARK: Convenience accessors

    /// Keyed access for `.object`; `nil` for every other case.
    public subscript(_ key: String) -> JSONValue? {
        if case .object(let dict) = self { return dict[key] }
        return nil
    }

    /// Indexed access for `.array`; `nil` for out-of-range or non-arrays.
    public subscript(_ index: Int) -> JSONValue? {
        if case .array(let arr) = self, arr.indices.contains(index) {
            return arr[index]
        }
        return nil
    }

    /// Integer view. Accepts `.int`, an integral `.double`, and a numeric
    /// `.string` (the TS layer occasionally stringifies ids).
    public var asInt: Int? {
        switch self {
        case .int(let i): return i
        case .double(let d):
            guard d.rounded() == d, d.isFinite else { return nil }
            return Int(exactly: d.rounded())
        case .bool(let b): return b ? 1 : 0
        case .string(let s): return Int(s)
        default: return nil
        }
    }

    /// Double view. Accepts `.double`, `.int`, and a numeric `.string`.
    public var asDouble: Double? {
        switch self {
        case .double(let d): return d
        case .int(let i): return Double(i)
        case .bool(let b): return b ? 1 : 0
        case .string(let s): return Double(s)
        default: return nil
        }
    }

    /// String view. Only a genuine `.string` qualifies (no number coercion, to
    /// avoid surprising "1" from a bool/int).
    public var asString: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// Bool view. Accepts `.bool` and the common JSON-ish stand-ins.
    public var asBool: Bool? {
        switch self {
        case .bool(let b): return b
        case .int(let i): return i != 0
        case .string(let s):
            switch s.lowercased() {
            case "true", "1", "yes": return true
            case "false", "0", "no": return false
            default: return nil
            }
        default: return nil
        }
    }

    /// Array view; `nil` for every non-array case.
    public var asArray: [JSONValue]? {
        if case .array(let arr) = self { return arr }
        return nil
    }

    /// Object view; `nil` for every non-object case.
    public var asObject: [String: JSONValue]? {
        if case .object(let obj) = self { return obj }
        return nil
    }

    /// `true` only for the explicit `.null` case.
    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    // MARK: Shared coders

    /// Stable encoder for the boundary. Sorted keys keep output deterministic
    /// (useful for tests and golden comparisons); NO `.prettyPrinted` so frames
    /// never contain interior newlines.
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()

    static let decoder = JSONDecoder()
}

// MARK: - ExpressibleBy* literals (ergonomic result construction in routers)

extension JSONValue: ExpressibleByNilLiteral {
    public init(nilLiteral: ()) { self = .null }
}

extension JSONValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension JSONValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) { self = .int(value) }
}

extension JSONValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) { self = .double(value) }
}

extension JSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

extension JSONValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

extension JSONValue: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var dict: [String: JSONValue] = [:]
        dict.reserveCapacity(elements.count)
        for (k, v) in elements { dict[k] = v }
        self = .object(dict)
    }
}

// MARK: - Encoding any Encodable into a JSONValue

extension JSONValue {
    /// Wrap any `Encodable` result model (e.g. `ScreenshotResult`,
    /// `[DisplayGeometry]`) into a `JSONValue` so the `CommandRouter` can return
    /// a single uniform type. Round-trips through JSON bytes.
    public init<T: Encodable>(encoding value: T) throws {
        let data = try JSONValue.encoder.encode(value)
        self = try JSONValue.decoder.decode(JSONValue.self, from: data)
    }
}

// MARK: - Envelope (CLI one-shot stdout line)

/// The `{ ok, result?, error? }` object the TS bridge parses from the single
/// stdout line in CLI mode.
///
/// `result` and `error` are emitted ONLY when present (the bridge reads
/// `parsed.result` and `parsed.error?.message`). On success we emit
/// `{"ok":true,"result":...}`; on failure `{"ok":false,"error":{...}}`.
public struct Envelope: Encodable, Sendable {
    public let ok: Bool
    public let result: JSONValue?
    public let error: ErrBody?

    public struct ErrBody: Encodable, Sendable {
        public let message: String
        public let code: String?

        public init(message: String, code: String?) {
            self.message = message
            self.code = code
        }

        private enum CodingKeys: String, CodingKey { case message, code }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(message, forKey: .message)
            // Omit `code` entirely when absent — the bridge only needs message.
            try c.encodeIfPresent(code, forKey: .code)
        }
    }

    public init(ok: Bool, result: JSONValue?, error: ErrBody?) {
        self.ok = ok
        self.result = result
        self.error = error
    }

    /// Success envelope carrying `result`.
    public static func ok(_ result: JSONValue) -> Envelope {
        Envelope(ok: true, result: result, error: nil)
    }

    /// Failure envelope. `code` is optional (one of `CUError`'s canonical codes
    /// when available).
    public static func fail(_ message: String, code: String? = nil) -> Envelope {
        Envelope(ok: false, result: nil, error: ErrBody(message: message, code: code))
    }

    /// Build a failure envelope from a thrown error, preserving the `CUError`
    /// code when the error is one.
    public static func fail(_ error: Error) -> Envelope {
        if let cu = error as? CUError {
            return Envelope(ok: false, result: nil, error: ErrBody(message: cu.message, code: cu.code))
        }
        return Envelope(ok: false, result: nil, error: ErrBody(message: String(describing: error), code: nil))
    }

    private enum CodingKeys: String, CodingKey { case ok, result, error }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ok, forKey: .ok)
        // CRITICAL: omit `result`/`error` when nil so the wire object is
        // exactly `{ok}` / `{ok,result}` / `{ok,error}` and never carries a
        // literal `null` the bridge would misread.
        try c.encodeIfPresent(result, forKey: .result)
        try c.encodeIfPresent(error, forKey: .error)
    }

    /// Serialize to one NDJSON line: compact JSON + a single trailing '\n'.
    /// Never throws in practice — every field is trivially encodable — but if
    /// encoding somehow fails we fall back to a hand-built error line so the
    /// bridge still receives parseable JSON and the process can exit cleanly.
    public func line() -> Data {
        do {
            var data = try Envelope.lineEncoder.encode(self)
            data.append(0x0A) // '\n'
            return data
        } catch {
            return Envelope.fallbackErrorLine
        }
    }

    /// Encoder for the wire. NOT `.sortedKeys` — `ok` should lead naturally and
    /// key order is irrelevant to `JSON.parse`; crucially NO `.prettyPrinted`
    /// so the frame is a single line.
    static let lineEncoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    /// Last-resort, statically-valid one-line failure if encoding throws.
    static let fallbackErrorLine: Data =
        Data(#"{"ok":false,"error":{"message":"envelope encode failed","code":"encode_failed"}}"#.utf8)
            + Data([0x0A])
}

// MARK: - Daemon wire structs (NDJSON request/response)

/// One inbound NDJSON request on the daemon socket.
///
/// `id` is echoed back on the matching `DaemonResponse` so the bridge can pair
/// responses to requests on a single multiplexed connection. `payload` is
/// optional (control verbs like `ping`/`shutdown` carry none).
public struct Request: Decodable, Sendable {
    public let id: String?
    public let cmd: String
    public let payload: JSONValue?
    public let clientApiVersion: String?
    public let deadlineUnixMilliseconds: Int64?
    public let sessionId: String?
    public let turnId: String?
    public let requestId: String?

    public init(
        id: String?,
        cmd: String,
        payload: JSONValue?,
        clientApiVersion: String? = nil,
        deadlineUnixMilliseconds: Int64? = nil,
        sessionId: String? = nil,
        turnId: String? = nil,
        requestId: String? = nil
    ) {
        self.id = id
        self.cmd = cmd
        self.payload = payload
        self.clientApiVersion = clientApiVersion
        self.deadlineUnixMilliseconds = deadlineUnixMilliseconds
        self.sessionId = sessionId
        self.turnId = turnId
        self.requestId = requestId
    }

    /// The payload, defaulting to an empty object when omitted/null — every
    /// command handler can rely on a non-nil object to decode from.
    public var payloadOrEmpty: JSONValue {
        switch payload {
        case .some(let p) where !p.isNull: return p
        default: return .object([:])
        }
    }

    /// Decode a single framed NDJSON line into a `Request`.
    public static func decode(line: Data) throws -> Request {
        try JSONValue.decoder.decode(Request.self, from: line)
    }
}

/// One outbound NDJSON response on the daemon socket. Mirrors `Envelope` but
/// carries the request `id` for multiplexing. Like `Envelope`, `result`/`error`
/// are omitted when absent.
public struct DaemonResponse: Encodable, Sendable {
    public let id: String?
    public let ok: Bool
    public let result: JSONValue?
    public let error: Envelope.ErrBody?

    public init(id: String?, ok: Bool, result: JSONValue?, error: Envelope.ErrBody?) {
        self.id = id
        self.ok = ok
        self.result = result
        self.error = error
    }

    /// Success response for the given request id.
    public static func ok(id: String?, result: JSONValue) -> DaemonResponse {
        DaemonResponse(id: id, ok: true, result: result, error: nil)
    }

    /// Failure response, preserving a `CUError` code when present.
    public static func fail(id: String?, _ error: Error) -> DaemonResponse {
        if let cu = error as? CUError {
            return DaemonResponse(id: id, ok: false, result: nil,
                                  error: Envelope.ErrBody(message: cu.message, code: cu.code))
        }
        return DaemonResponse(id: id, ok: false, result: nil,
                              error: Envelope.ErrBody(message: String(describing: error), code: nil))
    }

    /// Failure response with an explicit message/code.
    public static func fail(id: String?, message: String, code: String? = nil) -> DaemonResponse {
        DaemonResponse(id: id, ok: false, result: nil,
                       error: Envelope.ErrBody(message: message, code: code))
    }

    private enum CodingKeys: String, CodingKey { case id, ok, result, error }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(id, forKey: .id)
        try c.encode(ok, forKey: .ok)
        try c.encodeIfPresent(result, forKey: .result)
        try c.encodeIfPresent(error, forKey: .error)
    }

    /// Serialize to one NDJSON line: compact JSON + a single trailing '\n'.
    public func line() -> Data {
        do {
            var data = try Envelope.lineEncoder.encode(self)
            data.append(0x0A)
            return data
        } catch {
            return Envelope.fallbackErrorLine
        }
    }
}
