type VaderMode = "build" | "review";
type WorktreeMode = "single-tree" | "isolated";

type NotifyLevel = "info" | "warning" | "error";

interface ExtensionAPI {
	registerCommand(name: string, options: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void;
	on(eventName: "session_start", handler: (_event: unknown, ctx: ExtensionContext) => Promise<void>): void;
	appendEntry(customType: string, data: unknown): void;
	sendUserMessage(content: string, options?: { deliverAs: "followUp" }): void;
}

interface ExtensionContext {
	isIdle(): boolean;
	sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
	ui: {
		theme: { fg(name: string, text: string): string };
		setStatus(key: string, value: string | undefined): void;
		setWidget(key: string, value: string[] | undefined): void;
		notify(message: string, level?: NotifyLevel): void;
		select(title: string, items: string[]): Promise<string | null>;
		input(title: string, placeholder?: string): Promise<string>;
	};
}

interface VaderConfig {
	mode: VaderMode;
	target: string;
	concurrency: number;
	worktree: WorktreeMode;
}

interface VaderState extends VaderConfig {
	createdAt: string;
}

const MODES = new Set(["build", "review"]);
const WORKTREE_MODES = new Set(["single-tree", "isolated"]);
const MODE_ITEMS = ["review - audit, harden, and fix against the constitution", "build - implement the next roadmap item"];
const CONCURRENCY_ITEMS = ["2", "3", "4", "6"];
const WORKTREE_ITEMS = ["single-tree", "isolated"];

export default function vaderExtension(pi: ExtensionAPI) {
	let state: VaderState | undefined;

	function parseArgs(input: string): VaderConfig {
		const tokens = (input.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? []).map((token) => {
			if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
				return token.slice(1, -1);
			}
			return token;
		});
		const first = tokens.shift();
		const mode = MODES.has(first ?? "") ? (first as VaderMode) : "review";
		if (!MODES.has(first ?? "") && first) tokens.unshift(first);

		let concurrency = 3;
		let worktree: WorktreeMode = "single-tree";
		const targetParts: string[] = [];

		for (let index = 0; index < tokens.length; index += 1) {
			const token = tokens[index];
			if (token === "--concurrency") {
				const parsed = Number.parseInt(tokens[index + 1] ?? "", 10);
				if (Number.isFinite(parsed) && parsed > 0) concurrency = Math.min(parsed, 16);
				index += 1;
				continue;
			}
			if (token === "--worktree") {
				const value = tokens[index + 1];
				if (WORKTREE_MODES.has(value ?? "")) worktree = value as WorktreeMode;
				index += 1;
				continue;
			}
			targetParts.push(token ?? "");
		}

		return { mode, target: targetParts.join(" ").trim(), concurrency, worktree };
	}

	// The kickoff prompt is the contract every harness shares: it tells the agent to drive the
	// SAME deterministic loop the engine encodes (recall -> planTick fan-out -> gate -> persist),
	// using Pi subagents in place of Claude Code workflows. The factory invariants (anti-decay
	// model lock, ledger-last persist, independent verifiers, never-ratchet seams) are restated
	// here so a Pi run cannot quietly diverge from the Claude path.
	function buildPrompt(config: VaderConfig): string {
		return [
			"Use the vader skill and run this as a Pi-native vader tick.",
			"",
			`Mode: ${config.mode}`,
			`Target: ${config.target}`,
			`Max concurrency: ${config.concurrency}`,
			`Worktree mode: ${config.worktree}`,
			"",
			"Drive the loop with Pi subagents instead of Claude Code workflows. The plan is NOT yours to invent: it comes from the engine.",
			"",
			"Required flow:",
			"1. Run `vader recall --root .` and read the packet. If `modelOk` is false or the model hash is unlocked, STOP and surface it; do not run a gate against an unlocked model.",
			"2. Compute the tick plan with `planTick(recall)` (exported from the vader engine). Run `seamFirst` slices sequentially FIRST (they touch shared seams), then run `siblings` as parallel Pi subagents up to the max concurrency.",
			"3. Honor each slice's `voters`: spawn that many INDEPENDENT verifier subagents (a verifier never wrote the slice) and require them to refute each acceptance criterion against the real diff before accepting. A seam, never-ratchet, or previously-bounced class gets the full panel; do not collapse it.",
			"4. Keep one writer per artifact and no overlapping write paths. Use isolated worktrees only when slices share paths.",
			"5. Gate in the parent session with `vader gate --root .`. It fails closed on a model-hash mismatch and on any configured-but-failing check. Route every regression back to its slice owner.",
			"6. Persist with `vader persist <run-report.json> --root .`. The engine writes state first and appends the LEDGER run-line LAST as the commit marker, so a crash is always safe to re-run. A run may PROPOSE a model change; it never applies one.",
			"",
			"Stop and ask before changing product scope, a shared seam, or any constitution invariant not already approved.",
		].join("\n");
	}

	function remember(config: VaderConfig, ctx: ExtensionContext): void {
		state = { ...config, createdAt: new Date().toISOString() };
		pi.appendEntry("vader-state", state);
		updateUi(ctx);
	}

	function restore(ctx: ExtensionContext): void {
		const latest = ctx.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "vader-state")
			.pop();

		const candidate = latest?.data as Partial<VaderState> | undefined;
		if (
			candidate &&
			(candidate.mode === "build" || candidate.mode === "review") &&
			typeof candidate.target === "string" &&
			typeof candidate.concurrency === "number" &&
			(candidate.worktree === "single-tree" || candidate.worktree === "isolated")
		) {
			state = candidate as VaderState;
		} else {
			state = undefined;
		}
		updateUi(ctx);
	}

	function clear(ctx: ExtensionContext): void {
		state = undefined;
		pi.appendEntry("vader-state", { cleared: true });
		ctx.ui.setStatus("vader", undefined);
		ctx.ui.setWidget("vader", undefined);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!state) {
			ctx.ui.setStatus("vader", undefined);
			ctx.ui.setWidget("vader", undefined);
			return;
		}

		ctx.ui.setStatus("vader", ctx.ui.theme.fg("accent", `vader:${state.mode}`));
		ctx.ui.setWidget("vader", [
			ctx.ui.theme.fg("accent", `vader ${state.mode} tick`),
			ctx.ui.theme.fg("muted", `target: ${state.target || "not set"}`),
			ctx.ui.theme.fg("muted", `concurrency: ${state.concurrency} - ${state.worktree}`),
		]);
	}

	async function runWizard(ctx: ExtensionContext): Promise<VaderConfig | null> {
		const modeChoice = await ctx.ui.select("vader mode", MODE_ITEMS);
		if (!modeChoice) return null;
		const mode = modeChoice.startsWith("build") ? "build" : "review";

		const target = await ctx.ui.input(
			"vader target",
			mode === "build" ? "Roadmap item or feature to build" : "Repo scope or review goal",
		);
		if (!target.trim()) {
			ctx.ui.notify("vader target is required", "warning");
			return null;
		}

		const concurrencyChoice = await ctx.ui.select("Max concurrency", CONCURRENCY_ITEMS);
		if (!concurrencyChoice) return null;

		const worktreeChoice = await ctx.ui.select("Worktree mode", WORKTREE_ITEMS);
		if (!worktreeChoice) return null;

		return {
			mode,
			target: target.trim(),
			concurrency: Number.parseInt(concurrencyChoice, 10),
			worktree: worktreeChoice as WorktreeMode,
		};
	}

	function normalize(config: VaderConfig): VaderConfig | null {
		return config.target.trim() ? config : null;
	}

	async function launch(config: VaderConfig, ctx: ExtensionContext): Promise<void> {
		remember(config, ctx);
		const prompt = buildPrompt(config);
		if (ctx.isIdle()) {
			pi.sendUserMessage(prompt);
		} else {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			ctx.ui.notify("vader tick queued as a follow-up", "info");
		}
	}

	pi.registerCommand("vader", {
		description: "Start a Pi-native vader tick (recall, planTick fan-out, gate, persist)",
		handler: async (args, ctx) => {
			restore(ctx);
			const config = args.trim() ? normalize(parseArgs(args)) : await runWizard(ctx);
			if (!config) {
				ctx.ui.notify(
					"Usage: /vader review <scope> [--concurrency 3] [--worktree single-tree|isolated]",
					"warning",
				);
				return;
			}
			await launch(config, ctx);
		},
	});

	pi.registerCommand("vader-preview", {
		description: "Preview the vader kickoff prompt without launching it",
		handler: async (args, ctx) => {
			const config = normalize(parseArgs(args));
			if (!config) {
				ctx.ui.notify("Usage: /vader-preview review <scope>", "warning");
				return;
			}
			ctx.ui.notify(buildPrompt(config), "info");
		},
	});

	pi.registerCommand("vader-status", {
		description: "Show the last vader tick config",
		handler: async (_args, ctx) => {
			restore(ctx);
			if (!state) {
				ctx.ui.notify("No vader tick in this session", "info");
				return;
			}
			ctx.ui.notify(
				`${state.mode}: ${state.target} (concurrency ${state.concurrency}, ${state.worktree})`,
				"info",
			);
			updateUi(ctx);
		},
	});

	pi.registerCommand("vader-clear", {
		description: "Clear vader status widgets",
		handler: async (_args, ctx) => {
			clear(ctx);
			ctx.ui.notify("vader status cleared", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
	});
}
