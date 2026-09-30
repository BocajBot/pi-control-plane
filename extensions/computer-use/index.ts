/**
 * computer-use: pi extension wrapper around the perception/action sidecar
 * in ./core.ts.
 *
 * INSTALL (manual by design — agent config is control-plane-protected):
 *   cp -r extensions/computer-use ~/.pi/agent/extensions/
 * or load ad hoc during development:
 *   pi --extension ./extensions/computer-use/index.ts
 *
 * The main agent calls ONE tool per GUI task; the screenshot->action loop runs
 * against the local llama-swap endpoint (structured-output model), so the
 * main agent pays one tool call instead of one vision turn per GUI step.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { defaultConfigFromEnv, runTask, type TaskResult } from "./core";
import { isolateInput, restoreStray } from "./input-isolation";

const computerUseTool = defineTool({
	name: "computer_use",
	label: "Computer Use",
	description:
		"Drive the local GUI to perform a desktop task (click, type, scroll, app control) via the local structured-output computer-use model. Returns when the task is done or the step budget is spent.",
	promptSnippet: "Delegate a GUI/desktop task to the local computer-use sidecar",
	promptGuidelines: [
		"Use computer_use for tasks that require interacting with GUI windows: clicking buttons, filling forms, opening/closing applications.",
		"Describe the goal and the visible target precisely (window title, button label, field name).",
		"Do not use computer_use to type shell commands or credentials; use bash tools for the shell.",
	],
	parameters: Type.Object({
		task: Type.String({ description: "The desktop goal, including how success is visible (e.g. 'click OK in the dialog titled X; success = the dialog closes')" }),
		max_steps: Type.Optional(Type.Number({ description: "Perception/action iteration cap (default 8)" })),
	}),

	async execute(_toolCallId, params) {
		const cfg = defaultConfigFromEnv();
		if (params.max_steps !== undefined) cfg.maxSteps = params.max_steps;
		// MPX isolation: agent input cannot be displaced by the user's mouse
		// (and vice versa). Idempotent restore in finally; opt out with
		// COMPUTER_USE_INPUT_ISOLATION=0.
		const isolation = process.env.COMPUTER_USE_INPUT_ISOLATION !== "0";
		let result: TaskResult;
		try {
			if (isolation) cfg.agentPointer = isolateInput(cfg.display).agentPointer;
			result = await runTask(params.task, cfg);
		} finally {
			if (isolation) restoreStray(cfg.display);
		}
		const summary = result.done
			? `Done in ${result.steps.length} steps: ${result.final_answer}`
			: `Not done in ${result.steps.length} steps${result.error ? ` (error: ${result.error})` : ""}`;
		return {
			content: [{ type: "text", text: summary }],
			details: result as TaskResult,
		};
	},

	renderResult(result, _options, theme) {
		const details = result.details as TaskResult | undefined;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}
		const lines = [
			theme.fg("toolTitle", theme.bold(details.done ? "computer-use: done" : "computer-use: not done")),
			theme.fg("text", details.final_answer ?? details.error ?? ""),
			"",
			...details.steps.map(
				(s) => theme.fg("muted", `${s.step}. ${s.action.action} ${s.action.thought}`),
			),
		];
		return new Text(lines.join("\n"), 0, 0);
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(computerUseTool);
}
