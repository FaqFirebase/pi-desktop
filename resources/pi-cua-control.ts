import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Pont entre l'agent OMP (session Pi Desktop) et le panneau Computer du fork
 * pi-desktop-cua : le serveur de contrôle HTTP du process main écoute sur
 * 127.0.0.1:<port aléatoire> et se découvre via <userData>/cua-control.json
 * { port, token }. Chaque requête porte Authorization: Bearer <token>.
 */

const BACKENDS = ["auto", "docker-vm", "docker-host", "proxmox-vm", "main-os"] as const;

interface Control {
	port: number;
	token: string;
}

interface ControlFailure {
	error: string;
}

function candidateUserDataDirs(): string[] {
	const dirs: string[] = [];
	const explicit = process.env.PI_DESKTOP_USER_DATA_DIR;
	if (explicit && explicit.trim()) dirs.push(explicit.trim());
	const appdata = process.env.APPDATA;
	if (appdata && appdata.trim()) dirs.push(join(appdata.trim(), "pi-desktop"));
	dirs.push(join(homedir(), ".pi-desktop-dev"));
	return dirs;
}

function loadControl(): Control | ControlFailure {
	const tried: string[] = [];
	for (const dir of candidateUserDataDirs()) {
		const file = join(dir, "cua-control.json");
		tried.push(file);
		if (!existsSync(file)) continue;
		let raw: { port?: unknown; token?: unknown };
		try {
			raw = JSON.parse(readFileSync(file, "utf-8")) as { port?: unknown; token?: unknown };
		} catch (error) {
			return { error: `cua-control.json illisible (${file}) : ${String(error)}` };
		}
		if (
			typeof raw.port === "number" &&
			Number.isInteger(raw.port) &&
			raw.port > 0 &&
			raw.port < 65536 &&
			typeof raw.token === "string" &&
			raw.token.length > 0
		) {
			return { port: raw.port, token: raw.token };
		}
		return { error: `cua-control.json invalide (${file}) : objet { port, token } attendu.` };
	}
	return {
		error: `Pi Desktop (fork CUA) non démarré : aucun fichier cua-control.json trouvé. Emplacements essayés : ${tried.join(", ")}.`,
	};
}

interface CallOptions {
	method: "GET" | "POST";
	path: string;
	body?: unknown;
	timeoutMs: number;
}

async function callControl(control: Control, options: CallOptions): Promise<{ status: number; json: unknown }> {
	const response = await fetch(`http://127.0.0.1:${control.port}${options.path}`, {
		method: options.method,
		headers: {
			authorization: `Bearer ${control.token}`,
			...(options.body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: AbortSignal.timeout(options.timeoutMs),
	});
	const text = await response.text();
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = text;
	}
	return { status: response.status, json };
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	return { content: [{ type: "text", text }], details: { text } };
}

/** Un appel aller simple vers le serveur de contrôle, rendu en texte pour l'agent. */
async function requestControl(options: CallOptions): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	const control = loadControl();
	if ("error" in control) return textResult(control.error);
	try {
		const result = await callControl(control, options);
		const payload =
			result.json !== null && typeof result.json === "object" && !Array.isArray(result.json)
				? { httpStatus: result.status, ...(result.json as Record<string, unknown>) }
				: { httpStatus: result.status, response: result.json };
		return {
			content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			details: payload,
		};
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		const message =
			name === "TimeoutError"
				? `Délai de ${Math.round(options.timeoutMs / 1000)} s dépassé sur ${options.path}.`
				: error instanceof Error
					? error.message
					: String(error);
		return textResult(
			`Serveur de contrôle CUA injoignable (${message}). Pi Desktop (fork CUA) est peut-être fermé — sinon réessayez après re-démarrage.`,
		);
	}
}

export default function piCuaControl(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "show_computer",
		label: "Show Computer",
		description:
			"Open (or reuse) the Pi Desktop Computer panel — a CUA desktop the user can watch and you can drive. " +
			"backend: 'auto' lets Jev pick; otherwise pass 'docker-vm', 'docker-host', 'proxmox-vm' or 'main-os'. " +
			"Returns { success, sessionId, viewerUrl, backend } or { success: false, error }.",
		parameters: z.object({
			backend: z.enum([...BACKENDS]).optional().describe("Target backend; defaults to 'auto' (Jev judgment)."),
		}),
		async execute(_id, params) {
			return requestControl({
				method: "POST",
				path: "/computer/open",
				body: { backend: params.backend ?? "auto" },
				timeoutMs: 60_000,
			});
		},
	});

	pi.registerTool({
		name: "hide_computer",
		label: "Hide Computer",
		description:
			"Close the current Computer session (stops the guest and its tunnel) and hide the panel. " +
			"Returns { success } or { success: false, error }.",
		parameters: z.object({}),
		async execute() {
			return requestControl({ method: "POST", path: "/computer/close", timeoutMs: 60_000 });
		},
	});

	pi.registerTool({
		name: "computer_status",
		label: "Computer Status",
		description: "Report whether a Computer session is open: { open, sessionId, backend }.",
		parameters: z.object({}),
		async execute() {
			return requestControl({ method: "GET", path: "/computer/status", timeoutMs: 10_000 });
		},
	});

	pi.registerTool({
		name: "computer_exec",
		label: "Computer Exec",
		description:
			"Run a shell command inside the CURRENT Computer session's space (cua sb exec … sh -lc), 30 s server-side timeout. " +
			"Returns stdout/stderr/exitCode. Requires an open session — call show_computer first.",
		parameters: z.object({
			command: z.string().min(1).describe("POSIX shell command line to run in the space."),
		}),
		async execute(_id, params) {
			return requestControl({
				method: "POST",
				path: "/computer/exec",
				body: { command: params.command },
				timeoutMs: 40_000,
			});
		},
	});
}
