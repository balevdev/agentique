import * as assert from "node:assert/strict";
import skywalkerExtension from "./index";

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

	skywalkerExtension(pi as any);
	return { commands, sent, customEntries, statuses, widgets, notifications, ctx };
}

async function run() {
	{
		const harness = makeHarness();
		await harness.commands.get("skywalker")?.("review apps/api --concurrency 4 --worktree isolated", harness.ctx);
		assert.equal(harness.sent.length, 1);
		assert.match(harness.sent[0], /Use the skywalker-workflows skill/);
		assert.match(harness.sent[0], /Mode: review/);
		assert.match(harness.sent[0], /Target: apps\/api/);
		assert.match(harness.sent[0], /Artifact root: \.team-review/);
		assert.match(harness.sent[0], /Max concurrency: 4/);
		assert.match(harness.sent[0], /Worktree mode: isolated/);
		assert.match(harness.sent[0], /Use Pi subagents/);
		assert.match(harness.sent[0], /single writer/i);
		assert.match(harness.sent[0], /approval before any code-writing owner/);
	}

	{
		const harness = makeHarness();
		await harness.commands.get("skywalker-preview")?.("build add saved search", harness.ctx);
		assert.equal(harness.sent.length, 0);
		assert.match(harness.notifications[0], /Mode: build/);
		assert.match(harness.notifications[0], /Target: add saved search/);
	}

	{
		const harness = makeHarness();
		await harness.commands.get("skywalker-preview")?.("audit apps/api auth checks", harness.ctx);
		assert.equal(harness.sent.length, 0);
		assert.match(harness.notifications[0], /Mode: review/);
		assert.match(harness.notifications[0], /Target: audit apps\/api auth checks/);
	}

	{
		const existingState = {
			type: "custom",
			customType: "skywalker-state",
			data: {
				mode: "review",
				target: "apps/api",
				concurrency: 3,
				worktree: "single-tree",
				artifactRoot: ".team-review",
				createdAt: "2026-06-03T00:00:00.000Z",
			},
		};
		const clearedState = { type: "custom", customType: "skywalker-state", data: { cleared: true } };
		const harness = makeHarness([existingState, clearedState]);
		await harness.commands.get("skywalker-status")?.("", harness.ctx);
		assert.equal(harness.statuses.get("skywalker"), undefined);
		assert.equal(harness.widgets.get("skywalker"), undefined);
		assert.match(harness.notifications[0], /No Skywalker sprint/);
	}
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
