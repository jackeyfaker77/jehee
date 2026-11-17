// Programmatic Cucumber BDD runner using Node 24 native TypeScript stripping (zero ts-node / transpiler overhead).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration, runCucumber } from "@cucumber/cucumber/api";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { runConfiguration } = await loadConfiguration(
	{
		provided: {
			paths: ["features/**/*.feature"],
			import: ["features/support/**/*.ts", "features/steps/**/*.ts"],
			format: ["progress-bar", "summary"],
		},
	},
	{ cwd: appRoot },
);

const { success } = await runCucumber(runConfiguration, {
	cwd: appRoot,
	stdout: process.stdout,
	stderr: process.stderr,
});

if (!success) {
	process.exit(1);
}
