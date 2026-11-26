// Unit tests for Jehee's pure Web/Edge-portable PDF text extractor (`extractPdfText`):
// uncompressed & `/FlateDecode` streams, font-scoped `/ToUnicode` CMaps (bfchar + bfrange) for CJK/Unicode,
// trailing-padding zlib resilience, UTF-16BE BOM strings, encryption/scanned-PDF/invalid guards, and truncation.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractPdfText } from "../src/channels/pdf-text.ts";

async function deflateBytes(input: Uint8Array): Promise<Uint8Array> {
	const cs = new CompressionStream("deflate");
	const writer = cs.writable.getWriter();
	const reader = cs.readable.getReader();
	const writeTask = (async () => {
		await writer.write(new Uint8Array(input));
		await writer.close();
	})();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value !== undefined) {
			chunks.push(value);
			total += value.byteLength;
		}
	}
	await writeTask;
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

function concatBytes(parts: readonly (string | Uint8Array)[]): Uint8Array {
	const enc = new TextEncoder();
	const bufs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
	const total = bufs.reduce((sum, b) => sum + b.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const b of bufs) {
		out.set(b, offset);
		offset += b.byteLength;
	}
	return out;
}

describe("portable PDF text extractor", () => {
	it("extracts text from uncompressed PDF streams with literal escapes, TJ kerning, and line breaks", async () => {
		const stream = [
			"BT",
			"/F1 12 Tf",
			"72 720 Td",
			"(Invoice \\(#2026-11\\) \\101\\102) Tj",
			"0 -16 Td",
			"[(Total:) -220 ($128.50)] TJ",
			"T*",
			"(<FEFF>) Tj",
			"ET",
		].join("\n");
		const pdf = concatBytes([
			"%PDF-1.4\n",
			`1 0 obj << /Length ${stream.length} >>\nstream\n`,
			stream,
			"\nendstream\nendobj\n%%EOF",
		]);

		const res = await extractPdfText(pdf);
		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.truncated, false);
			assert.ok(res.text.includes("Invoice (#2026-11) AB"));
			assert.ok(res.text.includes("Total: $128.50"));
		}
	});

	it("decompresses FlateDecode streams and resolves font-scoped ToUnicode CMaps (bfchar + bfrange) for CJK and Latin text", async () => {
		// Font F1 (obj 10) -> CMap obj 11: CID 0001..0002 = "发票" (bfchar), 0003..0004 = "金额" (bfrange array)
		const cmap1 = [
			"/CIDInit /ProcSet findresource begin",
			"begincmap",
			"2 beginbfchar",
			"<0001> <53D1>",
			"<0002> <7968>",
			"endbfchar",
			"1 beginbfrange",
			"<0003> <0004> [<91D1> <989D>]",
			"endbfrange",
			"endcmap",
		].join("\n");
		// Font F2 (obj 20) -> CMap obj 21: same CID 0001..0003 maps to "ABC" via scalar bfrange (proves font scoping!)
		const cmap2 = ["begincmap", "1 beginbfrange", "<0001> <0003> <0041>", "endbfrange", "endcmap"].join("\n");

		const contentStream = [
			"BT",
			"/F1 12 Tf",
			"<0001000200030004> Tj",
			"0 -18 Td",
			"/F2 12 Tf",
			"<000100020003> Tj",
			"0 -18 Td",
			"<FEFF0031003200380030> Tj",
			"ET",
		].join("\n");

		const [zCmap1, zCmap2, zContent] = await Promise.all([
			deflateBytes(new TextEncoder().encode(cmap1)),
			deflateBytes(new TextEncoder().encode(cmap2)),
			deflateBytes(new TextEncoder().encode(contentStream)),
		]);

		// Append trailing junk bytes after zlib EOF on content stream to verify real-world PDF resilience.
		const zContentWithTrailing = concatBytes([zContent, new Uint8Array([0x0d, 0x0a, 0x20, 0x00])]);

		const pdf = concatBytes([
			"%PDF-1.7\n",
			"1 0 obj << /Type /Page /Resources << /Font << /F1 10 0 R /F2 20 0 R >> >> >> endobj\n",
			"10 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 11 0 R >> endobj\n",
			`11 0 obj << /Filter /FlateDecode /Length ${zCmap1.byteLength} >>\nstream\n`,
			zCmap1,
			"\nendstream\nendobj\n",
			"20 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 21 0 R >> endobj\n",
			`21 0 obj << /Filter [/FlateDecode] /Length ${zCmap2.byteLength} >>\nstream\n`,
			zCmap2,
			"\nendstream\nendobj\n",
			`30 0 obj << /Filter /FlateDecode /Length ${zContentWithTrailing.byteLength} >>\nstream\n`,
			zContentWithTrailing,
			"\nendstream\nendobj\n%%EOF",
		]);

		const res = await extractPdfText(pdf);
		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.text, "发票金额\nABC\n1280");
		}
	});

	it("detects invalid headers, encrypted PDFs, scanned image-only PDFs, and enforces maxChars truncation", async () => {
		const invalid = await extractPdfText(new TextEncoder().encode("not a pdf"));
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.equal(invalid.reason, "invalid_pdf");

		const encrypted = await extractPdfText(
			new TextEncoder().encode("%PDF-1.5\n1 0 obj << /Encrypt 2 0 R >> endobj\n%%EOF"),
		);
		assert.equal(encrypted.ok, false);
		if (!encrypted.ok) assert.equal(encrypted.reason, "encrypted");

		const scanned = await extractPdfText(
			new TextEncoder().encode(
				"%PDF-1.5\n1 0 obj << /Subtype /Image /Filter /DCTDecode /Length 4 >>\nstream\nABCD\nendstream\nendobj\n%%EOF",
			),
		);
		assert.equal(scanned.ok, false);
		if (!scanned.ok) assert.equal(scanned.reason, "no_text_layer");

		const longText = "X".repeat(600);
		const longStream = `BT /F1 12 Tf (${longText}) Tj ET`;
		const longPdf = concatBytes([
			"%PDF-1.4\n",
			`1 0 obj << /Length ${longStream.length} >>\nstream\n`,
			longStream,
			"\nendstream\nendobj\n%%EOF",
		]);
		const truncated = await extractPdfText(longPdf, { maxChars: 250 });
		assert.equal(truncated.ok, true);
		if (truncated.ok) {
			assert.equal(truncated.truncated, true);
			assert.equal(truncated.totalChars, 600);
			assert.match(truncated.text, /\.\.\.\[truncated\]$/);
		}
	});
});
