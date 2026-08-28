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
	return {
		commands,
		registerCommand(name, command) {
			commands.set(name, command.handler);
		},
		on() {},
	};
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
		await setWaitTime(pi);

		const controller = new AbortController();
		const started = performance.now();
		const request = globalThis.fetch("https://example.test", { signal: controller.signal });
		setTimeout(() => controller.abort(), 20);

		await assert.rejects(request, { name: "AbortError" });
		assert.equal(calls, 1);
		assert.ok(performance.now() - started < 250);
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
