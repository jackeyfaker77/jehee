// Session-scoped vault offloading large binary Base64 fields behind compact `$jehee_blob:<id>` handles in model-facing
// tool outputs and expanding them losslessly on outbound MCP tool calls (preserving exact SHA-256 integrity).

import { createHash } from "node:crypto";

/** Prefix identifying an offloaded binary payload handle passed between MCP tool turns. */
export const JEHEE_BLOB_HANDLE_PREFIX = "$jehee_blob:";

/** Default decoded byte threshold (4 KiB) above which non-text Base64 payloads are offloaded. */
export const DEFAULT_BLOB_OFFLOAD_THRESHOLD_BYTES = 4096;

/** Default maximum number of distinct blobs retained in one `McpBlobVault` (LRU eviction). */
export const DEFAULT_MAX_BLOB_ENTRIES = 64;

/** Default maximum cumulative decoded byte budget retained in one `McpBlobVault` (32 MiB). */
export const DEFAULT_MAX_BLOB_TOTAL_BYTES = 32 * 1024 * 1024;

/** Memory retention bounds for `McpBlobVault`. */
export type McpBlobVaultOptions = {
	readonly maxEntries?: number;
	readonly maxTotalBytes?: number;
};

/** Stored binary payload entry indexed by handle in `McpBlobVault`. */
export type StoredBlobEntry = {
	readonly handle: string;
	readonly base64: string;
	readonly byteLength: number;
	readonly sha256: string;
	readonly mimeType?: string;
};

/** Decoded binary blob returned by `McpBlobVault.getBlob`. */
export type ResolvedBlob = {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly byteLength: number;
};

/** Outcome of shaping model-facing tool output text through `McpBlobVault`. */
export type BlobOffloadResult = {
	readonly text: string;
	readonly offloadedBytes: number;
};

/** Outcome of expanding `$jehee_blob:<id>` handles in outbound MCP tool arguments. */
export type BlobRestoreResult = {
	readonly args: Record<string, unknown>;
	readonly restoredCount: number;
};

/** Shaped model-facing representation of one item from MCP `resources/read`. */
export type ShapedResourceItem =
	| {
			readonly kind: "text";
			readonly text: string;
			readonly bytes: number;
			readonly offloaded: boolean;
	  }
	| {
			readonly kind: "image";
			readonly data: string;
			readonly mimeType: string;
			readonly bytes: number;
			readonly offloaded: false;
	  };

const BASE64_FIELD_NAMES = new Set(["base64", "blob"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for UTF-8 human-readable MIME types (such as `text/calendar` ICS invites, plain text, or JSON). */
export function isReadableTextMime(mimeType: string | undefined): boolean {
	if (mimeType === undefined) return false;
	const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return (
		normalized.startsWith("text/") ||
		normalized === "application/json" ||
		normalized.endsWith("+json") ||
		normalized === "application/xml" ||
		normalized.endsWith("+xml")
	);
}

/** Validates and normalizes standard or URL-safe Base64 (accepting whitespace and omitted padding); returns `undefined` if malformed. */
export function normalizeBase64(base64: string): string | undefined {
	const stripped = base64.replace(/[\r\n\t ]+/g, "");
	if (stripped.length === 0) return "";
	const standard = stripped.replaceAll("-", "+").replaceAll("_", "/");
	if (standard.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(standard)) {
		return undefined;
	}
	if (standard.includes("=") && standard.length % 4 !== 0) {
		return undefined;
	}
	const remainder = standard.length % 4;
	return remainder === 0 ? standard : `${standard}${"=".repeat(4 - remainder)}`;
}

function looksLikeBase64(raw: string): boolean {
	if (raw.length === 0 || raw.startsWith(JEHEE_BLOB_HANDLE_PREFIX)) return false;
	const normalized = normalizeBase64(raw);
	return normalized !== undefined && normalized.length > 0;
}

/** Decodes standard or URL-safe Base64 into bytes using pure Web-standard APIs (Cloudflare Workers & Node portable). */
export function decodeBase64ToBytes(base64: string): Uint8Array {
	const normalized = normalizeBase64(base64);
	if (normalized === undefined) {
		throw new Error("Invalid Base64 payload");
	}
	if (normalized.length === 0) return new Uint8Array(0);
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/** Holds offloaded binary Base64 payloads for one MCP connector bundle lifecycle with bounded LRU eviction. */
export class McpBlobVault {
	readonly #entries = new Map<string, StoredBlobEntry>();
	readonly #maxEntries: number;
	readonly #maxTotalBytes: number;
	#totalBytes = 0;

	constructor(options?: McpBlobVaultOptions) {
		this.#maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_BLOB_ENTRIES);
		this.#maxTotalBytes = Math.max(1, options?.maxTotalBytes ?? DEFAULT_MAX_BLOB_TOTAL_BYTES);
	}

	/** Count of distinct binary blobs currently stored in this vault. */
	get size(): number {
		return this.#entries.size;
	}

	/** Cumulative decoded byte length of all blobs currently retained in this vault. */
	get totalBytes(): number {
		return this.#totalBytes;
	}

	#touch(handle: string, entry: StoredBlobEntry): StoredBlobEntry {
		this.#entries.delete(handle);
		this.#entries.set(handle, entry);
		return entry;
	}

	#evictFor(incomingBytes: number): void {
		while (
			this.#entries.size > 0 &&
			(this.#entries.size >= this.#maxEntries || this.#totalBytes + incomingBytes > this.#maxTotalBytes)
		) {
			const oldestKey = this.#entries.keys().next().value;
			if (oldestKey === undefined) break;
			const evicted = this.#entries.get(oldestKey);
			this.#entries.delete(oldestKey);
			if (evicted !== undefined) {
				this.#totalBytes = Math.max(0, this.#totalBytes - evicted.byteLength);
			}
		}
	}

	/** Looks up a previously stored blob by its `$jehee_blob:<id>` handle. */
	get(handle: string): StoredBlobEntry | undefined {
		const entry = this.#entries.get(handle);
		if (entry === undefined) return undefined;
		return this.#touch(handle, entry);
	}

	/** Decodes a previously stored `$jehee_blob:<id>` handle into raw bytes and MIME metadata. */
	getBlob(handle: string): ResolvedBlob | undefined {
		const entry = this.#entries.get(handle);
		if (entry === undefined) return undefined;
		this.#touch(handle, entry);
		try {
			const bytes = decodeBase64ToBytes(entry.base64);
			return {
				bytes,
				mimeType: entry.mimeType ?? "application/octet-stream",
				byteLength: bytes.byteLength,
			};
		} catch {
			return undefined;
		}
	}

	/** Validates Base64 and vault capacity before storing; returns `undefined` if malformed, empty, or over `maxTotalBytes`. */
	tryStoreBase64(base64: string, mimeType?: string): StoredBlobEntry | undefined {
		const normalized = normalizeBase64(base64);
		if (normalized === undefined || normalized.length === 0) return undefined;
		const unpaddedLen = normalized.endsWith("==")
			? normalized.length - 2
			: normalized.endsWith("=")
				? normalized.length - 1
				: normalized.length;
		const estimatedBytes = Math.floor((unpaddedLen * 3) / 4);
		if (estimatedBytes > this.#maxTotalBytes) return undefined;
		try {
			return this.storeBase64(normalized, mimeType);
		} catch {
			return undefined;
		}
	}

	/** Decodes `base64` to compute its exact byte length and SHA-256 digest, stores it under LRU bounds, and returns its handle metadata. */
	storeBase64(base64: string, mimeType?: string): StoredBlobEntry {
		const normalized = normalizeBase64(base64);
		if (normalized === undefined) {
			throw new Error("Invalid Base64 payload");
		}
		const bytes = decodeBase64ToBytes(normalized);
		if (bytes.byteLength > this.#maxTotalBytes) {
			throw new Error(`Blob (${bytes.byteLength} bytes) exceeds vault capacity (${this.#maxTotalBytes} bytes)`);
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const handle = `${JEHEE_BLOB_HANDLE_PREFIX}${sha256.slice(0, 16)}`;
		const existing = this.#entries.get(handle);
		if (existing !== undefined) {
			const updated =
				existing.mimeType === undefined && mimeType !== undefined ? { ...existing, mimeType } : existing;
			return this.#touch(handle, updated);
		}
		this.#evictFor(bytes.byteLength);
		const entry: StoredBlobEntry = {
			handle,
			base64: normalized,
			byteLength: bytes.byteLength,
			sha256,
			...(mimeType !== undefined ? { mimeType } : {}),
		};
		this.#entries.set(handle, entry);
		this.#totalBytes += entry.byteLength;
		return entry;
	}

	/**
	 * Shapes JSON-encoded tool output text for the LLM:
	 * - Decodes small `text/*` (e.g. `text/calendar` ICS) `base64` fields into a sibling `decoded_text` preview so the
	 *   model never has to mentally Base64-decode calendar invites or text notes;
	 * - Replaces binary `base64` / `blob` fields whose decoded size >= `thresholdBytes` with compact `$jehee_blob:<id>`
	 *   handles while preserving sibling `filename`, `mime_type`, and `sha256` fields intact.
	 */
	shapeToolResultText(text: string, thresholdBytes: number = DEFAULT_BLOB_OFFLOAD_THRESHOLD_BYTES): BlobOffloadResult {
		const trimmed = text.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
			return { text, offloadedBytes: 0 };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return { text, offloadedBytes: 0 };
		}
		let offloadedBytes = 0;
		let mutated = false;

		const transform = (node: unknown): unknown => {
			if (Array.isArray(node)) {
				return node.map((item) => transform(item));
			}
			if (!isPlainObject(node)) {
				return node;
			}
			const mimeCandidate =
				typeof node.mime_type === "string"
					? node.mime_type
					: typeof node.mimeType === "string"
						? node.mimeType
						: undefined;
			const out: Record<string, unknown> = {};
			for (const [key, val] of Object.entries(node)) {
				if (BASE64_FIELD_NAMES.has(key) && typeof val === "string" && looksLikeBase64(val)) {
					const decoded = Buffer.from(val, "base64");
					if (isReadableTextMime(mimeCandidate) && decoded.byteLength <= 32_768) {
						out[key] = decoded.byteLength >= thresholdBytes ? this.storeBase64(val, mimeCandidate).handle : val;
						if (decoded.byteLength >= thresholdBytes) {
							offloadedBytes += decoded.byteLength;
						}
						if (node.decoded_text === undefined) {
							out.decoded_text = decoded.toString("utf8");
							mutated = true;
						}
						continue;
					}
					if (decoded.byteLength >= thresholdBytes) {
						const stored = this.storeBase64(val, mimeCandidate);
						out[key] = stored.handle;
						if (node.sha256 === undefined) out.sha256 = stored.sha256;
						out[`${key}_bytes`] = stored.byteLength;
						offloadedBytes += decoded.byteLength;
						mutated = true;
						continue;
					}
				}
				out[key] = transform(val);
			}
			return out;
		};

		const shaped = transform(parsed);
		if (!mutated && offloadedBytes === 0) {
			return { text, offloadedBytes: 0 };
		}
		return {
			text: JSON.stringify(shaped),
			offloadedBytes,
		};
	}

	/** Shapes one item returned from MCP `resources/read` into text or image content with binary handle offloading. */
	shapeResourceReadItem(
		item: {
			readonly uri: string;
			readonly mimeType?: string;
			readonly text?: string;
			readonly blob?: string;
		},
		thresholdBytes: number = DEFAULT_BLOB_OFFLOAD_THRESHOLD_BYTES,
	): ShapedResourceItem {
		if (item.text !== undefined) {
			return {
				kind: "text",
				text: item.text,
				bytes: Buffer.byteLength(item.text, "utf8"),
				offloaded: false,
			};
		}
		const rawBlob = item.blob ?? "";
		const decoded = Buffer.from(rawBlob, "base64");
		if (item.mimeType?.startsWith("image/")) {
			return {
				kind: "image",
				data: rawBlob,
				mimeType: item.mimeType,
				bytes: decoded.byteLength,
				offloaded: false,
			};
		}
		if (isReadableTextMime(item.mimeType)) {
			return {
				kind: "text",
				text: decoded.toString("utf8"),
				bytes: decoded.byteLength,
				offloaded: false,
			};
		}
		if (decoded.byteLength >= thresholdBytes) {
			const stored = this.tryStoreBase64(rawBlob, item.mimeType);
			if (stored !== undefined) {
				return {
					kind: "text",
					text: JSON.stringify({
						uri: item.uri,
						mime_type: item.mimeType ?? "application/octet-stream",
						bytes: stored.byteLength,
						sha256: stored.sha256,
						base64: stored.handle,
					}),
					bytes: stored.byteLength,
					offloaded: true,
				};
			}
		}
		const sha256 = createHash("sha256").update(decoded).digest("hex");
		return {
			kind: "text",
			text: JSON.stringify({
				uri: item.uri,
				mime_type: item.mimeType ?? "application/octet-stream",
				bytes: decoded.byteLength,
				sha256,
				base64: rawBlob,
			}),
			bytes: decoded.byteLength,
			offloaded: false,
		};
	}

	/** Recursively expands any `$jehee_blob:<id>` handles in outbound MCP tool arguments back into raw Base64 strings. */
	restoreInArgs(args: Readonly<Record<string, unknown>>): BlobRestoreResult {
		let restoredCount = 0;

		const restore = (node: unknown): unknown => {
			if (typeof node === "string") {
				if (!node.startsWith(JEHEE_BLOB_HANDLE_PREFIX)) return node;
				const entry = this.get(node);
				if (entry === undefined) {
					throw new Error(`Unknown MCP attachment blob handle "${node}"`);
				}
				restoredCount += 1;
				return entry.base64;
			}
			if (Array.isArray(node)) {
				return node.map((item) => restore(item));
			}
			if (isPlainObject(node)) {
				const out: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(node)) {
					out[k] = restore(v);
				}
				return out;
			}
			return node;
		};

		return {
			args: restore(args) as Record<string, unknown>,
			restoredCount,
		};
	}
}
