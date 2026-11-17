// Pure TypeScript contract for Jehee's pluggable memory layer. Kept free of pi-durable imports so memory strategies
// remain plain data transformations that survive upstream Experimental API changes.

import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";

/** Summary emitted to a memory provider after a conversational run completes and commits its answer. */
export type TurnCompletedEvent = {
	readonly conversationId: string;
	readonly userMessages: readonly string[];
	readonly assistantReply: string;
};

/** Input passed to a memory provider right before a model request is sent, allowing transient context shaping. */
export type RequestContextInput = {
	readonly conversationId: string;
	readonly messages: readonly Message[];
};

/** Pluggable memory strategy mounted by JeheeHost. */
export interface MemoryProvider {
	readonly id: string;
	/** Renders the stable L1 core identity/preference block; unchanged text preserves provider KV-cache prefixes. */
	renderCorePrompt?(conversationId: string): string | undefined | Promise<string | undefined>;
	/** Shapes the per-request message list (for tail-injected drawers or sweet-spot windowing) without altering stored entries. */
	shapeRequestMessages?(
		input: RequestContextInput,
	): readonly Message[] | undefined | Promise<readonly Message[] | undefined>;
	/** Invoked after a run commits its final answer so memory providers can archive or classify turns asynchronously. */
	onTurnCompleted?(event: TurnCompletedEvent): void | Promise<void>;
}

/** Extracts plain text from a normalized pi-ai UserMessage. */
export function extractUserText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/** Extracts plain text from a normalized pi-ai AssistantMessage. */
export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}
