import * as assert from "node:assert/strict";
import vaderExtension from "./index";

function makeHarness(entries: Array<Record<string, unknown>> = []) {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const sent: string[] = [];
	const customEntries: Array<{ customType: string; data: unknown }> = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const notifications: string[] = [];

	const pi = {
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, options.handler);
		},
		on() {},
		appendEntry(customType: string, data: unknown) {
			customEntries.push({ customType, data });
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
	};

	const ctx = {
		isIdle: () => true,
		sessionManager: { getEntries: () => entries },
		ui: {
			theme: {
				fg: (_name: string, text: string) => text,
			},
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			setWidget: (key: string, value: string[] | undefined) => widgets.set(key, value),
			notify: (message: string) => notifications.push(message),
			select: async () => null,
			input: async () => "",
		},
	};

	vaderExtension(pi as any);
	return { commands, sent, customEntries, statuses, widgets, notifications, ctx };
}

async function run() {
	{
		// A launched tick sends one kickoff that restates the deterministic engine loop.
		const harness = makeHarness();
		await harness.commands.get("vader")?.("review apps/api --concurrency 4 --worktree isolated", harness.ctx);
		assert.equal(harness.sent.length, 1);
		assert.match(harness.sent[0], /Use the vader skill/);
		assert.match(harness.sent[0], /Mode: review/);
		assert.match(harness.sent[0], /Target: apps\/api/);
		assert.match(harness.sent[0], /Max concurrency: 4/);
		assert.match(harness.sent[0], /Worktree mode: isolated/);
		assert.match(harness.sent[0], /vader recall/);
		assert.match(harness.sent[0], /planTick/);
		assert.match(harness.sent[0], /seamFirst/);
		assert.match(harness.sent[0], /INDEPENDENT verifier/);
		assert.match(harness.sent[0], /vader gate/);
		assert.match(harness.sent[0], /LEDGER run-line LAST/);
		assert.match(harness.sent[0], /never applies/);
		// Launching remembers the tick so a session restart can restore it.
		assert.equal(harness.customEntries[0]?.customType, "vader-state");
	}

	{
		// Preview must not launch anything; it only renders the prompt.
		const harness = makeHarness();
		await harness.commands.get("vader-preview")?.("build add saved search", harness.ctx);
		assert.equal(harness.sent.length, 0);
		assert.match(harness.notifications[0], /Mode: build/);
		assert.match(harness.notifications[0], /Target: add saved search/);
	}

	{
		// Default mode is review when the first token is not a known mode.
		const harness = makeHarness();
		await harness.commands.get("vader-preview")?.("audit apps/api auth checks", harness.ctx);
		assert.equal(harness.sent.length, 0);
		assert.match(harness.notifications[0], /Mode: review/);
		assert.match(harness.notifications[0], /Target: audit apps\/api auth checks/);
	}

	{
		// A cleared state is the last entry, so status reports no active tick.
		const existingState = {
			type: "custom",
			customType: "vader-state",
			data: {
				mode: "review",
				target: "apps/api",
				concurrency: 3,
				worktree: "single-tree",
				createdAt: "2026-06-14T00:00:00.000Z",
			},
		};
		const clearedState = { type: "custom", customType: "vader-state", data: { cleared: true } };
		const harness = makeHarness([existingState, clearedState]);
		await harness.commands.get("vader-status")?.("", harness.ctx);
		assert.equal(harness.statuses.get("vader"), undefined);
		assert.equal(harness.widgets.get("vader"), undefined);
		assert.match(harness.notifications[0], /No vader tick/);
	}

	{
		// A valid prior tick is restored and surfaced on status.
		const existingState = {
			type: "custom",
			customType: "vader-state",
			data: {
				mode: "build",
				target: "roadmap I3",
				concurrency: 4,
				worktree: "isolated",
				createdAt: "2026-06-14T00:00:00.000Z",
			},
		};
		const harness = makeHarness([existingState]);
		await harness.commands.get("vader-status")?.("", harness.ctx);
		assert.match(harness.notifications[0], /build: roadmap I3/);
		assert.equal(harness.statuses.get("vader"), "vader:build");
	}
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
