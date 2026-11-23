/**
 * Webcam snapshot capture — let the coding agent see through the camera.
 *
 * Fork of @tkoyama010/pi-webcam 0.1.0 (MIT, github.com/tkoyama010/pi-webcam)
 * with the Linux device listing fixed.
 *
 * Upstream bug: `/camera list` ran `ffmpeg -f v4l2 -list_devices true -i ""`.
 * `-list_devices` only exists for avfoundation (macOS) and dshow (Windows) —
 * ffmpeg rejects it for v4l2 with "Unrecognized option", so on Linux the list
 * always came back empty ("No camera devices found. Is ffmpeg installed?").
 *
 * Linux fix: enumerate /dev/video* via readdirSync, then keep only nodes that
 * actually carry a video stream (ffprobe probe) — UVC cams expose a metadata
 * node (e.g. /dev/video1) next to the capture node, and capturing from the
 * metadata node fails. If probing fails (camera busy, no ffprobe), fall back
 * to the raw device list so /camera list still shows something useful.
 *
 * Commands:
 *   /camera list            — list available camera devices
 *   /camera take [device]   — capture a snapshot (default: first capture node)
 *
 * The snapshot lands in $TMPDIR as pi-webcam-<timestamp>.jpg; the notification
 * carries the path so the model can read it (multimodal read) and see the frame.
 *
 * Requires ffmpeg/ffprobe in PATH.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface CaptureResult {
	success: boolean;
	path: string;
	error?: string;
}

interface PlatformConfig {
	videoInput: string;
	listArgs: string[];
	listParse: (output: string) => string[];
	format: string;
}

function getPlatformConfig(): PlatformConfig {
	const platform = process.platform;

	if (platform === "darwin") {
		return {
			videoInput: "avfoundation",
			listArgs: ["-f", "avfoundation", "-list_devices", "true", "-i", ""],
			listParse: (output: string) =>
				output
					.split("\n")
					.filter((line) => /^\s*\[AVFoundation/.test(line))
					.map((line) => {
						const match = line.match(/\[(AVFoundation|AVF)\]\s*\[.+\]\s*(.+)/);
						return match ? match[2].trim() : "";
					})
					.filter(Boolean),
			format: "default",
		};
	}

	if (platform === "linux") {
		return {
			videoInput: "v4l2",
			// NOTE: -list_devices is NOT a v4l2 option in ffmpeg — it exists only
			// for avfoundation/dshow. Linux listing goes through listLinuxDevices().
			listArgs: [],
			listParse: (output: string) =>
				output
					.split("\n")
					.filter((line) => /\/dev\/video/.test(line))
					.map((line) => {
						const match = line.match(/\[.+\]\s*\[.+\]\s*(.+)/);
						return match ? match[1].trim() : "";
					})
					.filter(Boolean),
			format: "/dev/video0",
		};
	}

	// Windows
	return {
		videoInput: "dshow",
		listArgs: ["-f", "dshow", "-list_devices", "true", "-i", ""],
		listParse: (output: string) =>
			output
				.split("\n")
				.filter((line) => /\[dshow/.test(line) && /video/.test(line))
				.map((line) => {
					const match = line.match(/"([^"]+)"\s*\(video\)/);
					return match ? match[1] : "";
				})
				.filter(Boolean),
		format: "video=Integrated Camera",
	};
}

/**
 * Linux: /dev/videoN enumeration + ffprobe capture-node filter.
 *
 * Returns [] only when /dev has no video nodes at all (or /dev is unreadable).
 * On probe failure returns the raw node list — better to show a device that
 * may fail on `take` than to hide cameras that are merely busy.
 */
function listLinuxDevices(): string[] {
	let nodes: string[] = [];
	try {
		nodes = readdirSync("/dev")
			.filter((f) => /^video\d+$/.test(f))
			.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
			.map((f) => `/dev/${f}`);
	} catch {
		return [];
	}
	if (nodes.length === 0) return [];

	const captureNodes = nodes.filter((n) => {
		try {
			const out = execSync(
				`ffprobe -v error -f v4l2 -select_streams v:0 -show_entries stream=codec_type -of csv=p=0 ${n}`,
				{ encoding: "utf8", stdio: "pipe", timeout: 5000 },
			);
			return out.includes("video");
		} catch {
			return false;
		}
	});
	return captureNodes.length > 0 ? captureNodes : nodes;
}

function listDevices(): string[] {
	if (process.platform === "linux") return listLinuxDevices();
	const cfg = getPlatformConfig();
	try {
		const output = execSync(`ffmpeg ${cfg.listArgs.join(" ")} 2>&1`, {
			encoding: "utf8",
		});
		return cfg.listParse(output);
	} catch {
		return [];
	}
}

function capture(device?: string): CaptureResult {
	const cfg = getPlatformConfig();
	const outputPath = join(tmpdir(), `pi-webcam-${Date.now()}.jpg`);

	// clean up previous snapshots so $TMPDIR doesn't accumulate them
	try {
		const existing = execSync(
			`ls -t ${join(tmpdir(), "pi-webcam-*.jpg")} 2>/dev/null || true`,
			{ encoding: "utf8", stdio: "pipe" },
		);
		for (const file of existing.split("\n")) {
			const trimmed = file.trim();
			if (trimmed && existsSync(trimmed)) unlinkSync(trimmed);
		}
	} catch {
		// cleanup is best-effort
	}

	const args = [
		"-f",
		cfg.videoInput,
		"-video_size",
		"1280x720",
		"-i",
		device || cfg.format,
		"-update",
		"1",
		"-frames:v",
		"1",
		"-y",
		outputPath,
	];

	try {
		execSync(`ffmpeg ${args.join(" ")}`, { encoding: "utf8", stdio: "pipe" });
		if (existsSync(outputPath)) {
			return { success: true, path: outputPath };
		}
		return { success: false, path: "", error: "Capture succeeded but no file was created" };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		// ffmpeg exits non-zero on list_devices, but capture should succeed
		if (existsSync(outputPath)) {
			return { success: true, path: outputPath };
		}
		return { success: false, path: "", error: message };
	}
}

/** Read a snapshot off disk as a pi image content block (base64 jpeg). */
function imageBlock(path: string): { type: "image"; data: string; mimeType: "image/jpeg" } | null {
	try {
		return { type: "image", data: readFileSync(path).toString("base64"), mimeType: "image/jpeg" };
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	// Tool: the AGENT can shoot on demand — result carries the frame inline.
	pi.registerTool({
		name: "webcam_snapshot",
		label: "Webcam Snapshot",
		description:
			"Capture a snapshot from the webcam. Returns the JPEG image inline plus its file path. Use when the user asks what the camera sees or to visually check the room/desk/screen.",
		promptSnippet: "Capture a webcam snapshot and return the frame as an image",
		promptGuidelines: [
			"Use webcam_snapshot when the user asks what the camera sees, to check the room, or to look at something physically in front of the desk.",
		],
		parameters: Type.Object({
			device: Type.Optional(
				Type.String({ description: "V4L2 device path, e.g. /dev/video0. Default: first capture node." }),
			),
		}),
		async execute(_toolCallId, params) {
			const result = capture(params.device);
			if (!result.success) {
				return { content: [{ type: "text", text: `Capture failed: ${result.error}` }], isError: true };
			}
			const content: Array<
				| { type: "text"; text: string }
				| { type: "image"; data: string; mimeType: "image/jpeg" }
			> = [{ type: "text", text: `Webcam snapshot: ${result.path}` }];
			const img = imageBlock(result.path);
			if (img) content.push(img);
			return { content, details: { path: result.path } };
		},
	});

	// Command: /camera take — deliver the frame into the conversation so the
	// agent actually receives it (upstream only toasted the path in the UI).
	pi.registerCommand("camera", {
		description: "Capture webcam snapshots — /camera take [device] | /camera list",
		getArgumentCompletions(prefix: string) {
			const subs = ["take", "list"];
			const matches = subs.filter((s) => s.startsWith(prefix));
			return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const action = parts[0]?.toLowerCase();

			if (!action || action === "help") {
				ctx.ui.notify("Usage: /camera take [device] | /camera list", "info");
				return;
			}

			if (action === "list") {
				const devices = listDevices();
				if (devices.length === 0) {
					ctx.ui.notify(
						"No camera devices found (no /dev/video* nodes and ffmpeg listing empty)",
						"warning",
					);
					return;
				}
				ctx.ui.notify(
					`Camera devices:\n${devices.map((d, i) => `  [${i}] ${d}`).join("\n")}`,
					"info",
				);
				return;
			}

			if (action === "take") {
				const device = parts.slice(1).join(" ") || "";
				const result = capture(device);
				if (!result.success) {
					ctx.ui.notify(`Capture failed: ${result.error}`, "error");
					return;
				}
				const content: Array<
					| { type: "text"; text: string }
					| { type: "image"; data: string; mimeType: "image/jpeg" }
				> = [{ type: "text", text: `/camera take — webcam snapshot saved to ${result.path}` }];
				const img = imageBlock(result.path);
				if (img) content.push(img);
				try {
					// Idle: sends immediately and starts a turn — the agent gets the frame.
					pi.sendUserMessage(content);
				} catch {
					// Streaming: needs an explicit mode, else rejected.
					try {
						pi.sendUserMessage(content, { deliverAs: "followUp" });
					} catch {
						ctx.ui.notify(`Snapshot saved: ${result.path}`, "info");
					}
				}
				return;
			}

			ctx.ui.notify(`Unknown action: ${action}. Use 'take' or 'list'.`, "warning");
		},
	});
}
