import assert from "node:assert/strict";
import test from "node:test";
import retryExtension from "../429-retry.ts";

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

function restoreFetch() {
	if (originalFetchDescriptor) {
		Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
	} else {
		delete globalThis.fetch;
	}
}

function createPi() {
	const commands = new Map();
	const events = new Map();
	const widgets = [];
	const context = {
		ui: {
			theme: { fg: (_color, text) => text },
			notify() {},
			setWidget(key, value, options) {
				widgets.push({ key, value, options });
			},
		},
	};
	return {
		commands,
		events,
		widgets,
		context,
		registerCommand(name, command) {
			commands.set(name, command.handler);
		},
		on(name, handler) {
			events.set(name, handler);
		},
	};
}

function createStaleContext() {
	const ctx = {};
	Object.defineProperty(ctx, "ui", {
		get() {
			throw new Error(
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
			);
		},
	});
	return ctx;
}

function attachContext(pi) {
	pi.events.get("after_provider_response")({ status: 200 }, pi.context);
}

async function setWaitTime(pi, seconds = "1") {
	await pi.commands.get("429-retry")(seconds, { ui: { notify() {} } });
}

test("hard usage-limit responses from ZAI surface immediately", async () => {
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return new Response(JSON.stringify({
			error: {
				code: "1308",
				message: "已达到 5 小时的使用上限。您的限额将在 2026-08-28 14:39:40 重置。",
			},
		}), { status: 429, headers: { "content-type": "application/json" } });
	};

	try {
		const pi = createPi();
		retryExtension(pi);
		attachContext(pi);
		await setWaitTime(pi);

		const started = performance.now();
		const response = await globalThis.fetch("https://example.test");

		assert.equal(response.status, 429);
		assert.equal(calls, 1);
		assert.ok(performance.now() - started < 250);
		assert.ok(pi.widgets.every(({ value }) => value === undefined));
	} finally {
		restoreFetch();
	}
});

test("future reset times in rate-limit bodies surface immediately", async () => {
	let calls = 0;
	const resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
	globalThis.fetch = async () => {
		calls++;
		return new Response(`Usage quota resets at ${resetAt}`, { status: 429 });
	};

	try {
		const pi = createPi();
		retryExtension(pi);
		await setWaitTime(pi);

		const started = performance.now();
		const response = await globalThis.fetch("https://example.test");

		assert.equal(response.status, 429);
		assert.equal(calls, 1);
		assert.ok(performance.now() - started < 250);
	} finally {
		restoreFetch();
	}
});

test("Esc aborts a transient 429 wait before the next request", async () => {
	let calls = 0;
	globalThis.fetch = async (_input, init) => {
		calls++;
		if (calls === 1) return new Response("temporary rate limit", { status: 429 });
		const error = new Error("aborted");
		error.name = "AbortError";
		if (init?.signal?.aborted) throw error;
		throw new Error("unexpected retry");
	};

	try {
		const pi = createPi();
		retryExtension(pi);
		attachContext(pi);
		await setWaitTime(pi);

		const controller = new AbortController();
		const started = performance.now();
		const request = globalThis.fetch("https://example.test", { signal: controller.signal });
		setTimeout(() => controller.abort(), 20);

		await assert.rejects(request, { name: "AbortError" });
		assert.equal(calls, 1);
		assert.ok(performance.now() - started < 250);
		assert.equal(pi.widgets.at(-1).value, undefined);
	} finally {
		restoreFetch();
	}
});

test("transient ZAI overload responses remain retryable", async () => {
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		if (calls === 1) {
			return new Response(JSON.stringify({
				error: { code: "1305", message: "该模型当前访问量过大，请您稍后再试" },
			}), { status: 429, headers: { "content-type": "application/json" } });
		}
		return new Response("ok", { status: 200 });
	};

	try {
		const pi = createPi();
		retryExtension(pi);
		await setWaitTime(pi);

		const response = await globalThis.fetch("https://example.test");
		assert.equal(response.status, 200);
		assert.equal(calls, 2);
	} finally {
		restoreFetch();
	}
});

test("fetch replacement updates the retry wrapper's underlying fetch", async () => {
	globalThis.fetch = async () => new Response("original", { status: 200 });

	try {
		const pi = createPi();
		retryExtension(pi);
		let replacementCalls = 0;
		globalThis.fetch = async () => {
			replacementCalls++;
			return new Response("replacement", { status: 200 });
		};

		const response = await globalThis.fetch("https://example.test");
		assert.equal(await response.text(), "replacement");
		assert.equal(replacementCalls, 1);
	} finally {
		restoreFetch();
	}
});

test("session_start cleanup timer does not crash on a stale ctx", async () => {
	try {
		const pi = createPi();
		retryExtension(pi);

		// 复现：session 替换后 3s 清理定时器触发，旧 ctx 的 ui getter 抛错
		// （未修复时 tick 会把 stale 错误作为 uncaughtException 抛出）
		test.mock.timers.enable({ apis: ["setTimeout"] });
		await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, createStaleContext());
		test.mock.timers.tick(3000);
	} finally {
		test.mock.timers.reset();
		restoreFetch();
	}
});

test("rate-limit countdown keeps retrying after ctx goes stale", async () => {
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		if (calls === 1) return new Response("slow down", { status: 429 });
		return new Response("ok", { status: 200 });
	};

	try {
		const pi = createPi();
		retryExtension(pi);
		await pi.events.get("after_provider_response")({ status: 200 }, createStaleContext());
		await setWaitTime(pi, "1");

		const response = await globalThis.fetch("https://example.test");

		assert.equal(response.status, 200);
		assert.equal(calls, 2);
	} finally {
		restoreFetch();
	}
});
