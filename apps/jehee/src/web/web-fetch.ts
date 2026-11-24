// Pure Web/Edge-portable SSRF-guarded HTTP fetcher and HTML-to-readable-text extractor (Node 24 + Cloudflare Workers).

/** Default maximum downloaded response payload size (512 KiB). */
export const DEFAULT_WEB_FETCH_MAX_BYTES = 512 * 1024;

/** Default maximum extracted text length returned to the model (12,000 chars). */
export const DEFAULT_WEB_FETCH_MAX_CHARS = 12_000;

/** Upper cap enforced when callers request custom `maxChars`. */
export const MAX_WEB_FETCH_CHARS_CAP = 50_000;

/** Upper cap enforced when callers request custom `maxBytes` (2 MiB). */
export const MAX_WEB_FETCH_BYTES_CAP = 2 * 1024 * 1024;

/** Default per-request timeout in milliseconds (15 seconds). */
export const DEFAULT_WEB_FETCH_TIMEOUT_MS = 15_000;

/** Default maximum safe HTTP redirect hops followed with SSRF re-validation. */
export const DEFAULT_WEB_FETCH_MAX_REDIRECTS = 5;

const DEFAULT_USER_AGENT = "JeheeWebFetch/1.0 (+https://jehee.local/web-fetch)";

/** Result of validating whether a URL is a public HTTP/HTTPS target permitted by SSRF guardrails. */
export type UrlValidationResult =
	| { readonly ok: true; readonly url: URL }
	| { readonly ok: false; readonly code: "invalid_url" | "ssrf_blocked"; readonly reason: string };

/** Extracted readable text and optional document title from an HTTP text/HTML/JSON body. */
export type ExtractedWebContent = {
	readonly title?: string;
	readonly text: string;
	readonly truncated: boolean;
	readonly totalChars: number;
};

/** Options controlling `fetchWebPage` bounds, timeouts, redirects, and custom fetch injection. */
export type WebFetchOptions = {
	readonly maxBytes?: number;
	readonly maxChars?: number;
	readonly timeoutMs?: number;
	readonly maxRedirects?: number;
	readonly signal?: AbortSignal;
	readonly userAgent?: string;
	readonly fetchImpl?: typeof fetch;
};

/** Discriminated outcome returned by `fetchWebPage`. */
export type WebFetchResult =
	| {
			readonly ok: true;
			readonly url: string;
			readonly finalUrl: string;
			readonly status: number;
			readonly contentType: string;
			readonly title?: string;
			readonly text: string;
			readonly bytesRead: number;
			readonly truncatedBytes: boolean;
			readonly truncatedChars: boolean;
			readonly redirectCount: number;
	  }
	| {
			readonly ok: false;
			readonly url: string;
			readonly error:
				| "invalid_url"
				| "ssrf_blocked"
				| "too_many_redirects"
				| "http_error"
				| "unsupported_content_type"
				| "timeout"
				| "aborted"
				| "network_error";
			readonly status?: number;
			readonly message: string;
	  };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	copy: "©",
	reg: "®",
	trade: "™",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	bull: "•",
};

function parseIpv4Octets(host: string): readonly [number, number, number, number] | undefined {
	const parts = host.split(".");
	if (parts.length !== 4) return undefined;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const val = Number(part);
		if (!Number.isInteger(val) || val < 0 || val > 255) return undefined;
		octets.push(val);
	}
	return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function classifyBlockedIpv4(octets: readonly [number, number, number, number]): string | undefined {
	const [a, b] = octets;
	if (a === 0) return "0.0.0.0/8 (unspecified)";
	if (a === 10) return "10.0.0.0/8 (private RFC1918)";
	if (a === 100 && b >= 64 && b <= 127) return "100.64.0.0/10 (CGNAT)";
	if (a === 127) return "127.0.0.0/8 (loopback)";
	if (a === 169 && b === 254) return "169.254.0.0/16 (link-local/metadata)";
	if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 (private RFC1918)";
	if (a === 192 && b === 168) return "192.168.0.0/16 (private RFC1918)";
	if (a >= 224) return "224.0.0.0/4+ (multicast/reserved)";
	return undefined;
}

function parseIpv6Groups(raw: string): readonly number[] | undefined {
	const withoutZone = raw.split("%", 1)[0] ?? "";
	if (withoutZone.length === 0) return undefined;

	// Normalize optional embedded dotted IPv4 tail (e.g. `::ffff:127.0.0.1`).
	let candidate = withoutZone;
	const lastColon = candidate.lastIndexOf(":");
	if (lastColon !== -1 && candidate.slice(lastColon + 1).includes(".")) {
		const ipv4 = parseIpv4Octets(candidate.slice(lastColon + 1));
		if (ipv4 === undefined) return undefined;
		const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
		const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
		candidate = `${candidate.slice(0, lastColon + 1)}${hi}:${lo}`;
	}

	const doubleColonParts = candidate.split("::");
	if (doubleColonParts.length > 2) return undefined;

	const parseHalf = (segment: string): number[] | undefined => {
		if (segment.length === 0) return [];
		const tokens = segment.split(":");
		const parsed: number[] = [];
		for (const token of tokens) {
			if (!/^[0-9a-f]{1,4}$/i.test(token)) return undefined;
			parsed.push(Number.parseInt(token, 16));
		}
		return parsed;
	};

	if (doubleColonParts.length === 1) {
		const groups = parseHalf(doubleColonParts[0]!);
		return groups !== undefined && groups.length === 8 ? groups : undefined;
	}

	const left = parseHalf(doubleColonParts[0]!);
	const right = parseHalf(doubleColonParts[1]!);
	if (left === undefined || right === undefined) return undefined;
	const missing = 8 - (left.length + right.length);
	if (missing < 1) return undefined;
	return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function classifyBlockedIpv6(groups: readonly number[]): string | undefined {
	const isAllZeroPrefix = (count: number) => {
		for (let i = 0; i < count; i++) {
			if (groups[i] !== 0) return false;
		}
		return true;
	};

	if (isAllZeroPrefix(8)) return ":: (unspecified IPv6)";
	if (isAllZeroPrefix(7) && groups[7] === 1) return "::1 (IPv6 loopback)";
	if (isAllZeroPrefix(6)) return "::/96 (deprecated IPv4-compatible IPv6)";

	const g0 = groups[0]!;
	if (g0 === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) {
		return "100::/64 (IPv6 discard-only)";
	}
	if ((g0 & 0xfe00) === 0xfc00) return "fc00::/7 (IPv6 unique local)";
	if ((g0 & 0xffc0) === 0xfe80) return "fe80::/10 (IPv6 link-local)";
	if ((g0 & 0xffc0) === 0xfec0) return "fec0::/10 (deprecated IPv6 site-local)";
	if ((g0 & 0xff00) === 0xff00) return "ff00::/8 (IPv6 multicast)";

	// Block IPv4-translated (`::ffff:0:0:0/96`) and local-use NAT64 (`64:ff9b:1::/48`) prefixes outright.
	if (isAllZeroPrefix(4) && groups[4] === 0xffff && groups[5] === 0) {
		return "::ffff:0:0:0/96 (IPv4-translated IPv6)";
	}
	if (g0 === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) {
		return "64:ff9b:1::/48 (local-use NAT64)";
	}

	// Check 6to4 (`2002::/16`) embedded IPv4 in groups[1..2].
	if (g0 === 0x2002) {
		const g1 = groups[1]!;
		const g2 = groups[2]!;
		const embedded6to4: readonly [number, number, number, number] = [
			(g1 >> 8) & 0xff,
			g1 & 0xff,
			(g2 >> 8) & 0xff,
			g2 & 0xff,
		];
		const v4Reason = classifyBlockedIpv4(embedded6to4);
		if (v4Reason !== undefined) {
			return `6to4-embedded ${v4Reason}`;
		}
	}

	// Check IPv4-mapped IPv6 (`::ffff:0:0/96`) and NAT64 well-known prefix (`64:ff9b::/96`).
	const isIpv4Mapped = isAllZeroPrefix(5) && groups[5] === 0xffff;
	const isNat64 =
		g0 === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0;
	if (isIpv4Mapped || isNat64) {
		const g6 = groups[6]!;
		const g7 = groups[7]!;
		const mappedOctets: readonly [number, number, number, number] = [
			(g6 >> 8) & 0xff,
			g6 & 0xff,
			(g7 >> 8) & 0xff,
			g7 & 0xff,
		];
		const v4Reason = classifyBlockedIpv4(mappedOctets);
		if (v4Reason !== undefined) {
			return `IPv6-embedded ${v4Reason}`;
		}
	}

	return undefined;
}

/**
 * Validates that `rawUrl` is a syntactically valid public `http:` or `https:` URL and does not target localhost,
 * `.local`/`.internal` domains, or private/loopback/link-local/CGNAT/metadata IPv4 or IPv6 addresses.
 */
export function validatePublicHttpUrl(rawUrl: string): UrlValidationResult {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl.trim());
	} catch {
		return { ok: false, code: "invalid_url", reason: `Invalid URL: "${rawUrl}"` };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return {
			ok: false,
			code: "ssrf_blocked",
			reason: `Unsupported URL protocol "${parsed.protocol}"; only http: and https: are allowed.`,
		};
	}

	const rawHost = parsed.hostname.toLowerCase();
	if (rawHost.length === 0) {
		return { ok: false, code: "invalid_url", reason: "URL hostname is empty." };
	}

	if (rawHost.startsWith("[") && rawHost.endsWith("]")) {
		const ipv6Literal = rawHost.slice(1, -1);
		const groups = parseIpv6Groups(ipv6Literal);
		if (groups === undefined) {
			return { ok: false, code: "invalid_url", reason: `Malformed IPv6 address: "${rawHost}"` };
		}
		const blockedV6 = classifyBlockedIpv6(groups);
		if (blockedV6 !== undefined) {
			return {
				ok: false,
				code: "ssrf_blocked",
				reason: `Blocked non-public IPv6 host "${rawHost}" (${blockedV6}).`,
			};
		}
		return { ok: true, url: parsed };
	}

	const host = rawHost.replace(/\.+$/, "");
	if (host.length === 0) {
		return { ok: false, code: "invalid_url", reason: "URL hostname is empty." };
	}

	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return {
			ok: false,
			code: "ssrf_blocked",
			reason: `Blocked private/internal hostname "${host}".`,
		};
	}

	const ipv4 = parseIpv4Octets(host);
	if (ipv4 !== undefined) {
		const blockedV4 = classifyBlockedIpv4(ipv4);
		if (blockedV4 !== undefined) {
			return {
				ok: false,
				code: "ssrf_blocked",
				reason: `Blocked non-public IPv4 host "${host}" (${blockedV4}).`,
			};
		}
	}

	return { ok: true, url: parsed };
}

function decodeHtmlEntities(input: string): string {
	return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const codePoint = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
				? String.fromCodePoint(codePoint)
				: full;
		}
		if (body.startsWith("#")) {
			const codePoint = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
				? String.fromCodePoint(codePoint)
				: full;
		}
		const named = NAMED_HTML_ENTITIES[body.toLowerCase()];
		return named !== undefined ? named : full;
	});
}

function normalizeWhitespace(input: string): string {
	return input
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function truncateText(
	text: string,
	maxChars: number,
): { readonly text: string; readonly truncated: boolean; readonly totalChars: number } {
	const totalChars = text.length;
	if (totalChars <= maxChars) {
		return { text, truncated: false, totalChars };
	}
	return {
		text: `${text.slice(0, maxChars)}\n...[truncated]`,
		truncated: true,
		totalChars,
	};
}

function normalizeContentType(raw: string | null | undefined): string {
	if (raw === null || raw === undefined) return "";
	return raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isSupportedWebContentType(mime: string): boolean {
	if (mime.length === 0) return true;
	return (
		mime === "text/html" ||
		mime === "application/xhtml+xml" ||
		mime === "text/plain" ||
		mime === "text/markdown" ||
		mime === "text/x-markdown" ||
		mime === "text/csv" ||
		mime === "application/json" ||
		mime.endsWith("+json") ||
		mime === "application/xml" ||
		mime === "text/xml"
	);
}

/**
 * Extracts bounded readable text (and `<title>` for HTML) from HTML, plain text, Markdown, CSV, XML, or JSON bodies.
 * Strips `<script>`, `<style>`, `<noscript>`, `<svg>`, `<template>`, and HTML comments, decodes entities, and collapses whitespace.
 */
export function extractReadableWebText(
	rawBody: string,
	contentType: string,
	maxChars: number = DEFAULT_WEB_FETCH_MAX_CHARS,
): ExtractedWebContent {
	const clampedMax = Math.max(1, Math.floor(maxChars));
	const mime = normalizeContentType(contentType);

	if (mime === "application/json" || mime.endsWith("+json")) {
		let formatted = rawBody.trim();
		try {
			formatted = JSON.stringify(JSON.parse(rawBody), null, 2);
		} catch {
			// Keep raw text when upstream sends malformed JSON.
		}
		const bounded = truncateText(formatted, clampedMax);
		return { text: bounded.text, truncated: bounded.truncated, totalChars: bounded.totalChars };
	}

	const looksHtml =
		mime === "text/html" ||
		mime === "application/xhtml+xml" ||
		(mime.length === 0 && /<(?:!doctype\s+html|html|head|body|title|p|div)\b/i.test(rawBody.slice(0, 1024)));

	if (!looksHtml) {
		const cleaned = normalizeWhitespace(rawBody);
		const bounded = truncateText(cleaned, clampedMax);
		return { text: bounded.text, truncated: bounded.truncated, totalChars: bounded.totalChars };
	}

	const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(rawBody);
	const titleRaw = titleMatch?.[1];
	const title = titleRaw !== undefined ? normalizeWhitespace(decodeHtmlEntities(titleRaw)) : undefined;

	const stripped = rawBody
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
		.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<hr\s*\/?>/gi, "\n")
		.replace(
			/<\/(?:p|div|section|article|main|header|footer|nav|aside|h[1-6]|li|tr|blockquote|pre|ul|ol|dl|dt|dd|figure|figcaption)>/gi,
			"\n",
		)
		.replace(/<(?:td|th)\b[^>]*>/gi, " ")
		.replace(/<[^>]+>/g, " ");

	const decoded = normalizeWhitespace(decodeHtmlEntities(stripped));
	const bounded = truncateText(decoded, clampedMax);
	return {
		...(title !== undefined && title.length > 0 ? { title } : {}),
		text: bounded.text,
		truncated: bounded.truncated,
		totalChars: bounded.totalChars,
	};
}

async function readResponseBytesBounded(
	response: Response,
	maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncatedBytes: boolean }> {
	if (response.body === null) {
		const all = new Uint8Array(await response.arrayBuffer());
		if (all.byteLength <= maxBytes) {
			return { bytes: all, truncatedBytes: false };
		}
		return { bytes: all.subarray(0, maxBytes), truncatedBytes: true };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let truncatedBytes = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined || value.byteLength === 0) continue;
			const remaining = maxBytes - totalBytes;
			if (value.byteLength > remaining) {
				if (remaining > 0) {
					chunks.push(value.subarray(0, remaining));
					totalBytes += remaining;
				}
				truncatedBytes = true;
				await reader.cancel().catch(() => undefined);
				break;
			}
			chunks.push(value);
			totalBytes += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes: combined, truncatedBytes };
}

/**
 * Fetches a public HTTP/HTTPS page with strict SSRF guards across manual redirect hops, bounded byte download,
 * timeout/abort propagation, and readable text extraction. Compatible with both Cloudflare Workers and Node 24.
 */
export async function fetchWebPage(rawUrl: string, options?: WebFetchOptions): Promise<WebFetchResult> {
	const initialCheck = validatePublicHttpUrl(rawUrl);
	if (!initialCheck.ok) {
		return {
			ok: false,
			url: rawUrl,
			error: initialCheck.code,
			message: initialCheck.reason,
		};
	}

	const maxBytes = Math.max(
		1024,
		Math.min(Math.floor(options?.maxBytes ?? DEFAULT_WEB_FETCH_MAX_BYTES), MAX_WEB_FETCH_BYTES_CAP),
	);
	const maxChars = Math.max(
		100,
		Math.min(Math.floor(options?.maxChars ?? DEFAULT_WEB_FETCH_MAX_CHARS), MAX_WEB_FETCH_CHARS_CAP),
	);
	const timeoutMs = Math.max(100, Math.floor(options?.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS));
	const maxRedirects = Math.max(0, Math.min(Math.floor(options?.maxRedirects ?? DEFAULT_WEB_FETCH_MAX_REDIRECTS), 10));
	const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;

	// Wrap fetch in a standalone arrow so Cloudflare Workers `globalThis.fetch` is never called with a receiver.
	const customFetch = options?.fetchImpl;
	const fetchFn: typeof fetch =
		customFetch !== undefined
			? (input, init) => customFetch(input, init)
			: (input, init) => globalThis.fetch(input, init);

	const controller = new AbortController();
	let timedOut = false;
	const onCallerAbort = () => {
		controller.abort(options?.signal?.reason);
	};
	if (options?.signal !== undefined) {
		if (options.signal.aborted) {
			return { ok: false, url: rawUrl, error: "aborted", message: "Request was aborted before execution." };
		}
		options.signal.addEventListener("abort", onCallerAbort, { once: true });
	}
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new DOMException(`Timed out after ${timeoutMs}ms`, "TimeoutError"));
	}, timeoutMs);

	try {
		let currentUrl = initialCheck.url;
		let redirectCount = 0;

		while (true) {
			const response = await fetchFn(currentUrl.toString(), {
				method: "GET",
				redirect: "manual",
				signal: controller.signal,
				headers: {
					accept: "text/html, text/markdown, text/plain, application/json;q=0.9, application/xml;q=0.8, */*;q=0.1",
					"user-agent": userAgent,
				},
			});

			if (REDIRECT_STATUSES.has(response.status)) {
				const location = response.headers.get("location");
				await response.body?.cancel().catch(() => undefined);
				if (location === null || location.trim().length === 0) {
					return {
						ok: false,
						url: rawUrl,
						error: "http_error",
						status: response.status,
						message: `Redirect response (${response.status}) missing Location header.`,
					};
				}
				if (redirectCount >= maxRedirects) {
					return {
						ok: false,
						url: rawUrl,
						error: "too_many_redirects",
						status: response.status,
						message: `Exceeded maximum redirect limit (${maxRedirects}).`,
					};
				}
				let resolvedNext: string;
				try {
					resolvedNext = new URL(location, currentUrl).toString();
				} catch {
					return {
						ok: false,
						url: rawUrl,
						error: "invalid_url",
						message: `Invalid redirect target "${location}".`,
					};
				}
				const hopCheck = validatePublicHttpUrl(resolvedNext);
				if (!hopCheck.ok) {
					return {
						ok: false,
						url: rawUrl,
						error: hopCheck.code,
						message: `Redirect blocked: ${hopCheck.reason}`,
					};
				}
				currentUrl = hopCheck.url;
				redirectCount += 1;
				continue;
			}

			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				return {
					ok: false,
					url: rawUrl,
					error: "http_error",
					status: response.status,
					message: `HTTP request failed with status ${response.status} ${response.statusText}`.trim(),
				};
			}

			const rawContentType = response.headers.get("content-type") ?? "";
			const mime = normalizeContentType(rawContentType);
			if (!isSupportedWebContentType(mime)) {
				await response.body?.cancel().catch(() => undefined);
				return {
					ok: false,
					url: rawUrl,
					error: "unsupported_content_type",
					status: response.status,
					message: `Unsupported content-type "${mime}" for readable web fetch.`,
				};
			}

			const { bytes, truncatedBytes } = await readResponseBytesBounded(response, maxBytes);
			const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
			const extracted = extractReadableWebText(decoded, mime, maxChars);

			return {
				ok: true,
				url: rawUrl,
				finalUrl: currentUrl.toString(),
				status: response.status,
				contentType: mime || "text/plain",
				...(extracted.title !== undefined ? { title: extracted.title } : {}),
				text: extracted.text,
				bytesRead: bytes.byteLength,
				truncatedBytes,
				truncatedChars: extracted.truncated,
				redirectCount,
			};
		}
	} catch (error) {
		if (timedOut) {
			return {
				ok: false,
				url: rawUrl,
				error: "timeout",
				message: `Web fetch timed out after ${timeoutMs}ms.`,
			};
		}
		if (options?.signal?.aborted) {
			return {
				ok: false,
				url: rawUrl,
				error: "aborted",
				message: "Web fetch was aborted.",
			};
		}
		return {
			ok: false,
			url: rawUrl,
			error: "network_error",
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
		options?.signal?.removeEventListener("abort", onCallerAbort);
	}
}
