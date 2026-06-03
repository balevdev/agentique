type SkywalkerMode = "build" | "review";
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

interface SkywalkerConfig {
	mode: SkywalkerMode;
	target: string;
	concurrency: number;
	worktree: WorktreeMode;
	artifactRoot: ".mission-control" | ".team-review";
}

interface SkywalkerState extends SkywalkerConfig {
	createdAt: string;
}

const MODES = new Set(["build", "review"]);
const WORKTREE_MODES = new Set(["single-tree", "isolated"]);
const MODE_ITEMS = ["review - audit, harden, and fix", "build - implement a sliced roadmap or feature"];
const CONCURRENCY_ITEMS = ["2", "3", "4", "6"];
const WORKTREE_ITEMS = ["single-tree", "isolated"];

export default function skywalkerExtension(pi: ExtensionAPI) {
	let state: SkywalkerState | undefined;

	function parseArgs(input: string): SkywalkerConfig {
		const tokens = (input.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? []).map((token) => {
			if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
				return token.slice(1, -1);
			}
			return token;
		});
		const first = tokens.shift();
		const mode = MODES.has(first ?? "") ? (first as SkywalkerMode) : "review";
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

		return {
			mode,
			target: targetParts.join(" ").trim(),
			concurrency,
			worktree,
			artifactRoot: mode === "build" ? ".mission-control" : ".team-review",
		};
	}

	function buildPrompt(config: SkywalkerConfig): string {
		return [
			"Use the skywalker-workflows skill and run this as a Pi-native Skywalker sprint.",
			"",
			`Mode: ${config.mode}`,
			`Target: ${config.target}`,
			`Artifact root: ${config.artifactRoot}`,
			`Max concurrency: ${config.concurrency}`,
			`Worktree mode: ${config.worktree}`,
			"",
			"Use Pi subagents instead of Claude Code dynamic workflows. Prefer async chain orchestration with explicit phase labels, file-only artifacts for large handoffs, and fresh-context independent verifiers.",
			"",
			"Required flow:",
			"1. Ground the repo and write GROUNDING.md under the artifact root. Record baseline commands and current pass/fail state.",
			"2. Shape disjoint slices and write SLICES.md plus one contract per slice. Ask for approval before any code-writing owner or review-fix owner starts.",
			"3. Launch owners through Pi subagents. Keep a single writer per artifact and no overlapping write paths. Use one writer by default unless disjoint paths or isolated worktrees make parallel writers safe.",
			"4. Launch independent verifiers that did not write the slice. They must inspect the real diff and try to refute each acceptance criterion before accepting.",
			"5. Gate in the parent session with the full repo check, route regressions to owners, and write SUMMARY.md.",
			"",
			"Stop and ask before changing product scope, architecture, or shared seams not approved in the contracts.",
		].join("\n");
	}

	function remember(config: SkywalkerConfig, ctx: ExtensionContext): void {
		state = { ...config, createdAt: new Date().toISOString() };
		pi.appendEntry("skywalker-state", state);
		updateUi(ctx);
	}

	function restore(ctx: ExtensionContext): void {
		const latest = ctx.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "skywalker-state")
			.pop();

		const candidate = latest?.data as Partial<SkywalkerState> | undefined;
		if (
			candidate &&
			(candidate.mode === "build" || candidate.mode === "review") &&
			typeof candidate.target === "string" &&
			typeof candidate.concurrency === "number" &&
			(candidate.worktree === "single-tree" || candidate.worktree === "isolated") &&
			(candidate.artifactRoot === ".mission-control" || candidate.artifactRoot === ".team-review")
		) {
			state = candidate as SkywalkerState;
		} else {
			state = undefined;
		}
		updateUi(ctx);
	}

	function clear(ctx: ExtensionContext): void {
		state = undefined;
		pi.appendEntry("skywalker-state", { cleared: true });
		ctx.ui.setStatus("skywalker", undefined);
		ctx.ui.setWidget("skywalker", undefined);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!state) {
			ctx.ui.setStatus("skywalker", undefined);
			ctx.ui.setWidget("skywalker", undefined);
			return;
		}

		ctx.ui.setStatus("skywalker", ctx.ui.theme.fg("accent", `skywalker:${state.mode}`));
		ctx.ui.setWidget("skywalker", [
			ctx.ui.theme.fg("accent", `Skywalker ${state.mode} sprint`),
			ctx.ui.theme.fg("muted", `target: ${state.target || "not set"}`),
			ctx.ui.theme.fg("muted", `root: ${state.artifactRoot} - concurrency: ${state.concurrency} - ${state.worktree}`),
		]);
	}

	async function runWizard(ctx: ExtensionContext): Promise<SkywalkerConfig | null> {
		const modeChoice = await ctx.ui.select("Skywalker mode", MODE_ITEMS);
		if (!modeChoice) return null;
		const mode = modeChoice.startsWith("build") ? "build" : "review";

		const target = await ctx.ui.input(
			"Skywalker target",
			mode === "build" ? "Feature, roadmap, or goal to build" : "Repo scope or review goal",
		);
		if (!target.trim()) {
			ctx.ui.notify("Skywalker target is required", "warning");
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
			artifactRoot: mode === "build" ? ".mission-control" : ".team-review",
		};
	}

	function normalize(config: SkywalkerConfig): SkywalkerConfig | null {
		return config.target.trim() ? config : null;
	}

	async function launch(config: SkywalkerConfig, ctx: ExtensionContext): Promise<void> {
		remember(config, ctx);
		const prompt = buildPrompt(config);
		if (ctx.isIdle()) {
			pi.sendUserMessage(prompt);
		} else {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			ctx.ui.notify("Skywalker sprint queued as a follow-up", "info");
		}
	}

	pi.registerCommand("skywalker", {
		description: "Start a Pi-native Skywalker multi-agent sprint",
		handler: async (args, ctx) => {
			restore(ctx);
			const config = args.trim() ? normalize(parseArgs(args)) : await runWizard(ctx);
			if (!config) {
				ctx.ui.notify(
					"Usage: /skywalker review <scope> [--concurrency 3] [--worktree single-tree|isolated]",
					"warning",
				);
				return;
			}
			await launch(config, ctx);
		},
	});

	pi.registerCommand("skywalker-preview", {
		description: "Preview the Skywalker kickoff prompt without launching it",
		handler: async (args, ctx) => {
			const config = normalize(parseArgs(args));
			if (!config) {
				ctx.ui.notify("Usage: /skywalker-preview review <scope>", "warning");
				return;
			}
			ctx.ui.notify(buildPrompt(config), "info");
		},
	});

	pi.registerCommand("skywalker-status", {
		description: "Show the last Skywalker sprint config",
		handler: async (_args, ctx) => {
			restore(ctx);
			if (!state) {
				ctx.ui.notify("No Skywalker sprint in this session", "info");
				return;
			}
			ctx.ui.notify(
				`${state.mode}: ${state.target} (${state.artifactRoot}, concurrency ${state.concurrency}, ${state.worktree})`,
				"info",
			);
			updateUi(ctx);
		},
	});

	pi.registerCommand("skywalker-clear", {
		description: "Clear Skywalker status widgets",
		handler: async (_args, ctx) => {
			clear(ctx);
			ctx.ui.notify("Skywalker status cleared", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
	});
}
