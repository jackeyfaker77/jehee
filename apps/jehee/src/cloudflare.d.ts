// Minimal ambient types for Cloudflare Workers + SQLite-backed Durable Objects so `worker.ts` type-checks cleanly
// alongside Node 24 without pulling in conflicting global `@cloudflare/workers-types`.

declare module "cloudflare:workers" {
	import type { DurableObjectSqliteStorage } from "@earendil-works/chord/sqlite/cloudflare";

	export abstract class DurableObject<Env = unknown> {
		protected ctx: DurableObjectState;
		protected env: Env;
		constructor(ctx: DurableObjectState, env: Env);
	}

	export type DurableObjectStorage = DurableObjectSqliteStorage & {
		getAlarm(): Promise<number | null>;
		setAlarm(scheduledTime: number): Promise<void>;
		deleteAlarm(): Promise<void>;
	};

	export type DurableObjectState = {
		readonly storage: DurableObjectStorage;
		blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
		abort(reason?: string): void;
	};

	export type DurableObjectId = { toString(): string };

	export type DurableObjectStub = {
		readonly id: DurableObjectId;
		fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	};

	export type DurableObjectNamespace = {
		idFromName(name: string): DurableObjectId;
		get(id: DurableObjectId): DurableObjectStub;
	};
}
