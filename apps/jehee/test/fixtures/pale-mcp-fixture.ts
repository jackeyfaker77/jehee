// In-memory PALE-compatible MCP servers (`mail`, `calendar`, and multi-domain distractors) for unit tests, BDD, and Evals.
// Enforces MCP 2025-11-25 handshake, optimistic `expected_version` checks, `request_id` idempotency, and SHA-256 byte integrity.

import { createHash } from "node:crypto";
import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	JSON_RPC_ERROR_CODES,
	LATEST_PROTOCOL_VERSION,
	type McpTransport,
	type Resource,
	type ResourceTemplate,
	type Tool,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { JeheeMcpServerSpec } from "../../src/mcp/contract.ts";

export type PaleVersion = {
	epoch: number;
	revision: number;
};

export type PaleFileTransfer = {
	readonly filename: string;
	readonly mime_type: string;
	readonly base64: string;
	readonly sha256: string;
};

export type PaleMailMessage = {
	readonly id: string;
	readonly subject: string;
	readonly from: string;
	readonly to: readonly string[];
	readonly body: string;
	readonly folder: "inbox" | "drafts" | "sent";
	readonly attachments: readonly string[];
};

export type PaleCalendarEvent = {
	readonly id: string;
	readonly uid: string;
	readonly summary: string;
	readonly start: string;
	readonly end: string;
	readonly attachments: PaleFileTransfer[];
};

export type MockPaleEnvironment = {
	readonly mailSpec: JeheeMcpServerSpec;
	readonly calendarSpec: JeheeMcpServerSpec;
	readonly distractorSpecs: readonly JeheeMcpServerSpec[];
	readonly expectedPdfSha256: string;
	readonly pdfByteLength: number;
	readonly icsText: string;
	reset(options?: { readonly calendarInitialRevision?: number }): void;
	snapshot(): {
		readonly mailSentIds: readonly string[];
		readonly calendarVersion: PaleVersion;
		readonly calendarEvents: readonly PaleCalendarEvent[];
	};
};

type MiniMcpServerConfig = {
	readonly name: string;
	readonly instructions: string;
	readonly tools: readonly Tool[];
	readonly resources?: () => readonly Resource[];
	readonly resourceTemplates?: () => readonly ResourceTemplate[];
	readonly readResource?: (uri: string) => {
		readonly contents: readonly {
			readonly uri: string;
			readonly mimeType?: string;
			readonly text?: string;
			readonly blob?: string;
		}[];
	};
	readonly callTool: (
		name: string,
		args: Record<string, unknown>,
	) => {
		readonly structuredContent: Record<string, unknown>;
		readonly isError?: boolean;
	};
};

function attachMiniMcpServer(serverTransport: McpTransport, config: MiniMcpServerConfig): void {
	let initialized = false;
	let ready = false;

	serverTransport.onMessage((msg) => {
		if (isJsonRpcNotification(msg)) {
			if (msg.method === "notifications/initialized" && initialized) {
				ready = true;
			}
			return;
		}
		if (!isJsonRpcRequest(msg)) return;

		const reply = (result: unknown) => {
			void serverTransport.send({ jsonrpc: "2.0", id: msg.id, result });
		};
		const rpcError = (code: number, message: string) => {
			void serverTransport.send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
		};

		if (msg.method === "initialize") {
			initialized = true;
			reply({
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: {
					tools: { listChanged: false },
					...(config.resources !== undefined ? { resources: { subscribe: false, listChanged: false } } : {}),
				},
				serverInfo: { name: `pale-mock-${config.name}`, version: "1.4.0" },
				instructions: config.instructions,
			});
			return;
		}
		if (msg.method === "ping") {
			reply({});
			return;
		}
		if (!ready) {
			rpcError(-32002, "Send initialize and notifications/initialized first");
			return;
		}
		if (msg.method === "tools/list") {
			reply({ tools: config.tools });
			return;
		}
		if (msg.method === "resources/list" && config.resources !== undefined) {
			reply({ resources: config.resources() });
			return;
		}
		if (msg.method === "resources/templates/list" && config.resources !== undefined) {
			reply({ resourceTemplates: config.resourceTemplates?.() ?? [] });
			return;
		}
		const reqParams: Record<string, unknown> =
			typeof msg.params === "object" && msg.params !== null && !Array.isArray(msg.params)
				? (msg.params as Record<string, unknown>)
				: {};
		if (msg.method === "resources/read" && config.readResource !== undefined) {
			const uri = typeof reqParams.uri === "string" ? reqParams.uri : "";
			try {
				reply(config.readResource(uri));
			} catch (err) {
				rpcError(-32002, err instanceof Error ? err.message : String(err));
			}
			return;
		}
		if (msg.method === "tools/call") {
			const toolName = typeof reqParams.name === "string" ? reqParams.name : "";
			const toolArgs =
				typeof reqParams.arguments === "object" &&
				reqParams.arguments !== null &&
				!Array.isArray(reqParams.arguments)
					? (reqParams.arguments as Record<string, unknown>)
					: {};
			const out = config.callTool(toolName, toolArgs);
			reply({
				content: [{ type: "text", text: JSON.stringify(out.structuredContent) }],
				structuredContent: out.structuredContent,
				isError: out.isError === true,
			});
			return;
		}
		rpcError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not available: ${msg.method}`);
	});

	void serverTransport.start();
}

function makeInMemorySpec(
	specMeta: { readonly name: string; readonly description: string },
	buildServer: () => MiniMcpServerConfig,
): JeheeMcpServerSpec {
	return {
		name: specMeta.name,
		description: specMeta.description,
		transport: {
			kind: "custom",
			create: () => {
				const pair = createInMemoryTransportPair();
				attachMiniMcpServer(pair.server, buildServer());
				return pair.client;
			},
		},
	};
}

function buildSyntheticPdfBytes(sizeBytes: number): Buffer {
	const header = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% Receipt payload: ", "utf8");
	const trailer = Buffer.from("\n%%EOF\n", "utf8");
	const bodyLen = Math.max(64, sizeBytes - header.byteLength - trailer.byteLength);
	const body = Buffer.alloc(bodyLen);
	for (let i = 0; i < bodyLen; i++) {
		body[i] = (i * 31 + 17) & 0xff;
	}
	return Buffer.concat([header, body, trailer]);
}

const VERSION_SCHEMA = {
	type: "object",
	properties: {
		epoch: { type: "integer", minimum: 1 },
		revision: { type: "integer", minimum: 0 },
	},
	required: ["epoch", "revision"],
	additionalProperties: false,
} as const;

/** Creates a resettable multi-App PALE mock environment with Mail, Calendar, PDF/ICS attachments, and N distractor servers. */
export function createMockPaleEnvironment(options?: {
	readonly pdfSizeBytes?: number;
	readonly distractorServerCount?: number;
	readonly toolsPerDistractor?: number;
	readonly calendarInitialRevision?: number;
}): MockPaleEnvironment {
	const pdfBytes = buildSyntheticPdfBytes(options?.pdfSizeBytes ?? 16_384);
	const pdfBase64 = pdfBytes.toString("base64");
	const pdfSha256 = createHash("sha256").update(pdfBytes).digest("hex");

	const icsText = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		"UID:flight-rebook-778@pale.example",
		"SUMMARY:Replacement Flight SFO -> JFK",
		"DTSTART:20261120T140000Z",
		"DTEND:20261120T223000Z",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
	const icsBytes = Buffer.from(icsText, "utf8");
	const icsBase64 = icsBytes.toString("base64");
	const icsSha256 = createHash("sha256").update(icsBytes).digest("hex");

	let mailVersion: PaleVersion = { epoch: 1, revision: 0 };
	let calendarVersion: PaleVersion = { epoch: 1, revision: options?.calendarInitialRevision ?? 0 };
	let sentMailIds: string[] = [];
	let calendarEvents: PaleCalendarEvent[] = [];
	const receipts = new Map<string, Record<string, unknown>>();

	const messages: PaleMailMessage[] = [
		{
			id: "msg-flight-1",
			subject: "Updated Flight Confirmation & Receipt",
			from: "bookings@airline.pale.example",
			to: ["owner@pale.example"],
			body: "Your replacement flight arrives at JFK. Attached are the updated calendar invite and payment receipt.",
			folder: "inbox",
			attachments: ["att-ics", "att-pdf"],
		},
		{
			id: "msg-draft-1",
			subject: "Partner Airport Pickup Update",
			from: "owner@pale.example",
			to: ["partner@pale.example"],
			body: "Landing at JFK at 22:30 UTC instead of EWR.",
			folder: "drafts",
			attachments: [],
		},
	];

	const attachmentMap = new Map<string, PaleFileTransfer>([
		[
			"att-ics",
			{
				filename: "delivery.ics",
				mime_type: "text/calendar",
				base64: icsBase64,
				sha256: icsSha256,
			},
		],
		[
			"att-pdf",
			{
				filename: "receipt.pdf",
				mime_type: "application/pdf",
				base64: pdfBase64,
				sha256: pdfSha256,
			},
		],
	]);

	const reset = (resetOpts?: { readonly calendarInitialRevision?: number }) => {
		mailVersion = { epoch: mailVersion.epoch + 1, revision: 0 };
		calendarVersion = {
			epoch: calendarVersion.epoch + 1,
			revision: resetOpts?.calendarInitialRevision ?? options?.calendarInitialRevision ?? 0,
		};
		sentMailIds = [];
		calendarEvents = [];
		receipts.clear();
	};

	const checkExpectedVersion = (actual: PaleVersion, given: unknown): boolean => {
		if (typeof given !== "object" || given === null) return false;
		const v = given as Record<string, unknown>;
		return v.epoch === actual.epoch && v.revision === actual.revision;
	};

	const mailSpec = makeInMemorySpec(
		{
			name: "mail",
			description: "Personal Mail inbox, drafts, attachments, and delivery.",
		},
		() => ({
			name: "mail",
			instructions: "Personal Mail service. Use mail.search, mail.get, mail.attachment.get, or MCP resources.",
			tools: [
				{
					name: "mail.search",
					description: "Search authorized messages in inbox, drafts, or sent folders.",
					annotations: { readOnlyHint: true },
					inputSchema: {
						type: "object",
						properties: {
							query: { type: "string", description: "Keyword filter over subject and body." },
							folder: { type: "string", enum: ["inbox", "drafts", "sent"] },
						},
						additionalProperties: false,
					},
				},
				{
					name: "mail.get",
					description: "Read a single email message and its attachment asset IDs.",
					annotations: { readOnlyHint: true },
					inputSchema: {
						type: "object",
						properties: { id: { type: "string" } },
						required: ["id"],
						additionalProperties: false,
					},
				},
				{
					name: "mail.attachment.get",
					description: "Read an email attachment's metadata, base64 bytes, and sha256 digest.",
					annotations: { readOnlyHint: true },
					inputSchema: {
						type: "object",
						properties: {
							id: { type: "string", description: "Message ID." },
							asset_id: { type: "string", description: "Attachment asset ID." },
						},
						required: ["id", "asset_id"],
						additionalProperties: false,
					},
				},
				{
					name: "mail.send",
					description: "Send an existing draft message externally (irreversible write).",
					annotations: { readOnlyHint: false },
					inputSchema: {
						type: "object",
						properties: {
							id: { type: "string", description: "Draft message ID." },
							expected_version: VERSION_SCHEMA,
							request_id: { type: "string" },
						},
						required: ["id", "expected_version", "request_id"],
						additionalProperties: false,
					},
				},
			],
			resources: () => [
				{
					uri: "pale://demo/mail/assets/att-ics",
					name: "delivery.ics",
					mimeType: "text/calendar",
					size: icsBytes.byteLength,
				},
				{
					uri: "pale://demo/mail/assets/att-pdf",
					name: "receipt.pdf",
					mimeType: "application/pdf",
					size: pdfBytes.byteLength,
				},
			],
			resourceTemplates: () => [
				{
					uriTemplate: "pale://demo/mail/assets/{asset_id}",
					name: "mail_attachment_asset",
					description: "Parameterized URI template addressing an email attachment asset by ID.",
				},
			],
			readResource: (uri) => {
				if (uri === "pale://demo/mail/assets/att-ics") {
					return { contents: [{ uri, mimeType: "text/calendar", blob: icsBase64 }] };
				}
				if (uri === "pale://demo/mail/assets/att-pdf") {
					return { contents: [{ uri, mimeType: "application/pdf", blob: pdfBase64 }] };
				}
				throw new Error(`Resource not available: ${uri}`);
			},
			callTool: (toolName, args) => {
				if (toolName === "mail.search") {
					const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
					const folder = typeof args.folder === "string" ? args.folder : undefined;
					const hits = messages.filter(
						(m) =>
							(folder === undefined || m.folder === folder) &&
							(q.length === 0 || m.subject.toLowerCase().includes(q) || m.body.toLowerCase().includes(q)),
					);
					return { structuredContent: { status: "ok", app_id: "mail", version: mailVersion, messages: hits } };
				}
				if (toolName === "mail.get") {
					const found = messages.find((m) => m.id === args.id);
					if (!found) {
						return { isError: true, structuredContent: { status: "not_found", version: mailVersion } };
					}
					return { structuredContent: { status: "ok", app_id: "mail", version: mailVersion, message: found } };
				}
				if (toolName === "mail.attachment.get") {
					const file = attachmentMap.get(String(args.asset_id));
					if (!file) {
						return { isError: true, structuredContent: { status: "not_found", version: mailVersion } };
					}
					return { structuredContent: { status: "ok", app_id: "mail", version: mailVersion, file } };
				}
				if (toolName === "mail.send") {
					if (!checkExpectedVersion(mailVersion, args.expected_version)) {
						return {
							isError: true,
							structuredContent: {
								status: "stale_version",
								applied: false,
								version: mailVersion,
								current_version: mailVersion,
							},
						};
					}
					mailVersion = { epoch: mailVersion.epoch, revision: mailVersion.revision + 1 };
					sentMailIds.push(String(args.id));
					return {
						structuredContent: {
							status: "committed",
							app_id: "mail",
							id: String(args.id),
							version: mailVersion,
						},
					};
				}
				return { isError: true, structuredContent: { status: "unknown_tool", version: mailVersion } };
			},
		}),
	);

	const calendarSpec = makeInMemorySpec(
		{
			name: "calendar",
			description: "Personal Calendar schedule, ICS event imports, and event receipts.",
		},
		() => ({
			name: "calendar",
			instructions: "Personal Calendar service. Writes require expected_version and request_id.",
			tools: [
				{
					name: "calendar.list",
					description: "List scheduled calendar events and current state version.",
					annotations: { readOnlyHint: true },
					inputSchema: {
						type: "object",
						properties: {
							start: { type: "string" },
							end: { type: "string" },
						},
						additionalProperties: false,
					},
				},
				{
					name: "calendar.import_ics",
					description: "Import or update one VEVENT from RFC 5545 ICS text.",
					annotations: { readOnlyHint: false },
					inputSchema: {
						type: "object",
						properties: {
							text: { type: "string", description: "Complete BEGIN:VCALENDAR ... END:VCALENDAR text." },
							expected_version: VERSION_SCHEMA,
							request_id: { type: "string" },
						},
						required: ["text", "expected_version", "request_id"],
						additionalProperties: false,
					},
				},
				{
					name: "calendar.attachment.add",
					description: "Attach verified binary files (e.g. PDF receipts) to a calendar event.",
					annotations: { readOnlyHint: false },
					inputSchema: {
						type: "object",
						properties: {
							id: { type: "string", description: "Target calendar event ID." },
							files: {
								type: "array",
								items: {
									type: "object",
									properties: {
										filename: { type: "string" },
										mime_type: { type: "string" },
										base64: { type: "string" },
										sha256: { type: "string" },
									},
									required: ["filename", "mime_type", "base64", "sha256"],
									additionalProperties: false,
								},
							},
							expected_version: VERSION_SCHEMA,
							request_id: { type: "string" },
						},
						required: ["id", "files", "expected_version", "request_id"],
						additionalProperties: false,
					},
				},
			],
			callTool: (toolName, args) => {
				if (toolName === "calendar.list") {
					return {
						structuredContent: {
							status: "ok",
							app_id: "calendar",
							version: calendarVersion,
							events: calendarEvents,
						},
					};
				}
				if (toolName === "calendar.import_ics") {
					const reqKey = `cal:${String(args.request_id)}`;
					if (receipts.has(reqKey)) {
						return { structuredContent: { ...receipts.get(reqKey)!, duplicate: true } };
					}
					if (!checkExpectedVersion(calendarVersion, args.expected_version)) {
						return {
							isError: true,
							structuredContent: {
								status: "stale_version",
								message: "Observation is stale; retry with current_version.",
								applied: false,
								version: calendarVersion,
								current_version: calendarVersion,
							},
						};
					}
					const rawIcs = typeof args.text === "string" ? args.text : "";
					if (!rawIcs.includes("BEGIN:VCALENDAR") || !rawIcs.includes("UID:")) {
						return {
							isError: true,
							structuredContent: { status: "invalid_ics", applied: false, version: calendarVersion },
						};
					}
					const uidMatch = /UID:([^\r\n]+)/.exec(rawIcs);
					const summaryMatch = /SUMMARY:([^\r\n]+)/.exec(rawIcs);
					const startMatch = /DTSTART:([^\r\n]+)/.exec(rawIcs);
					const endMatch = /DTEND:([^\r\n]+)/.exec(rawIcs);
					const eventId = `evt-${calendarEvents.length + 1}`;
					calendarEvents.push({
						id: eventId,
						uid: uidMatch?.[1]?.trim() ?? "unknown",
						summary: summaryMatch?.[1]?.trim() ?? "Untitled",
						start: startMatch?.[1]?.trim() ?? "",
						end: endMatch?.[1]?.trim() ?? "",
						attachments: [],
					});
					calendarVersion = { epoch: calendarVersion.epoch, revision: calendarVersion.revision + 1 };
					const committed = {
						status: "committed",
						app_id: "calendar",
						id: eventId,
						version: calendarVersion,
					};
					receipts.set(reqKey, committed);
					return { structuredContent: committed };
				}
				if (toolName === "calendar.attachment.add") {
					if (!checkExpectedVersion(calendarVersion, args.expected_version)) {
						return {
							isError: true,
							structuredContent: {
								status: "stale_version",
								applied: false,
								version: calendarVersion,
								current_version: calendarVersion,
							},
						};
					}
					const target = calendarEvents.find((ev) => ev.id === args.id);
					if (!target) {
						return { isError: true, structuredContent: { status: "not_found", version: calendarVersion } };
					}
					const incomingFiles = Array.isArray(args.files) ? (args.files as PaleFileTransfer[]) : [];
					for (const f of incomingFiles) {
						const decoded = Buffer.from(f.base64, "base64");
						const actualSha = createHash("sha256").update(decoded).digest("hex");
						if (actualSha !== f.sha256) {
							return {
								isError: true,
								structuredContent: {
									status: "integrity_mismatch",
									expected_sha256: f.sha256,
									actual_sha256: actualSha,
									version: calendarVersion,
								},
							};
						}
						target.attachments.push(f);
					}
					calendarVersion = { epoch: calendarVersion.epoch, revision: calendarVersion.revision + 1 };
					return {
						structuredContent: {
							status: "committed",
							app_id: "calendar",
							id: target.id,
							version: calendarVersion,
						},
					};
				}
				return { isError: true, structuredContent: { status: "unknown_tool", version: calendarVersion } };
			},
		}),
	);

	const distractorCount = options?.distractorServerCount ?? 4;
	const toolsPerDistractor = options?.toolsPerDistractor ?? 12;
	const domainCatalog = [
		{ name: "larkfield_health", desc: "Employer health plan claims, EOBs, prior authorizations, and appeals." },
		{ name: "mendwell_pharmacy", desc: "Retail pharmacy prescriptions, drug pricing, and refill holds." },
		{ name: "fresh_groceries", desc: "Household grocery orders, allergen profiles, and pantry inventory." },
		{ name: "home_utilities", desc: "Residential broadband, power outage schedules, and billing." },
		{ name: "fitness_studio", desc: "Class bookings, trial pass pricing, and trainer schedules." },
	];

	const distractorSpecs: JeheeMcpServerSpec[] = Array.from({ length: distractorCount }, (_, sIdx) => {
		const meta = domainCatalog[sIdx % domainCatalog.length]!;
		const serverName = sIdx < domainCatalog.length ? meta.name : `${meta.name}_${sIdx}`;
		const tools: Tool[] = Array.from({ length: toolsPerDistractor }, (__, tIdx) => ({
			name: `${serverName}.op_${tIdx + 1}`,
			description: `Perform domain workflow operation #${tIdx + 1} in ${meta.desc} Supports filtering, pagination, and audit metadata.`,
			annotations: { readOnlyHint: tIdx % 2 === 0 },
			inputSchema: {
				type: "object",
				properties: {
					member_id: { type: "string", description: "Authorized household member identifier." },
					filter_status: {
						type: "string",
						enum: ["pending", "approved", "denied", "archived", "under_review"],
						description: "Lifecycle status filter applied before sorting.",
					},
					include_history: { type: "boolean", description: "Include historical versions and audit trail." },
					page_cursor: { type: "string", description: "Opaque cursor returned by a prior listing call." },
					expected_version: VERSION_SCHEMA,
					request_id: { type: "string", description: "Client-generated idempotency token." },
				},
				required: ["member_id"],
				additionalProperties: false,
			},
		}));
		return makeInMemorySpec({ name: serverName, description: meta.desc }, () => ({
			name: serverName,
			instructions: meta.desc,
			tools,
			callTool: () => ({ structuredContent: { status: "ok" } }),
		}));
	});

	return {
		mailSpec,
		calendarSpec,
		distractorSpecs,
		expectedPdfSha256: pdfSha256,
		pdfByteLength: pdfBytes.byteLength,
		icsText,
		reset,
		snapshot: () => ({
			mailSentIds: [...sentMailIds],
			calendarVersion: { ...calendarVersion },
			calendarEvents: structuredClone(calendarEvents),
		}),
	};
}
