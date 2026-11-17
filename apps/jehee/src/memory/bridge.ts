// Anti-corruption bridge adapting a pure Jehee MemoryProvider into a pi-durable Extension. This is the single file in
// the memory layer coupled to pi-durable's extension and hook signatures.

import {
	AssistantEntry,
	defineExtension,
	type Extension,
	GenerationTask,
	hook,
	section,
	UserEntry,
} from "@earendil-works/pi-durable";
import { extractAssistantText, extractUserText, type MemoryProvider } from "./contract.ts";

/** Fixed extension slot name so installing a new MemoryProvider replaces the previous one atomically in place. */
export const JEHEE_MEMORY_EXTENSION_NAME = "jehee.memory";

/** Wraps `provider` as the `"jehee.memory"` pi-durable extension. */
export function createMemoryExtension(provider: MemoryProvider): Extension {
	return defineExtension({
		name: JEHEE_MEMORY_EXTENSION_NAME,
		sections: [section("jehee_core_memory", (input) => provider.renderCorePrompt?.(String(input.conversationId)))],
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (request, api) => {
					if (provider.shapeRequestMessages === undefined) return undefined;
					const shaped = await provider.shapeRequestMessages({
						conversationId: String(api.conversationId),
						messages: request.messages,
					});
					return shaped === undefined ? undefined : { messages: shaped };
				},
				afterRun: async (run, api, context) => {
					if (provider.onTurnCompleted === undefined) return undefined;
					const page = await api.entries(
						{ minEntryId: run.first, maxEntryId: run.last, order: "ascending" },
						1000,
						undefined,
						context,
					);
					const userMessages: string[] = [];
					let assistantReply = "";
					for (const entry of page.items) {
						const firstModelMsg = entry.model?.[0];
						if (UserEntry.is(entry) && firstModelMsg?.role === "user") {
							userMessages.push(extractUserText(firstModelMsg));
						} else if (
							AssistantEntry.is(entry) &&
							entry.id === run.answer &&
							firstModelMsg?.role === "assistant"
						) {
							assistantReply = extractAssistantText(firstModelMsg);
						}
					}
					await provider.onTurnCompleted({
						conversationId: String(api.conversationId),
						userMessages,
						assistantReply,
					});
					return undefined;
				},
			}),
		],
	});
}
