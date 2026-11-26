// `pi-durable` extension exposing Jehee's portable outbound media delivery tool (`"jehee.media"` / `send_media`).
// Kept 100% Web/Edge portable (pure `atob` + `TextEncoder`, zero Node builtins) for both Node 24 and Cloudflare Workers.

import type { Context } from "@earendil-works/chord/context";
import {
	defineExtension,
	defineTool,
	type Extension,
	type JsonObject,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";

/** Fixed extension slot name for Jehee's outbound media delivery tool. */
export const JEHEE_MEDIA_EXTENSION_NAME = "jehee.media";

/** Extension handle referencing `"jehee.media"` for `configure({ extensions: { remove: [...] } })`. */
export const JEHEE_MEDIA_EXTENSION_HANDLE: Extension = defineExtension({
	name: JEHEE_MEDIA_EXTENSION_NAME,
});

/** Tool name for delivering photos or documents directly to the owner's active messaging route. */
export const SEND_MEDIA_TOOL = "send_media";

/** Default maximum decoded payload size enforced by `send_media` (10 MiB). */
export const DEFAULT_OUTBOUND_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** Resolved binary payload returned by a `$jehee_blob:<id>` vault resolver. */
export type ResolvedOutboundBlob = {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
};

/** Validated outbound photo or document payload handed to the host's channel delivery adapter. */
export type OutboundMediaPayload =
	| {
			readonly kind: "photo";
			readonly bytes: Uint8Array;
			readonly mimeType: string;
			readonly fileName?: string;
			readonly caption?: string;
	  }
	| {
			readonly kind: "document";
			readonly bytes: Uint8Array;
			readonly mimeType: string;
			readonly fileName: string;
			readonly caption?: string;
	  };

/** Outcome returned by the host's outbound media delivery callback. */
export type OutboundMediaDeliveryResult =
	| { readonly ok: true; readonly route: string }
	| { readonly ok: false; readonly reason: string };

/** Options configuring the `"jehee.media"` outbound media delivery extension. */
export type CreateOutboundMediaExtensionOptions = {
	/** Whether to expose `send_media` on the conversation (default `true`). */
	readonly enabled?: boolean;
	/** Optional resolver mapping `$jehee_blob:<id>` handles to raw bytes and MIME type. */
	readonly resolveBlob?: (handle: string) => ResolvedOutboundBlob | undefined;
	/** Channel-layer callback delivering a validated photo or document to the active owner route. */
	readonly deliverMedia: (payload: OutboundMediaPayload, context: Context) => Promise<OutboundMediaDeliveryResult>;
	/** Maximum allowed decoded payload size in bytes (default `10 * 1024 * 1024`). */
	readonly maxBytes?: number;
};

const ALLOWED_PHOTO_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	txt: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	json: "application/json",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	html: "text/html",
	htm: "text/html",
	xml: "application/xml",
	yaml: "text/yaml",
	yml: "text/yaml",
	ics: "text/calendar",
	log: "text/plain",
};

const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"application/pdf": "pdf",
	"text/plain": "txt",
	"text/markdown": "md",
	"application/json": "json",
	"text/csv": "csv",
	"text/html": "html",
	"application/xml": "xml",
	"text/calendar": "ics",
};

function normalizeMimeType(raw: string | undefined): string {
	if (raw === undefined) return "";
	return raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function stripUnsafeFileNameChars(input: string): string {
	let out = "";
	for (let i = 0; i < input.length; i += 1) {
		const code = input.charCodeAt(i);
		// Strip ASCII control chars (CR/LF/NUL/etc.) and quotes to prevent multipart header injection.
		if (code <= 0x1f || code === 0x7f || code === 0x22 || code === 0x27) continue;
		out += input[i]!;
	}
	return out.trim();
}

function sanitizeFileName(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const segment = raw.trim().split(/[\\/]/).at(-1) ?? "";
	const cleaned = stripUnsafeFileNameChars(segment);
	if (cleaned.length === 0 || /^\.+$/.test(cleaned)) {
		return undefined;
	}
	return cleaned;
}

function inferMimeFromFileName(fileName: string | undefined): string | undefined {
	if (fileName === undefined) return undefined;
	const dot = fileName.lastIndexOf(".");
	if (dot <= 0 || dot === fileName.length - 1) return undefined;
	return EXTENSION_TO_MIME[fileName.slice(dot + 1).toLowerCase()];
}

function inferDocumentFileName(mimeType: string): string {
	const ext = MIME_TO_EXTENSION[normalizeMimeType(mimeType)] ?? "bin";
	return `document.${ext}`;
}

function errorResult(error: string, reason: string, details?: JsonObject): ToolExecutionResult {
	return {
		isError: true,
		output: [{ type: "text", text: JSON.stringify({ ok: false, error, reason }) }],
		...(details !== undefined ? { details } : {}),
	};
}

type DecodedBase64Result =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| { readonly ok: false; readonly error: "invalid_base64" | "payload_too_large"; readonly reason: string };

function decodeStrictBase64(raw: string, maxBytes: number): DecodedBase64Result {
	const cleaned = raw.replace(/[\r\n\t ]+/g, "");
	if (cleaned.length === 0) {
		return { ok: false, error: "invalid_base64", reason: "Base64 payload must not be empty." };
	}
	if (cleaned.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
		return { ok: false, error: "invalid_base64", reason: "Invalid base64 payload." };
	}
	if (cleaned.includes("=") && cleaned.length % 4 !== 0) {
		return { ok: false, error: "invalid_base64", reason: "Invalid base64 padding." };
	}
	const unpaddedLength = cleaned.endsWith("==")
		? cleaned.length - 2
		: cleaned.endsWith("=")
			? cleaned.length - 1
			: cleaned.length;
	const estimatedBytes = Math.floor((unpaddedLength * 3) / 4);
	if (estimatedBytes > maxBytes) {
		return {
			ok: false,
			error: "payload_too_large",
			reason: `Media payload (${estimatedBytes} bytes) exceeds maximum allowed size (${maxBytes} bytes).`,
		};
	}
	try {
		const binary = atob(cleaned);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return { ok: true, bytes };
	} catch {
		return { ok: false, error: "invalid_base64", reason: "Invalid base64 payload." };
	}
}

/** Creates the `"jehee.media"` extension exposing the `send_media` tool for outbound photo and document delivery. */
export function createOutboundMediaExtension(options: CreateOutboundMediaExtensionOptions): Extension {
	if (options.enabled === false) {
		return defineExtension({
			name: JEHEE_MEDIA_EXTENSION_NAME,
			tools: [],
		});
	}

	const maxBytes = options.maxBytes ?? DEFAULT_OUTBOUND_MEDIA_MAX_BYTES;
	const textEncoder = new TextEncoder();

	const sendMediaTool = defineTool({
		name: SEND_MEDIA_TOOL,
		description:
			"Send a photo (JPEG/PNG/WebP/GIF) or document (PDF, Markdown, TXT, JSON, CSV, etc.) directly to the user on their active messaging channel. Provide exactly one content source: `blobHandle` (`$jehee_blob:...` from an MCP tool or screenshot), raw `base64`, or UTF-8 `textContent`.",
		parameters: obj({
			kind: oneOf(["photo", "document"], {
				description: "Media delivery kind: 'photo' for raster images or 'document' for downloadable files.",
			}),
			blobHandle: opt(
				str({
					description: "Vault handle (`$jehee_blob:<id>`) previously saved by an MCP tool or screenshot.",
				}),
			),
			base64: opt(
				str({
					description: "Raw Base64-encoded binary payload (without any data URL prefix).",
				}),
			),
			textContent: opt(
				str({
					description: "UTF-8 text content to encode and send as a document (e.g. .md, .txt, .json).",
				}),
			),
			mimeType: opt(
				str({
					description: "Optional MIME type override (e.g. 'image/png', 'application/pdf', 'text/markdown').",
				}),
			),
			fileName: opt(
				str({
					description: "Optional filename shown to the user (e.g. 'screenshot.png', 'report.md').",
				}),
			),
			caption: opt(
				str({
					description: "Optional caption sent alongside the photo or document.",
				}),
			),
		}),
		replay: "unsafe",
		execute: async (args, _api, context): Promise<ToolExecutionResult> => {
			const sourceCount =
				(args.blobHandle !== undefined ? 1 : 0) +
				(args.base64 !== undefined ? 1 : 0) +
				(args.textContent !== undefined ? 1 : 0);

			if (sourceCount === 0) {
				return errorResult(
					"invalid_source",
					"Provide exactly one content source: blobHandle, base64, or textContent.",
				);
			}
			if (sourceCount > 1) {
				return errorResult(
					"invalid_source",
					"Provide only one content source (blobHandle, base64, or textContent), not multiple.",
				);
			}

			const fileName = sanitizeFileName(args.fileName);
			const caption = args.caption !== undefined && args.caption.trim().length > 0 ? args.caption : undefined;
			const explicitMime = normalizeMimeType(args.mimeType);
			const inferredFromName = inferMimeFromFileName(fileName);

			let bytes: Uint8Array;
			let sourceMime = "";

			if (args.blobHandle !== undefined) {
				const handle = args.blobHandle.trim();
				if (handle.length === 0) {
					return errorResult("invalid_blob_handle", "Blob handle must not be empty.");
				}
				if (options.resolveBlob === undefined) {
					return errorResult(
						"blob_resolver_unavailable",
						"Blob handle resolution is not configured on this host.",
					);
				}
				let resolved: ResolvedOutboundBlob | undefined;
				try {
					resolved = options.resolveBlob(handle);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					return errorResult("blob_resolve_failed", `Failed to resolve blob handle "${handle}": ${reason}`);
				}
				if (resolved === undefined) {
					return errorResult("blob_not_found", `Unknown blob handle "${handle}".`);
				}
				bytes = resolved.bytes;
				sourceMime = normalizeMimeType(resolved.mimeType);
			} else if (args.base64 !== undefined) {
				const decoded = decodeStrictBase64(args.base64, maxBytes);
				if (!decoded.ok) {
					return errorResult(decoded.error, decoded.reason);
				}
				bytes = decoded.bytes;
			} else {
				const textContent = args.textContent ?? "";
				// UTF-8 byte length is always >= JS UTF-16 string length; reject before allocating for huge strings.
				if (textContent.length > maxBytes) {
					return errorResult(
						"payload_too_large",
						`Media payload exceeds maximum allowed size (${maxBytes} bytes).`,
						{ maxBytes },
					);
				}
				bytes = textEncoder.encode(textContent);
				sourceMime = inferredFromName ?? "text/plain";
			}

			if (bytes.byteLength === 0) {
				return errorResult("empty_payload", "Media payload must not be empty (0 bytes).");
			}
			if (bytes.byteLength > maxBytes) {
				return errorResult(
					"payload_too_large",
					`Media payload (${bytes.byteLength} bytes) exceeds maximum allowed size (${maxBytes} bytes).`,
					{ bytes: bytes.byteLength, maxBytes },
				);
			}

			let payload: OutboundMediaPayload;
			if (args.kind === "photo") {
				const effectiveMime = explicitMime || sourceMime || inferredFromName || "";
				if (!ALLOWED_PHOTO_MIMES.has(effectiveMime)) {
					return errorResult(
						"unsupported_photo_mime",
						`Photo delivery requires a raster image MIME type (image/jpeg, image/png, image/webp, image/gif); received "${effectiveMime || "unknown"}".`,
						effectiveMime.length > 0 ? { mimeType: effectiveMime } : undefined,
					);
				}
				if (args.textContent !== undefined) {
					return errorResult(
						"invalid_photo_source",
						"Photo delivery requires binary image data via blobHandle or base64, not textContent.",
					);
				}
				payload = {
					kind: "photo",
					bytes,
					mimeType: effectiveMime,
					...(fileName !== undefined ? { fileName } : {}),
					...(caption !== undefined ? { caption } : {}),
				};
			} else {
				const effectiveMime = explicitMime || sourceMime || inferredFromName || "application/octet-stream";
				payload = {
					kind: "document",
					bytes,
					mimeType: effectiveMime,
					fileName: fileName ?? inferDocumentFileName(effectiveMime),
					...(caption !== undefined ? { caption } : {}),
				};
			}

			let delivery: OutboundMediaDeliveryResult;
			try {
				delivery = await options.deliverMedia(payload, context);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return errorResult("delivery_failed", reason, {
					kind: payload.kind,
					mimeType: payload.mimeType,
					bytes: payload.bytes.byteLength,
				});
			}

			if (!delivery.ok) {
				return errorResult("delivery_failed", delivery.reason, {
					kind: payload.kind,
					mimeType: payload.mimeType,
					bytes: payload.bytes.byteLength,
				});
			}

			return {
				output: [
					{
						type: "text",
						text: JSON.stringify({
							ok: true,
							kind: payload.kind,
							route: delivery.route,
							mimeType: payload.mimeType,
							bytes: payload.bytes.byteLength,
							...(payload.fileName !== undefined ? { fileName: payload.fileName } : {}),
						}),
					},
				],
				details: {
					kind: payload.kind,
					route: delivery.route,
					mimeType: payload.mimeType,
					bytes: payload.bytes.byteLength,
				},
			};
		},
	});

	return defineExtension({
		name: JEHEE_MEDIA_EXTENSION_NAME,
		tools: [sendMediaTool],
	});
}
