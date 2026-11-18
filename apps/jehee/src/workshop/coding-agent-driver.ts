// Portable external Coding Agent CLI driver presets (`pi`, `opencode`, `antigravity`, `claude`, `codex`, `custom`)
// plus prompt isolation and bounded report formatting for Jehee's Workshop gateway.

/** Supported Workshop execution drivers (`"builtin"` retains the legacy in-process 3-tool sandbox subagent). */
export const ALL_WORKSHOP_DRIVER_NAMES = [
	"pi",
	"opencode",
	"antigravity",
	"claude",
	"codex",
	"custom",
	"builtin",
] as const;

/** Union of all valid Workshop driver identifiers. */
export type WorkshopDriverName = (typeof ALL_WORKSHOP_DRIVER_NAMES)[number];

/** Subset of Workshop drivers backed by an external Coding Agent CLI process. */
export type ExternalWorkshopDriverName = Exclude<WorkshopDriverName, "builtin">;

/** User-defined argv template for `driver: "custom"` (`{prompt}`, `{cwd}`, `{model}`, `{session}` placeholders). */
export type CustomCodingAgentTemplate = {
	readonly initialArgv: readonly string[];
	readonly continueArgv?: readonly string[];
};

/** Input parameters for building one non-interactive CLI turn invocation. */
export type CodingAgentInvocationInput = {
	readonly driver: ExternalWorkshopDriverName;
	readonly prompt: string;
	readonly cwd: string;
	readonly isContinuation: boolean;
	readonly model?: string;
	readonly externalSessionId?: string;
	readonly customTemplate?: CustomCodingAgentTemplate;
};

/** Maximum combined stdout/stderr characters forwarded into the main conversation's follow-up summary. */
export const MAX_WORKSHOP_REPORT_CHARS = 12_000;

/** Validates a raw string as a `WorkshopDriverName`. */
export function parseWorkshopDriverName(raw: string, label: string = "driver"): WorkshopDriverName {
	const trimmed = raw.trim() as WorkshopDriverName;
	if ((ALL_WORKSHOP_DRIVER_NAMES as readonly string[]).includes(trimmed)) {
		return trimmed;
	}
	throw new Error(
		`Invalid ${label} "${raw}": expected one of ${ALL_WORKSHOP_DRIVER_NAMES.map((d) => `"${d}"`).join(", ")}`,
	);
}

function expandCustomTemplate(
	template: readonly string[],
	vars: {
		readonly prompt: string;
		readonly cwd: string;
		readonly model?: string;
		readonly session?: string;
	},
): readonly string[] {
	if (template.length === 0) {
		throw new Error('Custom coding agent template requires a non-empty "initialArgv" array');
	}
	let usedPromptPlaceholder = false;
	const expanded: string[] = [];
	for (const token of template) {
		if (token.includes("{prompt}")) usedPromptPlaceholder = true;
		if ((token === "{model}" && !vars.model) || (token === "{session}" && !vars.session)) {
			continue;
		}
		expanded.push(
			token
				.replaceAll("{prompt}", vars.prompt)
				.replaceAll("{cwd}", vars.cwd)
				.replaceAll("{model}", vars.model ?? "")
				.replaceAll("{session}", vars.session ?? ""),
		);
	}
	if (!usedPromptPlaceholder) {
		expanded.push(vars.prompt);
	}
	return expanded;
}

/**
 * Translates a single Workshop turn into an injection-safe `argv` vector for the selected external Coding Agent CLI:
 * - `pi`: `pi [--continue] --print [--model <m>] -- <prompt>`
 * - `opencode`: `opencode run --auto [-c | -s <id>] [-m <m>] -- <prompt>`
 * - `antigravity`: `agy --print --dangerously-skip-permissions --add-dir <cwd> [--continue | --conversation <id>] [--model <m>] -- <prompt>`
 * - `claude`: `claude [--continue | --resume <id>] --print --dangerously-skip-permissions [--model <m>] -- <prompt>`
 * - `codex`: `codex exec [resume (--last | <id>)] --dangerously-bypass-approvals-and-sandbox [-m <m>] -- <prompt>`
 * - `custom`: user-configured `CustomCodingAgentTemplate`
 */
export function buildCodingAgentArgv(input: CodingAgentInvocationInput): readonly string[] {
	const model = input.model?.trim() || undefined;
	const session = input.externalSessionId?.trim() || undefined;

	switch (input.driver) {
		case "pi":
			return [
				"pi",
				...(input.isContinuation ? ["--continue"] : []),
				"--print",
				...(model !== undefined ? ["--model", model] : []),
				"--",
				input.prompt,
			];

		case "opencode":
			return [
				"opencode",
				"run",
				"--auto",
				...(input.isContinuation ? (session !== undefined ? ["-s", session] : ["-c"]) : []),
				...(model !== undefined ? ["-m", model] : []),
				"--",
				input.prompt,
			];

		case "antigravity":
			return [
				"agy",
				"--print",
				"--dangerously-skip-permissions",
				"--add-dir",
				input.cwd,
				...(input.isContinuation ? (session !== undefined ? ["--conversation", session] : ["--continue"]) : []),
				...(model !== undefined ? ["--model", model] : []),
				"--",
				input.prompt,
			];

		case "claude":
			return [
				"claude",
				...(input.isContinuation ? (session !== undefined ? ["--resume", session] : ["--continue"]) : []),
				"--print",
				"--dangerously-skip-permissions",
				...(model !== undefined ? ["--model", model] : []),
				"--",
				input.prompt,
			];

		case "codex":
			if (input.isContinuation) {
				return [
					"codex",
					"exec",
					"resume",
					session ?? "--last",
					"--dangerously-bypass-approvals-and-sandbox",
					...(model !== undefined ? ["-m", model] : []),
					"--",
					input.prompt,
				];
			}
			return [
				"codex",
				"exec",
				"--dangerously-bypass-approvals-and-sandbox",
				...(model !== undefined ? ["-m", model] : []),
				"--",
				input.prompt,
			];

		case "custom": {
			const tpl = input.customTemplate;
			if (tpl === undefined) {
				throw new Error('Workshop driver "custom" requires a configured customTemplate');
			}
			const chosen = input.isContinuation ? (tpl.continueArgv ?? tpl.initialArgv) : tpl.initialArgv;
			return expandCustomTemplate(chosen, {
				prompt: input.prompt,
				cwd: input.cwd,
				...(model !== undefined ? { model } : {}),
				...(session !== undefined ? { session } : {}),
			});
		}
	}
}

/**
 * Builds the isolated prompt delivered to an external Coding Agent:
 * - Turn 1 (`!isContinuation`) prepends the L1 Core coding preferences if non-empty (never main-chat casual history);
 * - Continuation turns (`isContinuation`) pass only the incremental instruction since the CLI resumes its own session.
 */
export function composeWorkshopPrompt(params: {
	readonly message: string;
	readonly corePrompt?: string;
	readonly isContinuation: boolean;
}): string {
	const brief = params.message.trim();
	const core = params.corePrompt?.trim();
	if (!params.isContinuation && core !== undefined && core.length > 0) {
		return `[Owner Core Preferences]\n${core}\n\n[Task Brief]\n${brief}`;
	}
	return brief;
}

/** Bounds raw CLI stdout/stderr so tens of thousands of compiler log lines never flood the main conversation. */
export function truncateWorkshopAgentOutput(
	stdout: string,
	stderr: string,
	exitCode: number,
	maxChars: number = MAX_WORKSHOP_REPORT_CHARS,
): string {
	const trimmedOut = stdout.trim();
	const trimmedErr = stderr.trim();
	const combined =
		exitCode === 0
			? trimmedOut.length > 0
				? trimmedOut
				: trimmedErr
			: [trimmedOut, trimmedErr ? `[stderr]\n${trimmedErr}` : ""].filter((s) => s.length > 0).join("\n\n");

	if (combined.length === 0) return "(no output)";
	if (combined.length <= maxChars) return combined;

	const headBudget = Math.floor(maxChars * 0.25);
	const tailBudget = maxChars - headBudget - 64;
	const omitted = combined.length - headBudget - tailBudget;
	return `${combined.slice(0, headBudget)}\n\n...[truncated ${omitted} chars of raw workshop logs]...\n\n${combined.slice(combined.length - tailBudget)}`;
}

/** Formats the structured completion/failure report handed back to the main conversation. */
export function formatWorkshopCompletionReport(params: {
	readonly taskName: string;
	readonly driver: string;
	readonly cwd: string;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly gitSummary?: string;
}): string {
	const statusWord = params.exitCode === 0 ? "completed" : `failed (exit=${params.exitCode})`;
	const boundedOutput = truncateWorkshopAgentOutput(params.stdout, params.stderr, params.exitCode);
	const sections = [
		`[workshop:${params.taskName} ${statusWord} | driver=${params.driver} | cwd=${params.cwd}]`,
		boundedOutput,
	];
	if (params.gitSummary !== undefined && params.gitSummary.trim().length > 0) {
		sections.push(params.gitSummary.trim());
	}
	return sections.join("\n\n");
}
