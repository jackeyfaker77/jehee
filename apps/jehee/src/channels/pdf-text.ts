// Pure Web/Edge-portable PDF text extractor (Node 24 + Cloudflare Workers `workerd`, zero Node/npm dependencies).
// Supports uncompressed and `/FlateDecode` streams (via Web `DecompressionStream`), font-scoped `/ToUnicode` CMaps
// (`beginbfchar`/`beginbfrange`) for CJK/Unicode text, UTF-16BE BOM strings, and zip-bomb / encryption / scanned-PDF guards.

/** Default maximum extracted text characters returned from a PDF document. */
export const DEFAULT_PDF_MAX_CHARS = 12_000;

/** Maximum decompressed byte budget per individual PDF stream (2 MiB, zip-bomb defense). */
export const MAX_PDF_STREAM_DECOMPRESSED_BYTES = 2 * 1024 * 1024;

/** Maximum total decompressed bytes across all streams in a single PDF (4 MiB, zip-bomb defense). */
export const MAX_PDF_TOTAL_DECOMPRESSED_BYTES = 4 * 1024 * 1024;

/** Maximum number of streams inspected per PDF file. */
export const MAX_PDF_STREAMS_SCANNED = 256;

/** Options controlling PDF text extraction bounds. */
export type PdfExtractOptions = {
	readonly maxChars?: number;
	readonly maxDecompressedStreamBytes?: number;
	readonly maxTotalDecompressedBytes?: number;
};

/** Discriminated result returned by `extractPdfText`. */
export type PdfExtractResult =
	| {
			readonly ok: true;
			readonly text: string;
			readonly truncated: boolean;
			readonly totalChars: number;
			readonly streamCount: number;
	  }
	| {
			readonly ok: false;
			readonly reason: "invalid_pdf" | "encrypted" | "no_text_layer";
			readonly message: string;
	  };

type PdfObjectStream = {
	readonly objectId?: number;
	readonly dict: string;
	readonly rawBytes: Uint8Array;
};

type UnicodeCMap = {
	readonly entries: Map<string, string>;
	readonly codeByteLengths: readonly number[];
};

const LATIN1_DECODER = new TextDecoder("latin1");

function indexOfAscii(haystack: Uint8Array, needle: string, start: number): number {
	const needleLen = needle.length;
	if (needleLen === 0 || start + needleLen > haystack.byteLength) return -1;
	const first = needle.charCodeAt(0);
	outer: for (let i = start; i <= haystack.byteLength - needleLen; i++) {
		if (haystack[i] !== first) continue;
		for (let j = 1; j < needleLen; j++) {
			if (haystack[i + j] !== needle.charCodeAt(j)) continue outer;
		}
		return i;
	}
	return -1;
}

function decodeLatin1(bytes: Uint8Array): string {
	return LATIN1_DECODER.decode(bytes);
}

function decodeUtf16Be(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
		const codeUnit = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
		out += String.fromCharCode(codeUnit);
	}
	return out;
}

function hexToBytes(hex: string): Uint8Array {
	const cleaned = hex.replace(/\s+/g, "");
	const padded = cleaned.length % 2 === 1 ? `${cleaned}0` : cleaned;
	const out = new Uint8Array(padded.length / 2);
	for (let i = 0; i < out.byteLength; i++) {
		const byte = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
		out[i] = Number.isFinite(byte) ? byte : 0;
	}
	return out;
}

function hexToUnicodeString(hex: string): string {
	const bytes = hexToBytes(hex);
	if (bytes.byteLength === 0) return "";
	if (bytes.byteLength === 1) return String.fromCharCode(bytes[0]!);
	if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		return decodeUtf16Be(bytes.subarray(2));
	}
	return decodeUtf16Be(bytes);
}

function bytesToUpperHex(bytes: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		hex += bytes[i]!.toString(16).toUpperCase().padStart(2, "0");
	}
	return hex;
}

async function decompressWithFormat(
	input: Uint8Array,
	format: "deflate" | "deflate-raw",
	maxBytes: number,
): Promise<Uint8Array | undefined> {
	if (typeof DecompressionStream !== "function") return undefined;
	const ds = new DecompressionStream(format);
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();

	const writePromise = (async () => {
		try {
			await writer.write(new Uint8Array(input));
			await writer.close();
		} catch {
			// Swallow write/close errors when PDF streams have trailing padding or early reader cancellation.
		}
	})();

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
	} catch {
		// Real-world PDFs frequently include trailing CR/LF bytes after zlib EOF; retain already-emitted bytes if any.
	} finally {
		reader.releaseLock();
		await writePromise;
	}

	if (totalBytes === 0) return undefined;
	const merged = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

async function decodeFlateStream(rawBytes: Uint8Array, maxBytes: number): Promise<Uint8Array | undefined> {
	// Trim optional leading/trailing whitespace if the PDF producer padded inside stream boundaries.
	const primary = await decompressWithFormat(rawBytes, "deflate", maxBytes);
	if (primary !== undefined) return primary;
	return decompressWithFormat(rawBytes, "deflate-raw", maxBytes);
}

function parseObjectStreams(pdfBytes: Uint8Array): PdfObjectStream[] {
	const streams: PdfObjectStream[] = [];
	let cursor = 0;

	while (cursor < pdfBytes.byteLength && streams.length < MAX_PDF_STREAMS_SCANNED) {
		const streamIdx = indexOfAscii(pdfBytes, "stream", cursor);
		if (streamIdx === -1) break;

		// Ensure `stream` is a standalone keyword followed by LF or CRLF (not `endstream` or part of a name).
		const prevByte = streamIdx > 0 ? pdfBytes[streamIdx - 1] : 0x20;
		const isStandalone =
			prevByte === 0x20 || prevByte === 0x0a || prevByte === 0x0d || prevByte === 0x09 || prevByte === 0x3e; // '>' from '>>stream'
		const afterKeyword = streamIdx + 6;
		let dataStart = -1;
		if (isStandalone) {
			if (pdfBytes[afterKeyword] === 0x0d && pdfBytes[afterKeyword + 1] === 0x0a) {
				dataStart = afterKeyword + 2;
			} else if (pdfBytes[afterKeyword] === 0x0a) {
				dataStart = afterKeyword + 1;
			} else if (pdfBytes[afterKeyword] === 0x0d) {
				dataStart = afterKeyword + 1;
			}
		}

		if (dataStart === -1) {
			cursor = afterKeyword;
			continue;
		}

		const endIdx = indexOfAscii(pdfBytes, "endstream", dataStart);
		if (endIdx === -1) break;

		let dataEnd = endIdx;
		if (dataEnd > dataStart && pdfBytes[dataEnd - 1] === 0x0a) dataEnd -= 1;
		if (dataEnd > dataStart && pdfBytes[dataEnd - 1] === 0x0d) dataEnd -= 1;

		const headerStart = Math.max(0, streamIdx - 4096);
		const headerText = decodeLatin1(pdfBytes.subarray(headerStart, streamIdx));
		const dictEnd = headerText.lastIndexOf(">>");
		const dictStart = dictEnd !== -1 ? headerText.lastIndexOf("<<", dictEnd) : -1;
		const dict = dictStart !== -1 && dictEnd !== -1 ? headerText.slice(dictStart, dictEnd + 2) : "";

		// Find nearest enclosing `<objNum> <gen> obj` declaration before the stream dictionary.
		let objectId: number | undefined;
		const objMatches = [...headerText.matchAll(/\b(\d+)\s+\d+\s+obj\b/g)];
		const lastObj = objMatches.at(-1);
		if (lastObj?.[1] !== undefined) {
			const parsed = Number.parseInt(lastObj[1], 10);
			if (Number.isInteger(parsed)) objectId = parsed;
		}

		streams.push({
			...(objectId !== undefined ? { objectId } : {}),
			dict,
			rawBytes: pdfBytes.subarray(dataStart, dataEnd),
		});
		cursor = endIdx + 9;
	}

	return streams;
}

function parseToUnicodeCMap(cmapText: string): UnicodeCMap | undefined {
	if (!cmapText.includes("beginbfchar") && !cmapText.includes("beginbfrange")) {
		return undefined;
	}
	const entries = new Map<string, string>();
	const byteLengths = new Set<number>();

	const bfcharBlocks = cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g);
	for (const block of bfcharBlocks) {
		const body = block[1] ?? "";
		for (const match of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
			const srcHex = match[1]!.toUpperCase();
			const dstHex = match[2]!;
			const decoded = hexToUnicodeString(dstHex);
			if (decoded.length > 0) {
				entries.set(srcHex, decoded);
				if (srcHex.length >= 2 && srcHex.length % 2 === 0) {
					byteLengths.add(srcHex.length / 2);
				}
			}
		}
	}

	const bfrangeBlocks = cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g);
	for (const block of bfrangeBlocks) {
		const body = block[1] ?? "";
		// Array destination form: `<start> <end> [<dst1> <dst2> ...]`
		for (const match of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
			const startHex = match[1]!.toUpperCase();
			const endHex = match[2]!.toUpperCase();
			const startVal = Number.parseInt(startHex, 16);
			const endVal = Number.parseInt(endHex, 16);
			if (!Number.isFinite(startVal) || !Number.isFinite(endVal) || endVal < startVal || endVal - startVal > 2048) {
				continue;
			}
			const hexWidth = startHex.length;
			const dstList = [...(match[3] ?? "").matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => m[1]!);
			for (let offset = 0; offset < dstList.length && startVal + offset <= endVal; offset++) {
				const srcKey = (startVal + offset).toString(16).toUpperCase().padStart(hexWidth, "0");
				const decoded = hexToUnicodeString(dstList[offset]!);
				if (decoded.length > 0) {
					entries.set(srcKey, decoded);
					if (hexWidth >= 2 && hexWidth % 2 === 0) byteLengths.add(hexWidth / 2);
				}
			}
		}

		// Scalar increment destination form: `<start> <end> <dstStart>`
		for (const match of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
			const startHex = match[1]!.toUpperCase();
			const endHex = match[2]!.toUpperCase();
			const dstStartHex = match[3]!.toUpperCase();
			const startVal = Number.parseInt(startHex, 16);
			const endVal = Number.parseInt(endHex, 16);
			const dstStartVal = Number.parseInt(dstStartHex, 16);
			if (
				!Number.isFinite(startVal) ||
				!Number.isFinite(endVal) ||
				!Number.isFinite(dstStartVal) ||
				endVal < startVal ||
				endVal - startVal > 4096
			) {
				continue;
			}
			const srcHexWidth = startHex.length;
			const dstHexWidth = Math.max(4, dstStartHex.length);
			for (let code = startVal; code <= endVal; code++) {
				const srcKey = code.toString(16).toUpperCase().padStart(srcHexWidth, "0");
				const dstCode = dstStartVal + (code - startVal);
				const dstHex = dstCode.toString(16).toUpperCase().padStart(dstHexWidth, "0");
				const decoded = hexToUnicodeString(dstHex);
				if (decoded.length > 0) {
					entries.set(srcKey, decoded);
					if (srcHexWidth >= 2 && srcHexWidth % 2 === 0) byteLengths.add(srcHexWidth / 2);
				}
			}
		}
	}

	if (entries.size === 0) return undefined;
	return {
		entries,
		codeByteLengths: [...byteLengths].sort((a, b) => b - a),
	};
}

function buildFontToCMapIndex(
	rawPdfAscii: string,
	cmapsByObjId: ReadonlyMap<number, UnicodeCMap>,
): ReadonlyMap<string, UnicodeCMap> {
	if (cmapsByObjId.size === 0) return new Map();

	// Map `<fontObjId> -> <toUnicodeObjId>`
	const fontObjToCMap = new Map<number, UnicodeCMap>();
	for (const match of rawPdfAscii.matchAll(/\b(\d+)\s+\d+\s+obj\b([\s\S]{0,4000}?)\bendobj\b/g)) {
		const objId = Number.parseInt(match[1]!, 10);
		const body = match[2] ?? "";
		const toUni = /\/ToUnicode\s+(\d+)\s+\d+\s+R\b/.exec(body);
		if (toUni?.[1] !== undefined) {
			const cmapObjId = Number.parseInt(toUni[1], 10);
			const cmap = cmapsByObjId.get(cmapObjId);
			if (cmap !== undefined) {
				fontObjToCMap.set(objId, cmap);
			}
		}
	}

	// Map font resource alias (`/F1`, `/TT0`, etc.) -> CMap via `/Font << /F1 <fontObjId> 0 R ... >>`
	const fontNameToCMap = new Map<string, UnicodeCMap>();
	for (const match of rawPdfAscii.matchAll(/\/([A-Za-z0-9_+-]+)\s+(\d+)\s+\d+\s+R\b/g)) {
		const alias = match[1]!;
		const targetObjId = Number.parseInt(match[2]!, 10);
		const cmap = fontObjToCMap.get(targetObjId);
		if (cmap !== undefined && !fontNameToCMap.has(alias)) {
			fontNameToCMap.set(alias, cmap);
		}
	}
	return fontNameToCMap;
}

function mergeCMaps(cmaps: Iterable<UnicodeCMap>): UnicodeCMap | undefined {
	const entries = new Map<string, string>();
	const lengths = new Set<number>();
	for (const cmap of cmaps) {
		for (const [k, v] of cmap.entries) {
			if (!entries.has(k)) entries.set(k, v);
		}
		for (const len of cmap.codeByteLengths) {
			lengths.add(len);
		}
	}
	if (entries.size === 0) return undefined;
	return { entries, codeByteLengths: [...lengths].sort((a, b) => b - a) };
}

function decodeBytesWithCMap(bytes: Uint8Array, cmap: UnicodeCMap | undefined): string {
	if (bytes.byteLength === 0) return "";
	if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		return decodeUtf16Be(bytes.subarray(2));
	}
	if (cmap !== undefined && cmap.entries.size > 0) {
		let out = "";
		let matchedAny = false;
		let i = 0;
		while (i < bytes.byteLength) {
			let matched = false;
			for (const len of cmap.codeByteLengths) {
				if (i + len <= bytes.byteLength) {
					const hex = bytesToUpperHex(bytes.subarray(i, i + len));
					const mapped = cmap.entries.get(hex);
					if (mapped !== undefined) {
						out += mapped;
						i += len;
						matched = true;
						matchedAny = true;
						break;
					}
				}
			}
			if (!matched) {
				const b = bytes[i]!;
				if (b >= 0x20 && b <= 0x7e) {
					out += String.fromCharCode(b);
				}
				i += 1;
			}
		}
		if (matchedAny) return out;
	}
	return decodeLatin1(bytes);
}

function parsePdfLiteralString(
	source: string,
	openParenIdx: number,
): { readonly bytes: Uint8Array; readonly nextIdx: number } {
	const out: number[] = [];
	let depth = 1;
	let i = openParenIdx + 1;
	while (i < source.length && depth > 0) {
		const ch = source[i]!;
		if (ch === "\\") {
			const next = source[i + 1];
			if (next === undefined) break;
			if (next === "n") {
				out.push(0x0a);
				i += 2;
			} else if (next === "r") {
				out.push(0x0d);
				i += 2;
			} else if (next === "t") {
				out.push(0x09);
				i += 2;
			} else if (next === "b") {
				out.push(0x08);
				i += 2;
			} else if (next === "f") {
				out.push(0x0c);
				i += 2;
			} else if (next === "(" || next === ")" || next === "\\") {
				out.push(next.charCodeAt(0));
				i += 2;
			} else if (next === "\r") {
				i += source[i + 2] === "\n" ? 3 : 2;
			} else if (next === "\n") {
				i += 2;
			} else if (next >= "0" && next <= "7") {
				let oct = next;
				let step = 2;
				if (source[i + 2] !== undefined && source[i + 2]! >= "0" && source[i + 2]! <= "7") {
					oct += source[i + 2]!;
					step += 1;
					if (source[i + 3] !== undefined && source[i + 3]! >= "0" && source[i + 3]! <= "7") {
						oct += source[i + 3]!;
						step += 1;
					}
				}
				out.push(Number.parseInt(oct, 8) & 0xff);
				i += step;
			} else {
				out.push(next.charCodeAt(0) & 0xff);
				i += 2;
			}
			continue;
		}
		if (ch === "(") {
			depth += 1;
			out.push(0x28);
			i += 1;
			continue;
		}
		if (ch === ")") {
			depth -= 1;
			if (depth > 0) out.push(0x29);
			i += 1;
			continue;
		}
		out.push(ch.charCodeAt(0) & 0xff);
		i += 1;
	}
	return { bytes: new Uint8Array(out), nextIdx: i };
}

type PdfToken =
	| { readonly kind: "string"; readonly bytes: Uint8Array }
	| {
			readonly kind: "array";
			readonly items: readonly (PdfToken | { readonly kind: "number"; readonly value: number })[];
	  }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "name"; readonly value: string }
	| { readonly kind: "op"; readonly value: string };

function tokenizeContentBlock(block: string): PdfToken[] {
	const tokens: PdfToken[] = [];
	let i = 0;

	const skipWsAndComments = () => {
		while (i < block.length) {
			const ch = block[i]!;
			if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\0") {
				i += 1;
				continue;
			}
			if (ch === "%") {
				while (i < block.length && block[i] !== "\n" && block[i] !== "\r") i += 1;
				continue;
			}
			break;
		}
	};

	const readSingle = (): PdfToken | undefined => {
		skipWsAndComments();
		if (i >= block.length) return undefined;
		const ch = block[i]!;
		if (ch === "(") {
			const parsed = parsePdfLiteralString(block, i);
			i = parsed.nextIdx;
			return { kind: "string", bytes: parsed.bytes };
		}
		if (ch === "<") {
			if (block[i + 1] === "<") {
				// Skip inline dictionary `<< ... >>`.
				const close = block.indexOf(">>", i + 2);
				i = close === -1 ? block.length : close + 2;
				return undefined;
			}
			const close = block.indexOf(">", i + 1);
			if (close === -1) {
				i = block.length;
				return undefined;
			}
			const hex = block.slice(i + 1, close);
			i = close + 1;
			return { kind: "string", bytes: hexToBytes(hex) };
		}
		if (ch === "[") {
			i += 1;
			const items: Array<PdfToken | { readonly kind: "number"; readonly value: number }> = [];
			while (i < block.length) {
				skipWsAndComments();
				if (i >= block.length || block[i] === "]") {
					i += 1;
					break;
				}
				const item = readSingle();
				if (item !== undefined) items.push(item);
			}
			return { kind: "array", items };
		}
		if (ch === "/") {
			const start = i + 1;
			i += 1;
			while (i < block.length && !/[\s[\]()<>/%]/.test(block[i]!)) i += 1;
			return { kind: "name", value: block.slice(start, i) };
		}
		const start = i;
		while (i < block.length && !/[\s[\]()<>/%]/.test(block[i]!)) i += 1;
		const word = block.slice(start, i);
		if (word.length === 0) {
			i += 1;
			return undefined;
		}
		if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
			return { kind: "number", value: Number(word) };
		}
		return { kind: "op", value: word };
	};

	while (i < block.length) {
		const tok = readSingle();
		if (tok !== undefined) tokens.push(tok);
	}
	return tokens;
}

function extractTextFromContentStream(
	streamText: string,
	fontCMaps: ReadonlyMap<string, UnicodeCMap>,
	fallbackCMap: UnicodeCMap | undefined,
): string {
	const lines: string[] = [];
	let activeFontCMap: UnicodeCMap | undefined = fallbackCMap;

	for (const match of streamText.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
		const block = match[1] ?? "";
		const tokens = tokenizeContentBlock(block);
		const operands: PdfToken[] = [];
		let currentLine = "";
		let lastTmY: number | undefined;

		const flushLine = () => {
			if (currentLine.length > 0) {
				lines.push(currentLine);
				currentLine = "";
			}
		};

		for (const tok of tokens) {
			if (tok.kind !== "op") {
				operands.push(tok);
				continue;
			}
			const op = tok.value;
			if (op === "Tf") {
				const fontToken = operands.at(-2);
				if (fontToken?.kind === "name") {
					activeFontCMap = fontCMaps.get(fontToken.value) ?? fallbackCMap;
				}
			} else if (op === "Tj") {
				const strTok = operands.at(-1);
				if (strTok?.kind === "string") {
					currentLine += decodeBytesWithCMap(strTok.bytes, activeFontCMap);
				}
			} else if (op === "'" || op === '"') {
				flushLine();
				const strTok = operands.at(-1);
				if (strTok?.kind === "string") {
					currentLine += decodeBytesWithCMap(strTok.bytes, activeFontCMap);
				}
			} else if (op === "TJ") {
				const arrTok = operands.at(-1);
				if (arrTok?.kind === "array") {
					for (const item of arrTok.items) {
						if (item.kind === "string") {
							currentLine += decodeBytesWithCMap(item.bytes, activeFontCMap);
						} else if (item.kind === "number" && item.value < -120) {
							if (currentLine.length > 0 && !currentLine.endsWith(" ")) {
								currentLine += " ";
							}
						}
					}
				}
			} else if (op === "T*") {
				flushLine();
			} else if (op === "Td" || op === "TD") {
				const ty = operands.at(-1);
				if (ty?.kind === "number" && Math.abs(ty.value) > 0.5) {
					flushLine();
				}
			} else if (op === "Tm") {
				const ty = operands.at(-1);
				if (ty?.kind === "number") {
					if (lastTmY !== undefined && Math.abs(ty.value - lastTmY) > 1) {
						flushLine();
					}
					lastTmY = ty.value;
				}
			}
			operands.length = 0;
		}
		flushLine();
	}

	return lines.join("\n");
}

function normalizeExtractedPdfText(raw: string): string {
	// Strip non-printable ASCII control chars except newline and tab, collapse excessive whitespace cleanly.
	let cleaned = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		if (code === 0x0a || code === 0x09 || code >= 0x20) {
			cleaned += raw[i]!;
		}
	}
	return cleaned
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter((line) => line.length > 0)
		.join("\n")
		.trim();
}

function hasUnsupportedStreamSubtype(dict: string): boolean {
	return /\/Subtype\s*\/Image\b/.test(dict) || /\/Type\s*\/XRef\b/.test(dict) || /\/Type\s*\/Metadata\b/.test(dict);
}

function usesFlateDecode(dict: string): boolean {
	return /\/Filter\s*(?:\[\s*)?\/FlateDecode\b/.test(dict);
}

function usesOtherUnsupportedFilter(dict: string): boolean {
	return /\/Filter\s*(?:\[\s*)?\/(?:DCTDecode|JPXDecode|JBIG2Decode|CCITTFaxDecode|LZWDecode|RunLengthDecode)\b/.test(
		dict,
	);
}

/**
 * Extracts bounded readable UTF-8 text from a PDF byte buffer without Node-only or third-party dependencies.
 * Handles uncompressed and `/FlateDecode` streams, font-scoped `/ToUnicode` CMaps (CJK/Unicode), and UTF-16BE strings.
 */
export async function extractPdfText(bytes: Uint8Array, options?: PdfExtractOptions): Promise<PdfExtractResult> {
	const probeHeader = decodeLatin1(bytes.subarray(0, Math.min(1024, bytes.byteLength)));
	if (!probeHeader.includes("%PDF-")) {
		return {
			ok: false,
			reason: "invalid_pdf",
			message: "File does not start with a valid %PDF- header.",
		};
	}

	const rawAscii = decodeLatin1(bytes);
	if (/\/Encrypt\s+\d+\s+\d+\s+R\b|\/Encrypt\s*<</.test(rawAscii)) {
		return {
			ok: false,
			reason: "encrypted",
			message: "PDF is encrypted/password-protected and cannot be read.",
		};
	}

	const maxChars = Math.max(200, Math.floor(options?.maxChars ?? DEFAULT_PDF_MAX_CHARS));
	const maxStreamBytes = Math.max(
		64 * 1024,
		Math.floor(options?.maxDecompressedStreamBytes ?? MAX_PDF_STREAM_DECOMPRESSED_BYTES),
	);
	const maxTotalBytes = Math.max(
		maxStreamBytes,
		Math.floor(options?.maxTotalDecompressedBytes ?? MAX_PDF_TOTAL_DECOMPRESSED_BYTES),
	);

	const parsedStreams = parseObjectStreams(bytes);
	const decodedStreams: Array<{ readonly objectId?: number; readonly dict: string; readonly text: string }> = [];
	let totalDecompressed = 0;

	for (const stream of parsedStreams) {
		if (hasUnsupportedStreamSubtype(stream.dict) || usesOtherUnsupportedFilter(stream.dict)) {
			continue;
		}
		if (usesFlateDecode(stream.dict)) {
			const remainingBudget = maxTotalBytes - totalDecompressed;
			if (remainingBudget <= 0) break;
			const decoded = await decodeFlateStream(stream.rawBytes, Math.min(maxStreamBytes, remainingBudget));
			if (decoded === undefined) continue;
			totalDecompressed += decoded.byteLength;
			decodedStreams.push({
				...(stream.objectId !== undefined ? { objectId: stream.objectId } : {}),
				dict: stream.dict,
				text: decodeLatin1(decoded),
			});
		} else {
			if (stream.rawBytes.byteLength > maxStreamBytes) continue;
			decodedStreams.push({
				...(stream.objectId !== undefined ? { objectId: stream.objectId } : {}),
				dict: stream.dict,
				text: decodeLatin1(stream.rawBytes),
			});
		}
	}

	// Pass 1: Collect `/ToUnicode` CMaps keyed by PDF object ID.
	const cmapsByObjId = new Map<number, UnicodeCMap>();
	const anonymousCMaps: UnicodeCMap[] = [];
	const contentStreams: string[] = [];

	for (const stream of decodedStreams) {
		const parsedCMap = parseToUnicodeCMap(stream.text);
		if (parsedCMap !== undefined) {
			if (stream.objectId !== undefined) {
				cmapsByObjId.set(stream.objectId, parsedCMap);
			} else {
				anonymousCMaps.push(parsedCMap);
			}
			continue;
		}
		if (/\bBT\b/.test(stream.text) && /\bET\b/.test(stream.text)) {
			contentStreams.push(stream.text);
		}
	}

	const fontCMaps = buildFontToCMapIndex(rawAscii, cmapsByObjId);
	const fallbackCMap = mergeCMaps([...cmapsByObjId.values(), ...anonymousCMaps]);

	// Pass 2: Extract text from all content streams.
	const chunks: string[] = [];
	for (const content of contentStreams) {
		const part = extractTextFromContentStream(content, fontCMaps, fallbackCMap);
		if (part.trim().length > 0) {
			chunks.push(part);
		}
	}

	const normalized = normalizeExtractedPdfText(chunks.join("\n"));
	if (normalized.length === 0) {
		return {
			ok: false,
			reason: "no_text_layer",
			message: "PDF contains no extractable text layer (likely a scanned image PDF).",
		};
	}

	const totalChars = normalized.length;
	const truncated = totalChars > maxChars;
	return {
		ok: true,
		text: truncated ? `${normalized.slice(0, maxChars)}\n...[truncated]` : normalized,
		truncated,
		totalChars,
		streamCount: contentStreams.length,
	};
}
