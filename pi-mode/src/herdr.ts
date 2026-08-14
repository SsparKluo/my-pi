import { createConnection } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOURCE = "pi-mode";
const SOCKET_TIMEOUT_MS = 800;

export function isHerdrEnv(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
}

/** Agents-panel line 2: `pi · plan`. Hidden for default (vanilla). */
export function displayAgentLabel(mode: string | undefined): string | null {
	if (!mode || mode === "default") return null;
	return `pi · ${mode}`;
}

export function setHerdrBlocked(pi: ExtensionAPI, active: boolean, label?: string): void {
	try {
		pi.events.emit("herdr:blocked", { active, label });
	} catch {
		/* herdr-agent-state may be absent */
	}
}

export function reportHerdrMode(mode: string | undefined): void {
	if (!isHerdrEnv()) return;
	const label = displayAgentLabel(mode);
	void herdrRequest("pane.report_metadata", {
		pane_id: process.env.HERDR_PANE_ID,
		source: SOURCE,
		display_agent: label,
		clear_display_agent: !label,
	});
}

function herdrRequest(method: string, params: Record<string, unknown>): Promise<void> {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	if (!socketPath) return Promise.resolve();

	const id = `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve();
		};
		const socket = createConnection(socketPath);
		const timer = setTimeout(finish, SOCKET_TIMEOUT_MS);
		timer.unref?.();
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
		socket.on("data", finish);
		socket.on("error", finish);
		socket.on("end", finish);
	});
}
