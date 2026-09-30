/**
 * computer-use demo driver — NOT a pi extension.
 *
 * Runs the same core loop the extension uses, against a real X11 desktop:
 *   1. spawn an xmessage dialog with an OK button (visible, deterministic target)
 *   2. ask the local structured-output model to click OK and finish
 *   3. verify the dialog actually closed (xdotool search)
 *   4. write all evidence under extensions/computer-use/artifacts/<stamp>/
 *
 * Usage:
 *   COMPUTER_USE_DRY_RUN=1 node <jiti> demo.ts     # no GUI/GPU writes; argv check only
 *   node <jiti> demo.ts                            # live demo (requires X11 + llama-swap)
 *
 * Env: see core.ts defaultConfigFromEnv (COMPUTER_USE_MODEL, DISPLAY, ...).
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigFromEnv, getScreenGeometry, runTask, selfTest } from "./core";
import { isolateInput, restoreStray } from "./input-isolation";

const HERE = dirname(fileURLToPath(import.meta.url));

function xdotool(args: string[]): string {
	return execFileSync("xdotool", args, { env: { ...process.env, DISPLAY: DISPLAY }, encoding: "utf8" });
}

const DISPLAY = process.env.DISPLAY ?? ":0";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = join(HERE, "artifacts", stamp);
// Screenshots are ~10 MB per run; keep only the newest runs (probe-crop and preflight are controls, not runs).
const KEEP_RUNS = Number(process.env.COMPUTER_USE_KEEP_RUNS ?? 5);
function pruneArtifacts() {
	const root = join(HERE, "artifacts");
	if (!existsSync(root)) return;
	const runs = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort();
	for (const d of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) rmSync(join(root, d), { recursive: true, force: true });
}

async function main() {
	if (process.argv.includes("--selftest")) {
		selfTest();
		return;
	}
	if (process.argv.includes("--restore-input")) {
		restoreStray(process.env.DISPLAY ?? ":0");
		console.log("[demo] stray input isolation collapsed");
		return;
	}

	const cfg = defaultConfigFromEnv();
	cfg.display = DISPLAY;
	cfg.dryRun = process.env.COMPUTER_USE_DRY_RUN === "1";
	cfg.artifactDir = cfg.dryRun ? null : artifactDir;

	console.log(`[demo] display=${DISPLAY} model=${cfg.model} baseUrl=${cfg.baseUrl} dryRun=${cfg.dryRun}`);

	if (cfg.dryRun) {
		selfTest();
		return;
	}

	// Preconditions (fail loud, never half-run a demo).
	const geom = getScreenGeometry(cfg);
	console.log(`[demo] screen ${geom.w}x${geom.h}`);
	let existing = "";
	try {
		existing = execFileSync("xdotool", ["search", "--name", "CU-Demo"], {
			env: { ...process.env, DISPLAY },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		/* xdotool exits 1 when no window matches — that is the success case here */
	}
	if (existing) throw new Error(`a window named CU-Demo already exists (pids/wids: ${existing}); refusing to run`);

	pruneArtifacts();
	mkdirSync(artifactDir, { recursive: true });

	// MPX input isolation: the agent gets its own "CU-Agent" master cursor so
	// the user's mouse cannot displace the agent's synthetic input. Reversible;
	// recovery path: jiti demo.ts --restore-input
	const isolation = process.env.COMPUTER_USE_INPUT_ISOLATION !== "0";
	if (isolation) console.log("[demo] input isolation ON (CU-Agent master; recovery: jiti demo.ts --restore-input)");
	try {
		if (isolation) {
			const h = isolateInput(DISPLAY);
			cfg.agentPointer = h.agentPointer;
			console.log(`[demo] input isolated: agent drives CU-Agent pointer (id ${h.agentPointer}); core cursor stays with the user`);
		}
		// 1. spawn the target dialog. DEMO_TARGET=zenity runs Demo-2: a
		// realistic-size (~100px) button. Default xmessage stays Demo-1 (28x24px
		// extreme-target stress test) unchanged.
		const target = process.env.DEMO_TARGET ?? "xmessage";
		const dialogText =
			target === "zenity" ? "Computer-use demo 2: click OK to dismiss." : "Computer-use demo: click OK to dismiss.";
		const dialog =
			target === "zenity"
				? spawn("zenity", ["--info", "--title", "CU-Demo", "--ok-label", "OK", `--text=${dialogText}`], {
						env: { ...process.env, DISPLAY },
						detached: true,
						stdio: "ignore",
					})
				: spawn("xmessage", ["-title", "CU-Demo", "-buttons", "OK:0", dialogText], {
						env: { ...process.env, DISPLAY },
						detached: true,
						stdio: "ignore",
					});
		dialog.unref();
		await new Promise((r) => setTimeout(r, 800));

		// The WM places the dialog on whichever monitor has focus. Capture that
		// monitor (harness picks the MONITOR only; locating the button inside it
		// is still the model's job). COMPUTER_USE_REGION overrides.
		if (!cfg.region) {
			const wid = xdotool(["search", "--name", "CU-Demo"]).trim().split("\n")[0];
			const g = xdotool(["getwindowgeometry", "--shell", wid]);
			const num = (k: string) => Number(g.match(new RegExp(`${k}=(-?\\d+)`))?.[1]);
			const cx = num("X") + num("WIDTH") / 2;
			const cy = num("Y") + num("HEIGHT") / 2;
			const xr = execFileSync("xrandr", ["--query"], { env: { ...process.env, DISPLAY }, encoding: "utf8" });
			for (const m of xr.matchAll(/ connected (?:primary )?(\d+)x(\d+)\+(\d+)\+(\d+)/g)) {
				const [w, h, x, y] = m.slice(1).map(Number);
				if (cx >= x && cx < x + w && cy >= y && cy < y + h) cfg.region = `${w}x${h}+${x}+${y}`;
			}
			console.log(`[demo] dialog center (${cx},${cy}) -> capture region ${cfg.region}`);
		}

		// 2. run the loop
		const task =
			target === "zenity"
				? 'A dialog window is open showing the text "Computer-use demo 2: click OK to dismiss." with a large OK button below the text. Click the OK button to dismiss the dialog. Success = the dialog window is gone.'
				: 'A dialog window is open showing the text "Computer-use demo: click OK to dismiss." with an OK button at its bottom-left corner. Click the OK button to dismiss the dialog. Success = the dialog window is gone.';
		const result = await runTask(task, cfg);

		// 3. verify the dialog actually closed
		await new Promise((r) => setTimeout(r, 500));
		let remaining = "";
		try {
			remaining = execFileSync("xdotool", ["search", "--name", "CU-Demo"], {
				env: { ...process.env, DISPLAY },
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			/* xdotool exits nonzero when no window matches — that is success */
		}

		// Diagnostic only (does not affect the verdict): identify what matched.
		const remainingWindows = remaining
			.split("\n")
			.filter(Boolean)
			.map((wid) => {
				const q = (args: string[]) => {
					try {
						return xdotool(args).trim();
					} catch (e) {
						return `ERR ${String(e).split("\n")[0]}`;
					}
				};
				return { wid, name: q(["getwindowname", wid]), pid: q(["getwindowpid", wid]), geometry: q(["getwindowgeometry", wid]) };
			});

		const verdict = {
			task,
			model: cfg.model,
			dialog_closed: remaining === "",
			remaining_windows: remainingWindows,
			model_claimed_done: result.done,
			steps: result.steps.length,
			displaced_clicks: result.steps.filter((s) => s.displaced).length,
			verdict: result.done && remaining === "" ? "PASS" : "FAIL",
			artifact_dir: artifactDir,
		};
		writeFileSync(join(artifactDir, "verdict.json"), JSON.stringify(verdict, null, 2));
		console.log(`[demo] verdict: ${verdict.verdict} (dialog_closed=${verdict.dialog_closed}, model_claimed_done=${result.done}, steps=${result.steps.length}, displaced_clicks=${verdict.displaced_clicks})`);
		console.log(`[demo] artifacts: ${artifactDir}`);
		if (verdict.verdict !== "PASS") process.exitCode = 1;
	} finally {
		if (isolation) {
			restoreStray(DISPLAY); // idempotent full collapse, safe after partial setup
			console.log("[demo] input restored: single core pointer");
		}
	}
}

main().catch((e) => {
	console.error("[demo] FAILED:", e);
	process.exitCode = 1;
});
