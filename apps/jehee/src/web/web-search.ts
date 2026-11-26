// Pure Web/Edge-portable `web_search` client backed by TinyFish TinySearch (`GET https://api.search.tinyfish.ai`).
// Zero Node-only dependencies; invokes `fetch` unbound (`this === undefined`) for Cloudflare Workers compatibility.

/** Default TinyFish TinySearch endpoint URL. */
export const DEFAULT_TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";

/** Default per-request timeout in milliseconds (15 seconds). */
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 15_000;

/** Default maximum ranked hits returned to the model per search call. */
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 8;

/** Hard upper cap enforced when callers request custom `maxResults`. */
export const MAX_WEB_SEARCH_RESULTS_CAP = 20;

/** Default maximum characters kept per result snippet to protect context budgets. */
export const DEFAULT_WEB_SEARCH_MAX_SNIPPET_CHARS = 500;

/** Maximum allowed query string length in UTF-16 code units. */
export const MAX_WEB_SEARCH_QUERY_CHARS = 500;

/** Maximum upstream JSON payload read from the search API (512 KiB). */
export const MAX_WEB_SEARCH_RESPONSE_BYTES = 512 * 1024;

/** Supported TinySearch content category filters. */
export type WebSearchDomainType = "web" | "news" | "research_paper";

/** Validated query parameters accepted by `searchWeb`. */
export type WebSearchQueryInput = {
	readonly query: string;
	readonly maxResults?: number;
	readonly domainType?: WebSearchDomainType;
	readonly language?: string;
	readonly location?: string;
	readonly recencyMinutes?: number;
	readonly afterDate?: string;
	readonly beforeDate?: string;
	readonly includeDomains?: readonly string[];
	readonly excludeDomains?: readonly string[];
	readonly page?: number;
};

/** Single normalized web search hit returned to the model. */
export type WebSearchHit = {
	readonly position: number;
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
	readonly siteName?: string;
	readonly date?: string;
};

/** Configuration options controlling the portable `web_search` client. */
export type WebSearchOptions = {
	readonly provider?: "tinyfish";
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly timeoutMs?: number;
	readonly maxResults?: number;
	readonly maxSnippetChars?: number;
	readonly defaultLocation?: string;
	readonly defaultLanguage?: string;
	readonly signal?: AbortSignal;
	readonly fetchImpl?: typeof fetch;
};

/** Discriminated outcome returned by `searchWeb`. */
export type WebSearchResult =
	| {
			readonly ok: true;
			readonly provider: "tinyfish";
			readonly query: string;
			readonly totalResults?: number;
			readonly page?: number;
			readonly results: readonly WebSearchHit[];
			readonly truncatedResults: boolean;
	  }
	| {
			readonly ok: false;
			readonly provider: "tinyfish";
			readonly query: string;
			readonly error:
				| "invalid_query"
				| "missing_api_key"
				| "http_error"
				| "rate_limited"
				| "invalid_response"
				| "timeout"
				| "aborted"
				| "network_error";
			readonly status?: number;
			readonly message: string;
	  };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECENCY_MINUTES = 5_256_000;
const MAX_ERROR_BODY_CHARS = 240;

function sanitizeUpstreamMessage(raw: string, apiKey: string): string {
	const collapsed = raw.replace(/\s+/g, " ").trim();
	const redacted = apiKey.length > 0 ? collapsed.split(apiKey).join("[redacted]") : collapsed;
	if (redacted.length <= MAX_ERROR_BODY_CHARS) return redacted;
	return `${redacted.slice(0, MAX_ERROR_BODY_CHARS)}...`;
}

function normalizeDomainList(domains: readonly string[] | undefined): string[] | undefined {
	if (domains === undefined) return undefined;
	const cleaned = domains.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
	return cleaned.length > 0 ? cleaned : undefined;
}

function truncateSnippet(raw: string, maxChars: number): string {
	const cleaned = raw.replace(/\s+/g, " ").trim();
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, maxChars)}...`;
}

async function readResponseTextBounded(response: Response, maxBytes: number): Promise<string> {
	if (response.body === null) {
		const all = new Uint8Array(await response.arrayBuffer());
		const slice = all.byteLength <= maxBytes ? all : all.subarray(0, maxBytes);
		return new TextDecoder("utf-8", { fatal: false }).decode(slice);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined || value.byteLength === 0) continue;
			const remaining = maxBytes - totalBytes;
			if (remaining <= 0) {
				await reader.cancel().catch(() => undefined);
				break;
			}
			if (value.byteLength <= remaining) {
				chunks.push(value);
				totalBytes += value.byteLength;
			} else {
				chunks.push(value.subarray(0, remaining));
				totalBytes += remaining;
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function parseTinySearchResponse(
	raw: unknown,
	fallbackQuery: string,
	maxResults: number,
	maxSnippetChars: number,
):
	| {
			readonly ok: true;
			readonly query: string;
			readonly totalResults?: number;
			readonly page?: number;
			readonly results: readonly WebSearchHit[];
			readonly truncatedResults: boolean;
	  }
	| { readonly ok: false; readonly message: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, message: "TinySearch response body was not a JSON object." };
	}
	const record = raw as Record<string, unknown>;
	if (!Array.isArray(record.results)) {
		return { ok: false, message: "TinySearch response did not contain a `results` array." };
	}

	const parsedHits: WebSearchHit[] = [];
	for (let i = 0; i < record.results.length; i++) {
		const item = record.results[i];
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const rec = item as Record<string, unknown>;
		const url = typeof rec.url === "string" ? rec.url.trim() : "";
		const title = typeof rec.title === "string" ? rec.title.trim() : "";
		if (url.length === 0 || title.length === 0) continue;

		const rawPos =
			typeof rec.position === "number" && Number.isFinite(rec.position) ? Math.floor(rec.position) : i + 1;
		const rawSnippet = typeof rec.snippet === "string" ? rec.snippet : "";
		const siteName =
			typeof rec.site_name === "string" && rec.site_name.trim().length > 0 ? rec.site_name.trim() : undefined;
		const date = typeof rec.date === "string" && rec.date.trim().length > 0 ? rec.date.trim() : undefined;

		parsedHits.push({
			position: rawPos,
			title,
			url,
			snippet: truncateSnippet(rawSnippet, maxSnippetChars),
			...(siteName !== undefined ? { siteName } : {}),
			...(date !== undefined ? { date } : {}),
		});
	}

	const truncatedResults = parsedHits.length > maxResults;
	const boundedHits = truncatedResults ? parsedHits.slice(0, maxResults) : parsedHits;
	const echoedQuery =
		typeof record.query === "string" && record.query.trim().length > 0 ? record.query.trim() : fallbackQuery;
	const totalResults =
		typeof record.total_results === "number" && Number.isFinite(record.total_results)
			? Math.floor(record.total_results)
			: undefined;
	const page = typeof record.page === "number" && Number.isFinite(record.page) ? Math.floor(record.page) : undefined;

	return {
		ok: true,
		query: echoedQuery,
		...(totalResults !== undefined ? { totalResults } : {}),
		...(page !== undefined ? { page } : {}),
		results: boundedHits,
		truncatedResults,
	};
}

/**
 * Executes a read-only live web search via TinyFish TinySearch (`GET https://api.search.tinyfish.ai`),
 * returning bounded, structured hits suitable for LLM tool results across both Node 24 and Cloudflare Workers.
 */
export async function searchWeb(input: WebSearchQueryInput, options: WebSearchOptions): Promise<WebSearchResult> {
	const query = input.query.trim();
	if (query.length === 0) {
		return {
			ok: false,
			provider: "tinyfish",
			query: "",
			error: "invalid_query",
			message: "Search query must be a non-empty string.",
		};
	}
	if (query.length > MAX_WEB_SEARCH_QUERY_CHARS) {
		return {
			ok: false,
			provider: "tinyfish",
			query: query.slice(0, MAX_WEB_SEARCH_QUERY_CHARS),
			error: "invalid_query",
			message: `Search query exceeds maximum length of ${MAX_WEB_SEARCH_QUERY_CHARS} characters.`,
		};
	}

	const apiKey = options.apiKey.trim();
	if (apiKey.length === 0) {
		return {
			ok: false,
			provider: "tinyfish",
			query,
			error: "missing_api_key",
			message: "TINYFISH_API_KEY is not configured.",
		};
	}

	if (input.afterDate !== undefined && !ISO_DATE_PATTERN.test(input.afterDate.trim())) {
		return {
			ok: false,
			provider: "tinyfish",
			query,
			error: "invalid_query",
			message: `Invalid afterDate "${input.afterDate}": expected YYYY-MM-DD.`,
		};
	}
	if (input.beforeDate !== undefined && !ISO_DATE_PATTERN.test(input.beforeDate.trim())) {
		return {
			ok: false,
			provider: "tinyfish",
			query,
			error: "invalid_query",
			message: `Invalid beforeDate "${input.beforeDate}": expected YYYY-MM-DD.`,
		};
	}
	if (
		input.recencyMinutes !== undefined &&
		(!Number.isInteger(input.recencyMinutes) ||
			input.recencyMinutes < 1 ||
			input.recencyMinutes > MAX_RECENCY_MINUTES)
	) {
		return {
			ok: false,
			provider: "tinyfish",
			query,
			error: "invalid_query",
			message: `Invalid recencyMinutes "${String(input.recencyMinutes)}": expected integer between 1 and ${MAX_RECENCY_MINUTES}.`,
		};
	}
	if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 0)) {
		return {
			ok: false,
			provider: "tinyfish",
			query,
			error: "invalid_query",
			message: `Invalid page "${String(input.page)}": expected non-negative integer.`,
		};
	}

	let endpoint: URL;
	try {
		endpoint = new URL(options.baseUrl?.trim() || DEFAULT_TINYFISH_SEARCH_URL);
	} catch {
		return {
			ok: false,
			provider: "tinyfish",
			query,
			error: "invalid_query",
			message: `Invalid TinyFish search baseUrl "${options.baseUrl ?? ""}".`,
		};
	}

	endpoint.searchParams.set("query", query);
	if (input.domainType !== undefined) {
		endpoint.searchParams.set("domain_type", input.domainType);
	}
	const language = input.language?.trim() || options.defaultLanguage?.trim();
	if (language !== undefined && language.length > 0) {
		endpoint.searchParams.set("language", language);
	}
	const location = input.location?.trim() || options.defaultLocation?.trim();
	if (location !== undefined && location.length > 0) {
		endpoint.searchParams.set("location", location);
	}
	if (input.recencyMinutes !== undefined) {
		endpoint.searchParams.set("recency_minutes", String(input.recencyMinutes));
	}
	if (input.afterDate !== undefined) {
		endpoint.searchParams.set("after_date", input.afterDate.trim());
	}
	if (input.beforeDate !== undefined) {
		endpoint.searchParams.set("before_date", input.beforeDate.trim());
	}
	const includeDomains = normalizeDomainList(input.includeDomains);
	if (includeDomains !== undefined) {
		endpoint.searchParams.set("include_domains", includeDomains.join(","));
	}
	const excludeDomains = normalizeDomainList(input.excludeDomains);
	if (excludeDomains !== undefined) {
		endpoint.searchParams.set("exclude_domains", excludeDomains.join(","));
	}
	if (input.page !== undefined) {
		endpoint.searchParams.set("page", String(input.page));
	}

	const maxResults = Math.min(
		MAX_WEB_SEARCH_RESULTS_CAP,
		Math.max(1, Math.floor(input.maxResults ?? options.maxResults ?? DEFAULT_WEB_SEARCH_MAX_RESULTS)),
	);
	const maxSnippetChars = Math.max(50, Math.floor(options.maxSnippetChars ?? DEFAULT_WEB_SEARCH_MAX_SNIPPET_CHARS));
	const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? DEFAULT_WEB_SEARCH_TIMEOUT_MS));

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new DOMException(`web_search timed out after ${timeoutMs}ms`, "TimeoutError"));
	}, timeoutMs);

	const onOuterAbort = () => {
		controller.abort(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
	};
	if (options.signal !== undefined) {
		if (options.signal.aborted) {
			clearTimeout(timer);
			return {
				ok: false,
				provider: "tinyfish",
				query,
				error: "aborted",
				message: "web_search request was aborted.",
			};
		}
		options.signal.addEventListener("abort", onOuterAbort, { once: true });
	}

	// Never bind `globalThis.fetch` to an object instance: Cloudflare Workers throws `Illegal invocation` otherwise.
	const fetchFn = options.fetchImpl ?? globalThis.fetch;

	try {
		const response = await fetchFn(endpoint.toString(), {
			method: "GET",
			headers: {
				accept: "application/json",
				"X-API-Key": apiKey,
			},
			signal: controller.signal,
		});

		const rawText = await readResponseTextBounded(response, MAX_WEB_SEARCH_RESPONSE_BYTES);
		if (!response.ok) {
			const detail = sanitizeUpstreamMessage(rawText, apiKey);
			return {
				ok: false,
				provider: "tinyfish",
				query,
				error: response.status === 429 ? "rate_limited" : "http_error",
				status: response.status,
				message:
					response.status === 429
						? `TinySearch rate limit exceeded (HTTP 429)${detail.length > 0 ? `: ${detail}` : "."}`
						: `TinySearch returned HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : "."}`,
			};
		}

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(rawText);
		} catch {
			return {
				ok: false,
				provider: "tinyfish",
				query,
				error: "invalid_response",
				message: "TinySearch returned non-JSON payload.",
			};
		}

		const normalized = parseTinySearchResponse(parsedJson, query, maxResults, maxSnippetChars);
		if (!normalized.ok) {
			return {
				ok: false,
				provider: "tinyfish",
				query,
				error: "invalid_response",
				message: normalized.message,
			};
		}

		return {
			ok: true,
			provider: "tinyfish",
			query: normalized.query,
			...(normalized.totalResults !== undefined ? { totalResults: normalized.totalResults } : {}),
			...(normalized.page !== undefined ? { page: normalized.page } : {}),
			results: normalized.results,
			truncatedResults: normalized.truncatedResults,
		};
	} catch (error) {
		if (timedOut) {
			return {
				ok: false,
				provider: "tinyfish",
				query,
				error: "timeout",
				message: `TinySearch timed out after ${timeoutMs}ms.`,
			};
		}
		if (options.signal?.aborted) {
			return {
				ok: false,
				provider: "tinyfish",
				query,
				error: "aborted",
				message: "web_search request was aborted.",
			};
		}
		const rawMsg = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			provider: "tinyfish",
			query,
			error: "network_error",
			message: `TinySearch network error: ${sanitizeUpstreamMessage(rawMsg, apiKey)}`,
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onOuterAbort);
	}
}
