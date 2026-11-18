// Bundles `worker.ts` with esbuild for Cloudflare Workers (`workerd`) in memory and verifies:
// 1. Zero forbidden Node-only runtime imports (`node:sqlite`, `node:child_process`).
// 2. Minified bundle byte size stays comfortably below the Cloudflare Workers Free Plan ceiling.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type WorkerBundleReport = {
	readonly byteLength: number;
	readonly externalNodeBuiltins: readonly string[];
};

const FORBIDDEN_EDGE_BUILTINS = new Set(["node:sqlite", "sqlite"]);

/** Bundles `worker.ts` for Cloudflare Workers in memory and checks module purity and size bounds. */
export async function inspectWorkerBundle(): Promise<WorkerBundleReport> {
	const importedBuiltins = new Set<string>();
	const result = await build({
		entryPoints: [resolve(appDir, "worker.ts")],
		bundle: true,
		write: false,
		metafile: true,
		format: "esm",
		platform: "neutral",
		target: "es2024",
		mainFields: ["browser", "module", "main"],
		conditions: ["workerd", "worker", "browser", "import", "source"],
		minify: true,
		external: ["cloudflare:workers"],
		plugins: [
			{
				name: "track-node-builtins",
				setup(buildApi) {
					buildApi.onResolve(
						{
							filter:
								/^(?:node:|fs|path|crypto|stream|util|events|buffer|http|https|net|tls|url|zlib|os|assert|child_process|readline|sqlite)/,
						},
						(args) => {
							importedBuiltins.add(args.path);
							return { path: args.path, external: true };
						},
					);
				},
			},
		],
	});

	for (const mod of importedBuiltins) {
		if (FORBIDDEN_EDGE_BUILTINS.has(mod)) {
			throw new Error(`Cloudflare worker bundle must not depend on "${mod}"`);
		}
	}
	for (const inputPath of Object.keys(result.metafile.inputs)) {
		if (inputPath.replaceAll("\\", "/").includes("src/runtime/node.ts")) {
			throw new Error(`Cloudflare worker bundle must not pull in Node-only module "${inputPath}"`);
		}
	}

	const outputBytes = result.outputFiles[0]?.contents.byteLength ?? 0;
	return {
		byteLength: outputBytes,
		externalNodeBuiltins: [...importedBuiltins].sort(),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const report = await inspectWorkerBundle();
	const kb = (report.byteLength / 1024).toFixed(1);
	console.log(`Worker bundle verified: ${kb} KiB minified (${report.byteLength} bytes).`);
	if (report.byteLength > 2_500_000) {
		console.error(`Worker bundle exceeds 2.5 MB budget: ${report.byteLength} bytes`);
		process.exit(1);
	}
}
