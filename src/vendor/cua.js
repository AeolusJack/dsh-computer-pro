// Derived from DeepSeek Harness 2e39e70496aa02986ca6a820c5d497e816b69d7e (MIT).
import {createRequire as resolveZod} from 'node:module';
import {pathToFileURL as zodURL} from 'node:url';
import {hasFullAccess} from '../policy.js';
import { extname, join } from "node:path";
import { Buffer as Buffer$1 } from "node:buffer";
import { tmpdir } from "node:os";
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";
import Schema from "@deepseek-ai/schemastery";
import { admitEncodedImages, longEdgeDimensions } from "@deepseek-ai/dsh-attachment";
const {z}=await import(zodURL(resolveZod(import.meta.resolve('@deepseek-ai/dsh-cua')).resolve('zod')).href);
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { HarnessError } from "@deepseek-ai/dsh-error";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import { realpath } from "node:fs/promises";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { resolvePersistentExecution } from "@deepseek-ai/dsh-ptc-runtime-node/configuration";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import NodePtcRuntime from "@deepseek-ai/dsh-ptc-runtime-node";
import { RunCodeConfig, createRunCodeTool } from "@deepseek-ai/dsh-tool-executor-ptc/run-code";
import { createScope } from "@deepseek-ai/dsh-scope";
import { ToolArgsError, ToolContextUnavailableError } from "@deepseek-ai/dsh-tools";
import { brandString } from "@deepseek-ai/dsh-brand";
//#region lib/types/native-client.js
/** Agent-scoped JSONL requests over a connection to the shared native helper. */
const Reply = z.union([z.object({
	id: z.string(),
	result: z.json()
}).strict(), z.object({
	id: z.string(),
	error: z.object({
		code: z.string().min(1),
		message: z.string()
	}).strict()
}).strict()]);
const screenshotPrefix = "[cua-screenshot] ";
const ScreenshotDiagnostic = z.object({
	requestId: z.string(),
	stage: z.string(),
	elapsedMs: z.number().nonnegative(),
	errorCode: z.string().optional()
});
const WireReply = z.union([Reply, ScreenshotDiagnostic.extend({ type: z.literal("diagnostic") })]);
/**
* Native refusal, transport failure, or host-side CUA refusal with a stable machine-readable code.
* The helper supplies its own codes, such as `APP_ACCESS_DENIED` or `STALE_SNAPSHOT`, so consumers
* tolerate unknown codes; the host adds `NATIVE_*` transport codes, application-access codes,
* and `MODEL_DOES_NOT_SUPPORT_IMAGES` for a screenshot requested by a model without image input.
*/
var NativeError = class extends HarnessError {
	/**
	* @param code - Native error code or a host-owned code.
	* @param message - Actionable diagnostic, without its code prefix.
	* @param options - Original failure when available.
	*/
	constructor(code, message, options) {
		super(`${code}: ${message}`, code, options);
		this.name = "NativeError";
	}
};
function connectionFailure(code, message, cause) {
	return cause instanceof NativeError ? cause : new NativeError(code, message, { cause });
}
/** Preserve the original failure together with any distinct cleanup failure. */
function combineFailures(original, cleanup) {
	if (original === cleanup) return original;
	if (original instanceof AggregateError && original.errors.includes(cleanup)) return original;
	if (cleanup instanceof AggregateError && cleanup.errors.includes(original)) return cleanup;
	return new AggregateError([original, cleanup], `Native operation and cleanup failed.\nOperation: ${String(original)}\nCleanup: ${String(cleanup)}`, { cause: original });
}
/** One Agent owns this connection and its native handles; other Agents use independent connections. */
var NativeClient = class {
	reportDiagnostic;
	handle;
	config;
	chunks = [];
	bufferedBytes = 0;
	failure;
	disposal;
	transportClosed;
	cleanups = /* @__PURE__ */ new Set();
	diagnostics = [];
	diagnosticBytes = 0;
	discardedDiagnostics = false;
	active;
	/**
	* @param owner - Managed subprocess provider.
	* @param config - Executable, transport bounds and deadlines.
	* @param createChannel - Platform-owned connection and process lifecycle.
	* @param reportDiagnostic - Optional Host diagnostic sink; never receives captured content.
	*/
	constructor(owner, config, createChannel, reportDiagnostic) {
		this.reportDiagnostic = reportDiagnostic;
		this.config = config;
		this.handle = createChannel(owner, config);
		this.handle.stdout.on("data", (chunk) => {
			this.receive(chunk);
		});
		this.handle.stdout.on("error", (error) => {
			this.fail(connectionFailure("NATIVE_IO", `Native connection failed: ${error.message}`, error));
		});
		this.handle.stdout.on("end", () => {
			this.fail(new NativeError("NATIVE_EOF", "Native connection ended; acquire fresh application handles"));
		});
		this.handle.stdout.on("close", () => {
			this.fail(new NativeError("NATIVE_EOF", "Native connection closed; acquire fresh application handles"));
		});
		this.handle.stdin.on("error", (error) => {
			this.fail(connectionFailure("NATIVE_IO", "Writing native requests failed", error));
		});
		this.handle.done.then(() => {
			this.fail(new NativeError("NATIVE_EXITED", "Native connection closed; acquire fresh application handles"));
		}, (error) => {
			this.fail(connectionFailure("NATIVE_EXITED", "Native connection failed", error));
		});
	}
	/**
	* Send one operation after any active native cleanup acknowledges completion.
	* Native refusals preserve this connection; transport failures invalidate its handles.
	* @param method - Helper operation name.
	* @param params - JSON operation parameters.
	* @param signal - Cancellation stops this request; the connection survives when native cleanup acknowledges it.
	* @param callId - Logged tool invocation ID, when this request belongs to a tool execution.
	* @returns The validated helper result, after failure cleanup when needed.
	*/
	async request(method, params, signal, callId) {
		while (!signal.aborted && this.active?.kind === "cleanup") await this.active.outcome;
		if (signal.aborted) throw new NativeError("NATIVE_CANCELLED", "Operation was cancelled before dispatch");
		if (this.disposed) {
			await this.dispose();
			throw new NativeError("NATIVE_CLOSED", "Helper is closed; acquire fresh application handles", { cause: this.failure });
		}
		return this.send("request", method, params, signal, callId);
	}
	async send(kind, method, params, signal, callId) {
		this.throwIfFailed();
		if (this.active) throw new NativeError("NATIVE_BUSY", "Await native operations sequentially");
		const id = callId ?? randomUUID();
		const capture = method === "screenshot";
		this.diagnostics = [];
		this.diagnosticBytes = 0;
		this.discardedDiagnostics = false;
		const started = performance.now();
		let interruption;
		let cancellationTimer;
		const frame = `${JSON.stringify({
			id,
			method,
			params
		})}\n`;
		if (Buffer.byteLength(frame) > this.config.maxRequestBytes) {
			const error = new NativeError("NATIVE_REQUEST_LIMIT", "Request exceeded the configured byte limit before dispatch");
			if (kind === "cleanup") this.fail(error);
			throw error;
		}
		const outcome = Promise.withResolvers();
		const interrupt = (error) => {
			if (interruption || this.active?.id !== id) return;
			if (kind === "cleanup") {
				this.fail(error);
				return;
			}
			interruption = error;
			cancellationTimer = setTimeout(() => {
				this.fail(new NativeError("NATIVE_CLEANUP", "Native operation did not acknowledge cancellation; acquire fresh application handles", { cause: error }));
			}, this.config.graceMs);
			try {
				this.handle.stdin.write(`${JSON.stringify({
					type: "cancel",
					id
				})}\n`, (failure) => {
					if (failure) this.fail(connectionFailure("NATIVE_IO", "Sending native cancellation failed", failure));
				});
			} catch (failure) {
				this.fail(connectionFailure("NATIVE_IO", "Sending native cancellation failed", failure));
			}
		};
		const abort = () => {
			interrupt(new NativeError("NATIVE_CANCELLED", "Operation cancelled; inspect fresh state before retrying input"));
		};
		this.active = {
			kind,
			id,
			outcome: outcome.promise,
			resolve: outcome.resolve,
			reject: outcome.reject,
			...kind === "request" ? { cancel: abort } : {}
		};
		signal.addEventListener("abort", abort, { once: true });
		const timeoutMs = capture ? Math.min(this.config.timeoutMs, this.config.screenshotTimeoutMs) : this.config.timeoutMs;
		const timer = setTimeout(() => {
			interrupt(new NativeError("NATIVE_TIMEOUT", `Operation exceeded ${timeoutMs}ms`));
		}, timeoutMs);
		let diagnostics = "";
		try {
			try {
				try {
					this.handle.stdin.write(frame, (error) => {
						if (error) this.fail(connectionFailure("NATIVE_IO", "Writing a helper request failed", error));
					});
					if (capture) this.diagnostic(screenshotPrefix + JSON.stringify({
						requestId: id,
						stage: "host.dispatch",
						elapsedMs: 0
					}));
				} catch (error) {
					this.fail(connectionFailure("NATIVE_IO", "Writing a helper request failed", error));
				}
				const result = await outcome.promise;
				this.throwIfFailed();
				if (interruption) throw interruption;
				if (capture) this.diagnostic(screenshotPrefix + JSON.stringify({
					requestId: id,
					stage: "host.reply",
					elapsedMs: performance.now() - started
				}));
				return result;
			} finally {
				clearTimeout(timer);
				clearTimeout(cancellationTimer);
				signal.removeEventListener("abort", abort);
				if (capture) diagnostics = this.screenshotDiagnostics();
			}
		} catch (error) {
			const failure = interruption && !this.failure ? interruption : error;
			if (capture && diagnostics) failure.message += `\nScreenshot diagnostics:\n${diagnostics}`;
			if (kind === "cleanup") {
				this.fail(connectionFailure("NATIVE_CLEANUP", "Native resource cleanup failed; acquire fresh application handles", failure));
				return await this.rejectAfterCleanup(failure, this.waitForTransportClose());
			}
			if (this.disposed) return await this.rejectAfterCleanup(failure, this.dispose());
			throw failure;
		} finally {
			if (capture) {
				if (diagnostics) this.diagnostic(diagnostics);
				this.diagnostic(screenshotPrefix + JSON.stringify({
					requestId: id,
					stage: "host.settled",
					elapsedMs: performance.now() - started
				}));
			}
		}
	}
	/**
	* Dispatch cleanup after any active request acknowledges completion or cancellation.
	* Available during graceful disposal. A refusal or timeout invalidates the connection; cleanup
	* awaits its closure before rejecting. Distinct operation and close failures are aggregated.
	* @param method - Host-only helper cleanup operation.
	* @param params - Resources owned by the enclosing execution.
	* @returns The native cleanup acknowledgement, bounded by the connection's request deadline.
	*/
	async requestCleanup(method, params) {
		try {
			while (this.active) await this.active.outcome.catch(() => void 0);
			return await this.send("cleanup", method, params, new AbortController().signal);
		} catch (error) {
			this.fail(connectionFailure("NATIVE_CLEANUP", "Native resource cleanup failed; acquire fresh application handles", error));
			return this.rejectAfterCleanup(error, this.waitForTransportClose());
		}
	}
	/** Await owned cleanup while retaining the operation's original failure. */
	async rejectAfterCleanup(original, cleanup) {
		try {
			await cleanup;
		} catch (error) {
			throw combineFailures(original, error);
		}
		throw original;
	}
	/**
	* Register resource cleanup before graceful connection closure.
	* @param cleanup Stops resource admission and releases native state through requestCleanup.
	* canRequest is false after forced closure; then perform local cleanup only. A true value
	* does not guarantee that the transport survives the callback. Never call request or dispose here.
	* @returns Removal after the resource's normal cleanup settles; an admitted callback remains awaited.
	* @throws NativeError when the connection has failed or disposal has begun.
	*/
	registerCleanup(cleanup) {
		if (this.disposed) throw new NativeError("NATIVE_CLOSED", "Cannot register cleanup on a closing helper", { cause: this.failure });
		this.cleanups.add(cleanup);
		return () => {
			this.cleanups.delete(cleanup);
		};
	}
	screenshotDiagnostics() {
		const records = [...this.diagnostics];
		if (this.discardedDiagnostics) records.unshift("[Earlier screenshot diagnostic records were discarded from the bounded diagnostic buffer.]");
		return records.join("\n");
	}
	retainDiagnostic(value) {
		if (value.requestId !== this.active?.id) return;
		const line = screenshotPrefix + JSON.stringify(ScreenshotDiagnostic.parse(value));
		this.diagnostics.push(line);
		this.diagnosticBytes += Buffer.byteLength(line);
		while (this.diagnosticBytes > 8192) {
			const discarded = this.diagnostics.shift();
			assert(discarded !== void 0, "Diagnostic bytes must belong to retained records");
			this.diagnosticBytes -= Buffer.byteLength(discarded);
			this.discardedDiagnostics = true;
		}
	}
	diagnostic(message) {
		try {
			this.reportDiagnostic?.(message);
		} catch (error) {}
	}
	/** Whether this connection rejects new operations because it failed or is closing. */
	get disposed() {
		return this.failure !== void 0 || this.disposal !== void 0;
	}
	/** Invalidate this Agent's handles and close its connection; await dispose for native cleanup. */
	invalidate() {
		this.fail(new NativeError("NATIVE_DISPOSED", "Helper disposed"));
	}
	/** Stop new operations, settle registered resources, and await connection closure even when cleanup fails. */
	dispose() {
		return this.disposal ??= Promise.resolve().then(async () => {
			this.active?.cancel?.();
			const results = await Promise.allSettled([...this.cleanups].map((cleanup) => Promise.resolve().then(() => cleanup(this.failure === void 0))));
			this.cleanups.clear();
			const errors = /* @__PURE__ */ new Set();
			for (const result of results) if (result.status === "rejected") errors.add(result.reason);
			try {
				this.invalidate();
				await this.waitForTransportClose();
			} catch (error) {
				errors.add(error);
			}
			if (errors.size > 0) throw [...errors].reduce(combineFailures);
		});
	}
	/** Join transport closure without invoking resource callbacks or waiting on their disposal. */
	waitForTransportClose() {
		return this.transportClosed ??= Promise.resolve().then(() => this.handle.waitForClose()).finally(() => {
			this.handle.stdout.destroy();
			this.handle.stdin.destroy();
		});
	}
	/** Reject execution after an asynchronous transport callback invalidates the connection. */
	throwIfFailed() {
		if (this.failure !== void 0) throw this.failure;
	}
	fail(error) {
		if (this.failure) return;
		this.failure = error;
		this.chunks.length = 0;
		this.bufferedBytes = 0;
		this.active?.reject(error);
		this.active = void 0;
		this.handle.close();
	}
	receive(chunk) {
		let offset = 0;
		while (offset < chunk.length && !this.failure) {
			const newline = chunk.indexOf(10, offset);
			const end = newline < 0 ? chunk.length : newline + 1;
			const piece = chunk.subarray(offset, end);
			if (this.bufferedBytes + piece.length > this.config.maxResponseBytes) {
				this.fail(new NativeError("NATIVE_RESPONSE_LIMIT", "Helper response exceeded the configured byte limit"));
				return;
			}
			this.chunks.push(piece);
			this.bufferedBytes += piece.length;
			if (newline >= 0) this.receiveFrame();
			offset = end;
		}
	}
	receiveFrame() {
		try {
			const frame = Buffer.concat(this.chunks, this.bufferedBytes);
			const line = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, frame.length - 1));
			const reply = WireReply.parse(JSON.parse(line));
			this.chunks.length = 0;
			this.bufferedBytes = 0;
			if ("type" in reply) {
				this.retainDiagnostic(reply);
				return;
			}
			const active = this.active;
			if (!active || reply.id !== active.id) throw new Error("Helper reply has no matching request");
			this.active = void 0;
			if ("error" in reply) {
				const error = new NativeError(reply.error.code, reply.error.message);
				if (active.kind === "cleanup" || reply.error.code === "NATIVE_RESPONSE_LIMIT") this.fail(error);
				active.reject(error);
			} else active.resolve(reply.result);
		} catch (error) {
			this.fail(new NativeError("NATIVE_PROTOCOL", "Helper returned an invalid response; acquire fresh application handles", { cause: error }));
		}
	}
};
//#endregion
//#region lib/types/locales.js
/** Locale-owned application-access approval messages. */
/** English application-access messages. */
const en = {
	question: "Allow agent to control this application via computer use?",
	detail: "Manage app permissions for all sessions on the plugin page.",
	approve: "Allow for this session"
};
/** Chinese application-access messages. */
const zh = {
	question: "允许智能体通过 Computer Use 控制此应用吗？",
	detail: "在插件页面管理所有会话的应用权限。",
	approve: "本会话允许"
};
/** Japanese application-access messages. */
const ja = {
	question: "エージェントが Computer Use でこのアプリを操作することを許可しますか？",
	detail: "プラグインページで、すべてのセッションのアプリ権限を管理できます。",
	approve: "このセッションで許可"
};
/** Spanish dictionary, checked against the English keys. */
const es = {
	question: "¿Permitir que el agente controle esta aplicación mediante Computer Use?",
	detail: "Gestiona los permisos de las aplicaciones para todas las sesiones en la página del plugin.",
	approve: "Permitir durante esta sesión"
};
/** French dictionary, checked against the English keys. */
const fr = {
	question: "Autoriser l’agent à contrôler cette application via Computer Use ?",
	detail: "Gérez les autorisations des applications pour toutes les sessions sur la page du plugin.",
	approve: "Autoriser pour cette session"
};
/** German dictionary, checked against the English keys. */
const de = {
	question: "Darf der Agent diese Anwendung über Computer Use steuern?",
	detail: "Verwalten Sie App-Berechtigungen für alle Sitzungen auf der Plugin-Seite.",
	approve: "Für diese Sitzung zulassen"
};
/** Russian dictionary, checked against the English keys. */
const ru = {
	question: "Разрешить агенту управлять этим приложением через Computer Use?",
	detail: "Управляйте разрешениями приложений для всех сеансов на странице плагина.",
	approve: "Разрешить для этого сеанса"
};
/** Portuguese dictionary, checked against the English keys. */
const pt = {
	question: "Permitir que o agente controle este aplicativo via Computer Use?",
	detail: "Gerencie as permissões dos aplicativos para todas as sessões na página do plugin.",
	approve: "Permitir nesta sessão"
};
/** Display translations resolved by the Client; wire choices stay unchanged. */
const applicationAccessDisplay = {
	question: {
		en: en.question,
		zh: zh.question,
		ja: ja.question,
		es: es.question,
		fr: fr.question,
		de: de.question,
		ru: ru.question,
		pt: pt.question
	},
	detail: {
		en: en.detail,
		zh: zh.detail,
		ja: ja.detail,
		es: es.detail,
		fr: fr.detail,
		de: de.detail,
		ru: ru.detail,
		pt: pt.detail
	},
	approve: {
		en: en.approve,
		zh: zh.approve,
		ja: ja.approve,
		es: es.approve,
		fr: fr.approve,
		de: de.approve,
		ru: ru.approve,
		pt: pt.approve
	}
};
//#endregion
//#region lib/types/mouse-control-locales.js
/** Scope and interruption shown before the user grants mouse control. */
const mouseControlPrompt = {
	question: {
		en: "Allow the agent to control your mouse?",
		zh: "允许智能体控制你的鼠标吗？",
		ja: "エージェントにマウス操作を許可しますか？",
		es: "¿Permitir que el agente controle tu ratón?",
		fr: "Autoriser l’agent à contrôler votre souris ?",
		de: "Darf der Agent Ihre Maus steuern?",
		ru: "Разрешить агенту управлять вашей мышью?",
		pt: "Permitir que o agente controle seu mouse?"
	},
	detail: {
		en: "The agent can move your pointer and hold or release a mouse button. Moving your mouse while a button is held can drag items. Your choice lasts until you close this session or restart DSH.",
		zh: "智能体可以移动指针、按住或松开鼠标键。按住期间，你移动鼠标也可能拖动项目。此选择在关闭会话或重启 DSH 前有效。",
		ja: "エージェントはポインタを移動し、マウスボタンを押したままにしたり離したりできます。その間にマウスを動かすと項目がドラッグされることがあります。この選択はセッションを閉じるか DSH を再起動するまで有効です。",
		es: "El agente puede mover el puntero y mantener pulsado o soltar un botón. Si mueves el ratón mientras un botón está pulsado, puedes arrastrar elementos. Tu elección se mantiene hasta que cierres la sesión o reinicies DSH.",
		fr: "L’agent peut déplacer le pointeur et maintenir ou relâcher un bouton. Si vous déplacez la souris pendant qu’un bouton est enfoncé, vous pouvez faire glisser des éléments. Votre choix reste valable jusqu’à la fermeture de la session ou au redémarrage de DSH.",
		de: "Der Agent kann den Mauszeiger bewegen und eine Maustaste gedrückt halten oder loslassen. Wenn Sie die Maus bei gedrückter Taste bewegen, können Sie Elemente ziehen. Ihre Entscheidung gilt, bis Sie diese Sitzung schließen oder DSH neu starten.",
		ru: "Агент может перемещать указатель, удерживать и отпускать кнопку мыши. Если вы двигаете мышь, пока кнопка нажата, объекты могут перемещаться. Выбор сохраняется до закрытия сеанса или перезапуска DSH.",
		pt: "O agente pode mover o ponteiro e manter um botão do mouse pressionado ou soltá-lo. Se você mover o mouse enquanto um botão estiver pressionado, poderá arrastar itens. Sua escolha vale até encerrar a sessão ou reiniciar o DSH."
	}
};
//#endregion
//#region lib/types/mouse-control.js
/** Access is scoped to the live Session and never grants application access. */
var MouseControl = class {
	ctx;
	requireApproval;
	decisions = /* @__PURE__ */ new WeakMap();
	pressed = /* @__PURE__ */ new WeakMap();
	constructor(ctx, requireApproval) {
		this.ctx = ctx;
		this.requireApproval = requireApproval;
		ctx.on("session/event", (session, event) => {
			if (event.type !== "turn/end") return;
			const client = this.pressed.get(session);
			this.pressed.delete(session);
			if (client && !client.disposed) client.requestCleanup("releaseSystemButton", {}).catch((error) => {
				ctx.logger.warn("Could not release system mouse input at turn end: %s", error);
			});
		});
	}
	/**
	* Arm turn-end cleanup before posting; cancellation can hide an already dispatched press.
	* @param agent Owner of the current turn.
	* @param client Connection that owns and can release the native button.
	*/
	trackPress(agent, client) {
		this.pressed.set(agent.session, client);
	}
	/**
	* Select the per-call route and any approval required before dispatch.
	* @param agent Agent owning the live Session.
	* @param requested Whether the caller explicitly requested system mouse input.
	* @returns Native pointer mode and an optional preparation that must succeed before input.
	*/
	resolve(agent, requested) {
		if (!requested) return { useSystemPointer: false };
		if (agent.session.header.origin === "subagent") throw new NativeError("MOUSE_CONTROL_UNAVAILABLE", "Delegated tasks cannot control the system mouse. Use a window-directed action or report the required system-pointer gesture to the main task.");
		if (!this.requireApproval || this.decisions.get(agent) === true) return { useSystemPointer: true };
		return {
			useSystemPointer: true,
			prepare: (signal) => this.approve(agent, signal)
		};
	}
	async approve(agent, signal) {
		signal.throwIfAborted();
		const decision = this.decisions.get(agent);
		if (decision === "asking") throw new NativeError("MOUSE_CONTROL_PENDING", "Wait for the outstanding mouse control request");
		let granted = decision;
		if (granted === void 0) {
			const questions = this.ctx.get("userQuestions");
			if (!questions) throw new NativeError("MOUSE_APPROVAL_UNAVAILABLE", "No human answerer is available for mouse control");
			const id = "cua-mouse-control";
			const display = {
				...mouseControlPrompt,
				approve: applicationAccessDisplay.approve
			};
			const approve = display.approve.en;
			const reject = "Deny";
			this.decisions.set(agent, "asking");
			try {
				const result = await questions.ask({
					agent,
					signal,
					questions: [{
						id,
						question: display.question.en,
						detail: display.detail.en,
						options: [{ label: approve }, { label: reject }],
						intent: {
							kind: "approval",
							approve,
							reject,
							display
						}
					}]
				});
				signal.throwIfAborted();
				const [answer] = result.answers;
				granted = result.answers.length === 1 && answer?.id === id && !answer.custom?.trim() && answer.selected.length === 1 && answer.selected[0] === approve;
				this.decisions.set(agent, granted);
			} catch (error) {
				this.decisions.delete(agent);
				if (error instanceof UserQuestionError && error.code === "ASK_CANCELLED") throw new NativeError("MOUSE_APPROVAL_CANCELLED", "The mouse control request was dismissed. Continue without mouse control unless the user asks to reconsider", { cause: error });
				throw error;
			}
		}
		if (!granted) throw new NativeError("MOUSE_CONTROL_DENIED", "The user declined system mouse control for this session. No input was sent. Use pointer-free actions.");
	}
};
//#endregion
//#region lib/types/guidance.js
/** Shared model instructions for native application and window operations. */
const hoverSignature = "mouseMove(target: string | [number, number], options?: { relative?: boolean })";
/** System-prompt section that carries the CUA operation guidance for one Agent. */
const CUA_PROMPT_SECTION_NAME = "computer-use:dsh-cua";
/**
* Describe the system-pointer option for a provider that declares the capability.
* @param guidance Provider instructions including the shared operation catalog.
* @returns The capability-specific signature and permission instructions.
*/
function withSystemPointerGuidance(guidance) {
	return `${guidance.replace(hoverSignature, "mouseMove(target: string | [number, number], options?: { relative?: boolean, useSystemPointer?: boolean })")}

Only if the task cannot be completed without moving the user’s pointer, call await win.mouseMove(target, { useSystemPointer: true }). Prefer an advertised accessibility action, a click on a visible control, or browser tools when possible. The question interrupts the user. When approval is disabled an explicit move can act immediately. Pass true on every physical move, even after approval. Omitting the option or passing false uses the default hover route without prompting. Approval or refusal lasts until this session closes or DSH restarts. A refusal sends no input. If the user dismisses the request, ask again only if they request it. Wait for an outstanding request to finish. Subagents cannot request system mouse control.`;
}
//#endregion
//#region lib/types/permission-store.js
/** Profile-scoped application consent over the existing domain storage service. */
const identity = z.object({
	id: z.string().regex(/^[a-f0-9]{64}$/).transform((value) => value),
	name: z.string(),
	executablePath: z.string().min(1).optional()
});
const sessionDecision = z.object({
	identity,
	decision: z.enum([
		"allow",
		"deny",
		"ask"
	]),
	revision: z.number().int().nonnegative()
});
const application = z.object({
	revoked: z.number().int().nonnegative(),
	always: identity.optional(),
	sessions: z.record(z.string(), sessionDecision)
});
const state = z.object({
	migrated: z.boolean(),
	applications: z.record(z.string().regex(/^[a-f0-9]{64}$/), application)
}).superRefine((value, context) => {
	for (const [id, app] of Object.entries(value.applications)) if (app.always !== void 0 && app.always.id !== id || Object.values(app.sessions).some((session) => session.identity.id !== id)) context.addIssue({
		code: "custom",
		message: "Application identity does not match its stored key"
	});
});
/**
* Open fresh domain state under a profile lock for every decision and native operation.
* Without a profile, only process-local session decisions are writable. A profile requires domain storage.
*/
var CuaPermissionStore = class {
	ctx;
	legacy;
	waitMs;
	directory;
	memory;
	pending = /* @__PURE__ */ new Set();
	tail = Promise.resolve();
	/**
	* @param ctx Provider context with optional profile and domain storage services.
	* @param legacy Grants imported on the first access to this profile's store.
	* @param waitMs Existing operation budget, also bounding profile-lock contention.
	*/
	constructor(ctx, legacy, waitMs) {
		this.ctx = ctx;
		this.legacy = legacy;
		this.waitMs = waitMs;
		this.directory = ctx.get("profileContext")?.dir;
		this.memory = this.importLegacy();
	}
	/** Whether this composition can retain application and session grants across restarts. */
	get persistent() {
		return this.directory !== void 0 && this.ctx.get("storageDomain") !== void 0;
	}
	/**
	* Serialize a read, write, or authorized dispatch against all other users of this profile.
	* @param signal Cancellation while waiting; admitted operations own their cancellation.
	* @param operation Work using fresh state. Native dispatch uses its separate application lease.
	* @returns The operation's result after its domain handle has closed.
	*/
	withState(signal, operation) {
		const pending = this.operate(signal, operation);
		this.pending.add(pending);
		pending.finally(() => {
			this.pending.delete(pending);
		}).catch(() => {});
		return pending;
	}
	/**
	* Coordinate native dispatch and whole-application revocation without blocking other applications.
	* @param id Validated native application identity.
	* @param signal Cancellation while waiting for admission.
	* @param operation Authorized dispatch or revocation, after checking fresh state separately.
	* @returns Result after releasing the application lease.
	*/
	withApplication(id, signal, operation) {
		const pending = (async () => {
			signal.throwIfAborted();
			if (this.directory === void 0) return operation();
			return withFileLock(join(await realpath(this.directory), `cua-application-${id}`), operation, {
				signal,
				waitMs: this.waitMs
			});
		})();
		this.pending.add(pending);
		pending.finally(() => {
			this.pending.delete(pending);
		}).catch(() => {});
		return pending;
	}
	/** Join accepted operations before withdrawing this provider. */
	async drain() {
		await Promise.allSettled(this.pending);
	}
	async operate(signal, operation) {
		if (this.directory === void 0) {
			const run = async () => {
				signal.throwIfAborted();
				return operation({
					state: this.memory,
					save: (next) => {
						this.memory = next;
						return Promise.resolve();
					}
				});
			};
			const pending = this.tail.then(run);
			this.tail = pending.then(() => {}, () => {});
			return pending;
		}
		const storage = this.ctx.get("storageDomain");
		if (storage === void 0) throw new Error("Profile application permissions require storageDomain");
		const directory = await realpath(this.directory);
		const spec = defineDomain({
			name: `cua_permissions_${createHash("sha256").update(directory).digest("hex")}`,
			version: 1,
			tables: {},
			global: {
				schema: state,
				initial: {
					migrated: false,
					applications: {}
				}
			}
		});
		return withFileLock(join(directory, "cua-permissions"), async () => {
			const domain = await storage.open(spec);
			try {
				if (!domain.global.get().migrated) await domain.global.set(this.importLegacy());
				return await operation({
					state: domain.global.get(),
					save: (next) => domain.global.set(next)
				});
			} finally {
				await domain.close();
			}
		}, {
			signal,
			waitMs: this.waitMs
		});
	}
	importLegacy() {
		return {
			migrated: true,
			applications: Object.fromEntries(this.legacy.map((grant) => [grant.id, {
				revoked: 0,
				always: grant,
				sessions: {}
			}]))
		};
	}
};
//#endregion
//#region lib/types/application-access.js
/** Native identity admission occurs before any application observation or input. */
const ApplicationAuthorizationResult = z.object({
	id: z.string().regex(/^[a-f0-9]{64}$/).transform((value) => value),
	name: z.string(),
	executablePath: z.string().min(1).optional(),
	persistable: z.boolean()
});
/** Owns application consent and cancels operations when saved access is removed. */
var ApplicationAccess = class {
	ctx;
	options;
	clients = /* @__PURE__ */ new Map();
	active = /* @__PURE__ */ new Set();
	selections = /* @__PURE__ */ new Map();
	lifetime = new AbortController();
	disposal;
	/** @param ctx Host context owning this provider. @param options Live saved grants and profile persistence. */
	constructor(ctx, options) {
		this.ctx = ctx;
		this.options = options;
		ctx.effect(() => () => this.dispose(), "cua-application-access.dispose");
	}
	/**
	* Cancel consent waits and join owned operations.
	* @returns Completion after consent waits and active operations settle.
	*/
	dispose() {
		return this.disposal ??= (async () => {
			this.lifetime.abort();
			await Promise.allSettled([this.options.store.drain(), ...[...this.active].map((operation) => operation.done.promise)]);
			this.clients.clear();
		})();
	}
	/**
	* Project application decisions without requesting native permissions.
	* @returns Current saved grants and refused applications for the permission page.
	*/
	async status() {
		return this.options.store.withState(this.lifetime.signal, ({ state }) => {
			const allowedApps = [], blockedApps = [];
			for (const app of Object.values(state.applications)) if (app.always) allowedApps.push(app.always);
			else {
				const denied = Object.values(app.sessions).find((session) => session.decision === "deny");
				if (denied) blockedApps.push(denied.identity);
			}
			return {
				allowedApps,
				blockedApps,
				persistentAvailable: this.options.store.persistent
			};
		});
	}
	/**
	* Remove saved and session consent and join affected native operations.
	* @param id Application identity shown in the permission page.
	* @returns Completion after persistence and cancellation, including other processes' admitted operations.
	*/
	async revoke(id) {
		this.lifetime.signal.throwIfAborted();
		id = ApplicationAuthorizationResult.shape.id.parse(id);
		const clients = this.invalidate(id);
		await this.options.store.withApplication(id, this.lifetime.signal, () => this.options.store.withState(this.lifetime.signal, async (transaction) => {
			const app = transaction.state.applications[id] ?? this.empty();
			if (app.always && !this.options.store.persistent) throw new Error("Application permissions cannot be saved in this composition");
			await this.save(transaction, id, {
				revoked: app.revoked + 1,
				sessions: Object.fromEntries(Object.entries(app.sessions).map(([sessionId, session]) => [sessionId, {
					...session,
					decision: "deny",
					revision: session.revision + 1
				}]))
			});
		}));
		const results = await Promise.allSettled([...clients.map((client) => client.dispose()), ...[...this.active].filter((operation) => operation.identity.id === id).map((operation) => operation.done.promise)]);
		const errors = [];
		for (const result of results) if (result.status === "rejected") errors.push(result.reason);
		if (errors.length) throw new AggregateError(errors, "Application access was revoked, but helper cleanup failed");
	}
	/** Clear refusals without granting access or restoring old handles.
	* @param id Application selected by the human.
	* @returns Completion after the new asking policy is durable.
	*/
	async retryApproval(id) {
		id = ApplicationAuthorizationResult.shape.id.parse(id);
		await this.options.store.withState(this.lifetime.signal, async (transaction) => {
			const app = transaction.state.applications[id];
			if (!app || !Object.values(app.sessions).some((session) => session.decision === "deny")) return;
			await this.save(transaction, id, {
				...app,
				sessions: Object.fromEntries(Object.entries(app.sessions).map(([sessionId, session]) => [sessionId, session.decision === "deny" ? {
					...session,
					decision: "ask",
					revision: session.revision + 1
				} : session]))
			});
		});
	}
	/**
	* Obtain consent for a freshly selected native handle. Free text never grants access.
	* @param agent Live agent whose session owns the decision.
	* @param client Helper that issued the handle.
	* @param handle Helper handle for a running instance or an approved pending launch.
	* @param identity Platform-provided application or process-instance identity.
	* @param signal Calling tool lifetime.
	* @param icon Native application icon for the permission card; never saved as an identity.
	* @returns Completion after consent; refusals reject before launch, AX, screenshots, or input.
	*/
	async select(agent, client, handle, identity, signal, icon) {
		await this.withOperation(agent, client, identity, signal, (signal) => this.selectInOrder(agent, identity.id, async () => {
			signal.throwIfAborted();
			const observed = await this.read(identity.id, signal);
			const existing = this.clients.get(client)?.handles.get(handle);
			if (!client.disposed && existing) {
				if (this.permitted(existing, observed) && (existing.scope !== "full-access" || hasFullAccess(this.ctx, agent, this.options.fullAccessControlsDesktop))) return;
				this.invalidate(identity.id, agent);
				throw new NativeError("APP_ACCESS_REVOKED", "Application access changed; acquire a fresh application handle after consent");
			}
			const saved = identity.persistable && observed.always !== void 0;
			const decision = observed.sessions[agent.id];
			let scope = saved ? "persistent" : "session";
            // Transient authorization: never persist this as a human consent decision.
            const full = !saved && decision?.decision !== 'allow' && hasFullAccess(this.ctx, agent, this.options.fullAccessControlsDesktop);
            if (full && Object.values(observed.sessions).some(s=>s.decision==='deny')) throw this.denied(identity);
            if (full) scope = 'full-access';
			if (!saved && decision?.decision === "deny") throw this.denied(identity);
			if (client.disposed) throw new NativeError("NATIVE_CLOSED", "Helper is closed; acquire fresh application handles");
			if (!full && !saved && decision?.decision !== "allow") {
				const questions = this.ctx.get("userQuestions");
				if (!questions) throw new NativeError("APP_APPROVAL_UNAVAILABLE", "No human answerer is available for application access");
				const options = [{ label: "Allow for this session" }, { label: "Deny" }];
				if (identity.persistable && this.options.store.persistent) options.push({ label: "Always allow" });
				let result;
				try {
					result = await questions.ask({
						agent,
						signal,
						questions: [{
							id: "cua-app-access",
							question: `Allow computer use to launch if needed, read, capture, and control ${identity.name}?`,
							detail: applicationAccessDisplay.detail.en,
							options,
							intent: {
								kind: "approval",
								approve: "Allow for this session",
								reject: "Deny",
								...identity.persistable && this.options.store.persistent ? { always: "Always allow" } : {},
								subject: {
									name: identity.name,
									...icon === void 0 ? {} : { icon }
								},
								display: applicationAccessDisplay
							}
						}]
					});
				} catch (error) {
					if (error instanceof UserQuestionError && error.code === "ASK_CANCELLED") {
						this.invalidate(identity.id, agent);
						if (!this.lifetime.signal.aborted) await this.decide(agent.id, identity, "deny");
						throw this.denied(identity);
					}
					if (error instanceof UserQuestionError && error.code === "DELEGATED_CALLER") throw new NativeError("APP_APPROVAL_UNAVAILABLE", "Application approval is unavailable in delegated tasks; ask the main task to perform this operation");
					throw error;
				}
				signal.throwIfAborted();
				const answer = result.answers.find((answer) => answer.id === "cua-app-access");
				const chosen = answer && !answer.custom?.trim() && answer.selected.length === 1 ? answer.selected[0] : void 0;
				if (chosen === "Allow for this session") scope = "session";
				else if (chosen === "Always allow" && identity.persistable && this.options.store.persistent) scope = "persistent";
				else {
					await this.decide(agent.id, identity, "deny");
					this.invalidate(identity.id, agent);
					throw this.denied(identity);
				}
			}
			if (client.disposed) throw new NativeError("NATIVE_CLOSED", "Helper is closed; acquire fresh application handles");
			const authorized = await this.options.store.withState(signal, async (transaction) => {
				signal.throwIfAborted();
				const app = transaction.state.applications[identity.id] ?? this.empty();
				if (app.revoked !== observed.revoked || app.sessions[agent.id]?.revision !== observed.sessions[agent.id]?.revision) throw new NativeError("APP_ACCESS_REVOKED", "Application consent changed while awaiting approval; select the application again");
				if (scope === 'full-access') {
                    if (!hasFullAccess(this.ctx, agent, this.options.fullAccessControlsDesktop)) throw new NativeError('APP_ACCESS_REVOKED','Full access was disabled before application selection');
                    return {revoked:app.revoked,revision:app.sessions[agent.id]?.revision};
                }
                if (scope === "persistent" && !saved && !this.options.store.persistent) throw this.denied(identity);
				const { persistable: _persistable, ...grant } = identity;
				const previous = app.sessions[agent.id];
				if (previous?.decision === "allow" && (scope === "session" || app.always)) return {
					revoked: app.revoked,
					revision: previous.revision
				};
				const revision = (previous?.revision ?? 0) + 1;
				const next = {
					...app,
					...scope === "persistent" ? { always: grant } : {},
					sessions: {
						...app.sessions,
						[agent.id]: {
							identity: grant,
							decision: "allow",
							revision
						}
					}
				};
				await this.save(transaction, identity.id, next);
				return {
					revoked: next.revoked,
					revision
				};
			});
			signal.throwIfAborted();
			if (client.disposed) throw new NativeError("NATIVE_CLOSED", "Helper is closed; acquire fresh application handles");
			const state = this.clients.get(client) ?? {
				agent,
				handles: /* @__PURE__ */ new Map()
			};
			const { persistable: _persistable, ...grant } = identity;
			for (const [previous, previousState] of this.clients) if (previousState.agent === agent && previous !== client) {
				for (const selected of previousState.handles.values()) selected.lifetime.abort();
				this.clients.delete(previous);
			}
			state.handles.set(handle, {
				identity: grant,
				scope,
				sessionId: agent.id,
				revoked: authorized.revoked,
				revision: authorized.revision,
				lifetime: new AbortController()
			});
			this.clients.set(client, state);
		}));
	}
	/**
	* Enforce live consent at the operation that dispatches native work.
	* @param client Helper owning the application handle.
	* @param handle Selected application.
	* @param signal Calling tool lifetime.
	* @param dispatch One native operation, with revocation cancellation.
	* @param prepare Optional interactive preparation outside the application lock. Dispatch rechecks access after it settles.
	* @returns The native result, with no implicit retry after consent or cancellation.
	*/
	async run(client, handle, signal, dispatch, prepare) {
		const state = this.clients.get(client);
		const selected = state?.handles.get(handle);
		if (!state || !selected) throw new NativeError("APP_ACCESS_REQUIRED", "Select the application with getApp and obtain user consent before reading or controlling it");
		if (selected.lifetime.signal.aborted) throw new NativeError("APP_ACCESS_REVOKED", "Application access was revoked; stop using this application");
		const lifetime = AbortSignal.any([
			signal,
			this.lifetime.signal,
			selected.lifetime.signal
		]);
		const requireAccess = async () => {
            if (selected.scope === 'full-access' && !hasFullAccess(this.ctx, state.agent, this.options.fullAccessControlsDesktop)) {
                this.invalidate(selected.identity.id, state.agent);
                throw new NativeError('APP_ACCESS_REVOKED','Full access was disabled; select the application again under the current policy');
            }
			if (!await this.options.store.withState(lifetime, ({ state: permissions }) => this.permitted(selected, permissions.applications[selected.identity.id] ?? this.empty()))) {
				this.invalidate(selected.identity.id, state.agent);
				throw new NativeError("APP_ACCESS_REVOKED", "Application access was revoked; stop using this application");
			}
			if (client.disposed) throw new NativeError("NATIVE_CLOSED", "Helper is closed; acquire fresh application handles");
		};
		if (prepare) {
			await requireAccess();
			await prepare(lifetime);
			lifetime.throwIfAborted();
		}
		return this.options.store.withApplication(selected.identity.id, lifetime, async () => {
			await requireAccess();
			return this.withOperation(state.agent, client, selected.identity, lifetime, dispatch);
		});
	}
	async selectInOrder(agent, id, select) {
		const selections = this.selections.get(agent.id) ?? /* @__PURE__ */ new Map();
		this.selections.set(agent.id, selections);
		const operation = (selections.get(id) ?? Promise.resolve()).then(select, select);
		selections.set(id, operation);
		try {
			await operation;
		} finally {
			if (selections.get(id) === operation) selections.delete(id);
			if (selections.size === 0) this.selections.delete(agent.id);
		}
	}
	async withOperation(agent, client, identity, signal, dispatch) {
		const operation = {
			agent,
			client,
			identity,
			controller: new AbortController(),
			done: Promise.withResolvers()
		};
		this.active.add(operation);
		const lifetime = AbortSignal.any([
			signal,
			this.lifetime.signal,
			operation.controller.signal
		]);
		try {
			lifetime.throwIfAborted();
			const result = await dispatch(lifetime);
			lifetime.throwIfAborted();
			return result;
		} catch (error) {
			if (operation.controller.signal.aborted) throw operation.controller.signal.reason;
			throw error;
		} finally {
			this.active.delete(operation);
			operation.done.resolve();
		}
	}
	/**
	* Release the disposed agent's handles while retaining its session decisions.
	* @param agent Disposed agent whose selected handles are released.
	*/
	forget(agent) {
		for (const [client, state] of this.clients) if (state.agent === agent) this.clients.delete(client);
	}
	permitted(selection, app) {
		const session = app.sessions[selection.sessionId];
        if (selection.scope === 'full-access') return !selection.lifetime.signal.aborted && app.revoked === selection.revoked && !Object.values(app.sessions).some(s=>s.decision==='deny');
		return !selection.lifetime.signal.aborted && app.revoked === selection.revoked && (selection.scope === "persistent" ? app.always !== void 0 : session?.decision === "allow" && session.revision === selection.revision);
	}
	denied(identity) {
		return new NativeError("APP_ACCESS_DENIED", `The user denied access to ${identity.name}. Do not retry or use another tool to bypass this decision.`);
	}
	async decide(sessionId, identity, decision) {
		await this.options.store.withState(this.lifetime.signal, async (transaction) => {
			const app = transaction.state.applications[identity.id] ?? this.empty();
			await this.save(transaction, identity.id, {
				...app,
				sessions: {
					...app.sessions,
					[sessionId]: {
						identity: {
							id: identity.id,
							name: identity.name,
							executablePath: identity.executablePath
						},
						decision,
						revision: (app.sessions[sessionId]?.revision ?? 0) + 1
					}
				}
			});
		});
	}
	invalidate(id, agent) {
		const clients = /* @__PURE__ */ new Set();
		for (const [client, state] of this.clients) for (const selection of state.handles.values()) if (selection.identity.id === id && (agent === void 0 || state.agent.id === agent.id)) {
			selection.lifetime.abort(new NativeError("APP_ACCESS_REVOKED", "Application access was revoked; stop using this application"));
			clients.add(client);
		}
		for (const operation of this.active) if (operation.identity.id === id && (agent === void 0 || operation.agent.id === agent.id)) {
			operation.controller.abort(this.denied(operation.identity));
			clients.add(operation.client);
		}
		for (const client of clients) client.invalidate();
		return [...clients];
	}
	empty() {
		return {
			revoked: 0,
			sessions: {}
		};
	}
	read(id, signal = this.lifetime.signal) {
		return this.options.store.withState(signal, ({ state }) => state.applications[id] ?? this.empty());
	}
	save(transaction, id, app) {
		return transaction.save({
			...transaction.state,
			applications: {
				...transaction.state.applications,
				[id]: app
			}
		});
	}
};
//#endregion
//#region lib/types/protocol.js
/** JSON validation shared by model tool admission and the native object facade. */
const windowId = z.string().min(1);
const pixelDimension = z.number().int().positive().max(2 ** 32 - 1);
const point = z.number().nonnegative();
const relativePoint = z.number().int().min(0).max(999);
const traversalLimit = z.number().min(1).multipleOf(1);
const nativeTraversalLimits = z.object({
	maxElements: z.number().int().min(1).max(1e4),
	maxDepth: z.number().int().min(1).max(100)
}).strict();
const app = { appHandle: z.string().min(1) };
const pointer = {
	mouseButton: z.enum([
		"left",
		"right",
		"middle"
	]).optional(),
	modifiers: z.array(z.enum([
		"command",
		"control",
		"ctrl",
		"option",
		"alt",
		"shift",
		"win",
		"fn"
	])).optional()
};
const click = {
	...pointer,
	clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
	holdMs: z.number().int().nonnegative().optional().describe("Milliseconds between each mouse press and release; omitted for an ordinary click.")
};
const window = {
	...app,
	windowId
};
const jsonValue = z.json();
/** Provider-issued element reference from an accessibility observation. */
const elementId = z.string().min(1).describe("Opaque string defined by the platform provider, valid for at least the lifetime of one snapshot.");
const snapshot = {
	...app,
	windowId: windowId.optional(),
	snapshotId: z.string().min(1),
	elementId
};
const coordinate = {
	...window,
	snapshotId: z.string().min(1).optional(),
	x: point,
	y: point
};
const absoluteCoordinate = {
	...coordinate,
	relative: z.literal(false).optional().describe("Omitted or false uses pixels in the latest screenshot returned by this tool.")
};
const relativeCoordinate = {
	...coordinate,
	relative: z.literal(true).describe("Use integer thousandths of the window width and height, from 0 to 999."),
	x: relativePoint,
	y: relativePoint
};
const bounds = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number().nonnegative(),
	height: z.number().nonnegative()
});
const operation = (method, params) => z.object({
	method: z.literal(method),
	params: z.object(params).strict()
}).strict();
const imageBase64 = z.string().min(1).refine((value) => Buffer$1.from(value, "base64").toString("base64") === value, { message: "Expected canonical base64 image data" });
/** Shared hover target variants. Providers may add options without replacing a target or its coordinate mode. */
const MouseMoveTargets = [
	z.object(snapshot).strict(),
	z.object(absoluteCoordinate).strict(),
	z.object(relativeCoordinate).strict()
];
const dragTargets = [z.object({
	...window,
	...pointer,
	snapshotId: z.string().min(1).optional(),
	relative: z.literal(false).optional(),
	fromX: point,
	fromY: point,
	toX: point,
	toY: point
}).strict(), z.object({
	...window,
	...pointer,
	snapshotId: z.string().min(1).optional(),
	relative: relativeCoordinate.relative,
	fromX: relativePoint,
	fromY: relativePoint,
	toX: relativePoint,
	toY: relativePoint
}).strict()];
const systemPointerOption = { useSystemPointer: z.boolean().optional().describe("Request use of the system pointer. The Host checks permission before dispatch.") };
const toggle = z.object({
	...window,
	mouseButton: pointer.mouseButton.unwrap(),
	direction: z.enum(["down", "up"])
}).strict();
function requestSchema(hover, drag, button) {
	return z.discriminatedUnion("method", [
		operation("getCapabilities", {}),
		operation("listApps", {}),
		operation("findApps", { query: z.string().min(1, "Expected a non-empty search string").regex(/\S/, "Expected a non-empty search string") }),
		operation("getApp", { selector: z.string().min(1) }),
		operation("activate", app),
		operation("show", {
			...app,
			windowId: windowId.optional()
		}),
		operation("listWindows", app),
		operation("getState", {
			...app,
			windowId: windowId.optional(),
			includeMenus: z.boolean().optional().describe("Expand menu contents; omitted or false shows menu-bar entries only."),
			details: z.boolean().optional().describe("Include identifiers, global native bounds and complete action names."),
			maxElements: traversalLimit.optional().describe("Maximum nodes to visit on this read. Omission uses the provider setting."),
			maxDepth: traversalLimit.optional().describe("Maximum depth to traverse on this read. Omission uses the provider setting.")
		}),
		operation("listActions", snapshot),
		operation("performAction", {
			...snapshot,
			action: z.string().min(1),
			argument: jsonValue.optional()
		}),
		operation("invoke", snapshot),
		z.object({
			method: z.literal("toggleMouse"),
			params: button
		}).strict(),
		z.object({
			method: z.literal("mouseMove"),
			params: hover
		}).strict(),
		z.object({
			method: z.literal("click"),
			params: z.union([
				z.object({
					...snapshot,
					...click
				}).strict(),
				z.object({
					...absoluteCoordinate,
					...click
				}).strict(),
				z.object({
					...relativeCoordinate,
					...click
				}).strict()
			])
		}).strict(),
		operation("setValue", {
			...snapshot,
			value: jsonValue
		}),
		operation("selectText", {
			...snapshot,
			text: z.string().min(1),
			prefix: z.string().optional(),
			suffix: z.string().optional(),
			selectionType: z.enum([
				"text",
				"cursor_before",
				"cursor_after"
			]).optional()
		}),
		operation("typeText", {
			...app,
			windowId: windowId.optional(),
			text: z.string()
		}),
		operation("paste", {
			...app,
			windowId: windowId.optional(),
			text: z.string(),
			format: z.enum(["text", "html"]).optional()
		}),
		operation("pressKey", {
			...app,
			windowId: windowId.optional(),
			key: z.string().min(1),
			modifiers: z.array(z.string()).optional()
		}),
		operation("sendKeyEvent", {
			...app,
			windowId: windowId.optional(),
			key: z.string().min(1),
			direction: z.enum(["down", "up"])
		}),
		z.object({
			method: z.literal("scroll"),
			params: z.union([z.object({
				...absoluteCoordinate,
				deltaLinesX: z.number().int().min(-10).max(10),
				deltaLinesY: z.number().int().min(-10).max(10)
			}).strict(), z.object({
				...relativeCoordinate,
				deltaLinesX: z.number().int().min(-10).max(10),
				deltaLinesY: z.number().int().min(-10).max(10)
			}).strict()])
		}).strict(),
		z.object({
			method: z.literal("drag"),
			params: drag
		}).strict(),
		operation("screenshot", window)
	]);
}
/** Portable model operations, including standard hover without a system-pointer option. */
const Request = requestSchema(z.union(MouseMoveTargets), z.union(dragTargets), toggle);
/** Model operations for providers that can move the user's system pointer. */
const SystemPointerRequest = requestSchema(z.union(MouseMoveTargets.map((target) => target.extend(systemPointerOption))), z.union(dragTargets.map((target) => target.extend(systemPointerOption))), toggle.extend(systemPointerOption));
z.object({
	durationMs: z.number().int().min(1).max(5e3),
	steps: z.number().int().min(1).max(240)
}).strict(), z.object({
	maxClipboardBytes: z.number().int().min(1024),
	pasteReadTimeoutMs: z.number().int().min(1).max(2 ** 31 - 1),
	...nativeTraversalLimits.shape
}).strict(), z.object({ maxAppMatches: z.number().int().min(1).max(1e3) }).strict();
operation("launchApp", app), operation("permissionStatus", {}), operation("applicationIcons", { paths: z.array(z.string().min(1)) }), operation("requestPermission", { permission: z.enum(["accessibility", "screenRecording"]) }), operation("openPermissionSettings", { permission: z.enum(["accessibility", "screenRecording"]) });
/** Application selection returned only after a successful app selection. */
const AppResult = z.object({
	appHandle: z.string().min(1).transform((value) => value),
	name: z.string(),
	bundleId: z.string().optional(),
	running: z.boolean()
});
const processId = z.number().int().positive().max(2 ** 31 - 1);
const appProcess = z.discriminatedUnion("isRunning", [z.object({
	isRunning: z.literal(true),
	pid: processId.optional()
}), z.object({ isRunning: z.literal(false) })]);
z.array(z.intersection(z.union([appProcess, z.object({
	isRunning: z.literal(true).default(true),
	pid: processId
})]), z.object({
	id: z.string().min(1).optional(),
	name: z.string(),
	bundleId: z.string().optional()
})));
z.array(z.intersection(appProcess, z.object({
	id: z.string().min(1),
	displayName: z.string(),
	path: z.string().min(1)
})));
/** Current windows and their global native bounds. */
const WindowsResult = z.array(z.object({
	windowId,
	appName: z.string(),
	title: z.string(),
	bounds,
	isOnScreen: z.boolean(),
	onCurrentSpace: z.boolean().nullable()
}));
/** Observed state for the selected application or window. */
const StateResult = z.object({
	appHandle: z.string().min(1).transform((value) => value),
	windowId: windowId.nullable(),
	focusedWindowId: windowId.nullable().optional(),
	snapshotId: z.string().min(1).transform((value) => value),
	tree: z.string(),
	windows: WindowsResult,
	truncated: z.boolean(),
	hasUnreadableElements: z.boolean().optional()
});
z.array(z.string());
/** Original native PNG and platform window geometry before Host image preparation. */
const NativeScreenshotResult = z.object({
	mimeType: z.literal("image/png"),
	data: imageBase64,
	pixelWidth: pixelDimension,
	pixelHeight: pixelDimension,
	windowId,
	bounds: bounds.extend({
		width: z.number().positive(),
		height: z.number().positive()
	}),
	coordinateSpace: z.enum(["window-points", "window-pixels"])
});
NativeScreenshotResult.extend({
	mimeType: z.enum([
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif"
	]),
	coordinateSpace: z.literal("screenshot-pixels")
});
z.object({
	platform: z.string(),
	permissions: z.object({
		accessibility: z.boolean(),
		screenRecording: z.boolean()
	}),
	/** Whether the provider supports application-level accessibility observations. */
	appLevelAccessibility: z.boolean(),
	/** Whether mouseMove accepts an explicit request to move the system pointer. */
	systemPointer: z.boolean().default(false),
	/** Scopes that support keyboard input. */
	keyboard: z.array(z.enum(["app", "window"])),
	sessionLocked: z.boolean().nullable(),
	methods: z.array(z.string()),
	coordinateSpace: z.literal("screenshot-pixels"),
	browser: z.literal(false)
});
/** Reports whether the provider successfully executed the requested operation. */
const ActionResult = z.object({
	/** True when the provider successfully executed the operation; false when no applicable operation was found. */
	dispatched: z.boolean(),
	/** Sampled foreground change; omitted when the provider does not sample this action, null when a requested sample was unavailable. */
	foregroundChanged: z.boolean().nullable().optional()
});
ActionResult.extend({
	hoverRoute: z.enum(["accessibility", "system-pointer"]),
	systemPointerMoved: z.boolean()
});
ActionResult.extend({
	windowId: windowId.nullable(),
	foregroundChanged: z.boolean().nullable()
});
/** Bounded native PNG thumbnail for human presentation, excluded from model results and saved grants. */
const ApplicationIcon = z.string().max(65536).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
//#endregion
//#region lib/types/access.js
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const permissionProcess = z.object({
	path: z.string().optional(),
	name: z.string().optional()
});
const macPermissionProcess = permissionProcess.extend({ pid: z.number().int().positive() });
const systemPermissions = z.discriminatedUnion("platform", [z.object({
	platform: z.literal("darwin"),
	accessibility: z.boolean(),
	screenRecording: z.boolean(),
	helper: macPermissionProcess,
	parent: macPermissionProcess,
	launchApplication: z.object({
		name: z.string().min(1),
		path: z.string().min(1),
		icon: ApplicationIcon.optional()
	}).optional()
}), z.object({
	platform: z.literal("windows"),
	sessionLocked: z.boolean().nullable(),
	captureAvailable: z.boolean(),
	elevated: z.boolean(),
	helper: permissionProcess
})]);
/** Browser controls for provider-owned native permission and application decisions. */
let CuaAccess = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _ptcConfiguration_decorators;
	let _enablePersistentPtc_decorators;
	let _applications_decorators;
	let _systemStatus_decorators;
	let _applicationIcons_decorators;
	let _requestPermission_decorators;
	let _openSettings_decorators;
	let _revoke_decorators;
	let _retryApproval_decorators;
	return class CuaAccess extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_ptcConfiguration_decorators = [Remote];
			_enablePersistentPtc_decorators = [Remote];
			_applications_decorators = [Remote];
			_systemStatus_decorators = [Remote];
			_applicationIcons_decorators = [Remote];
			_requestPermission_decorators = [Remote];
			_openSettings_decorators = [Remote];
			_revoke_decorators = [Remote];
			_retryApproval_decorators = [Remote];
			__esDecorate(this, null, _ptcConfiguration_decorators, {
				kind: "method",
				name: "ptcConfiguration",
				static: false,
				private: false,
				access: {
					has: (obj) => "ptcConfiguration" in obj,
					get: (obj) => obj.ptcConfiguration
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _enablePersistentPtc_decorators, {
				kind: "method",
				name: "enablePersistentPtc",
				static: false,
				private: false,
				access: {
					has: (obj) => "enablePersistentPtc" in obj,
					get: (obj) => obj.enablePersistentPtc
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _applications_decorators, {
				kind: "method",
				name: "applications",
				static: false,
				private: false,
				access: {
					has: (obj) => "applications" in obj,
					get: (obj) => obj.applications
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _systemStatus_decorators, {
				kind: "method",
				name: "systemStatus",
				static: false,
				private: false,
				access: {
					has: (obj) => "systemStatus" in obj,
					get: (obj) => obj.systemStatus
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _applicationIcons_decorators, {
				kind: "method",
				name: "applicationIcons",
				static: false,
				private: false,
				access: {
					has: (obj) => "applicationIcons" in obj,
					get: (obj) => obj.applicationIcons
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _requestPermission_decorators, {
				kind: "method",
				name: "requestPermission",
				static: false,
				private: false,
				access: {
					has: (obj) => "requestPermission" in obj,
					get: (obj) => obj.requestPermission
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _openSettings_decorators, {
				kind: "method",
				name: "openSettings",
				static: false,
				private: false,
				access: {
					has: (obj) => "openSettings" in obj,
					get: (obj) => obj.openSettings
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _revoke_decorators, {
				kind: "method",
				name: "revoke",
				static: false,
				private: false,
				access: {
					has: (obj) => "revoke" in obj,
					get: (obj) => obj.revoke
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _retryApproval_decorators, {
				kind: "method",
				name: "retryApproval",
				static: false,
				private: false,
				access: {
					has: (obj) => "retryApproval" in obj,
					get: (obj) => obj.retryApproval
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		policy = __runInitializers(this, _instanceExtraInitializers);
		control;
		permissionParameters;
		/**
		* @param ctx Provider context.
		* @param policy Application decision owner.
		* @param control Serialized native permission dispatch.
		* @param permissionParameters Provider-owned native parameters for the selected action and Client language.
		*/
		constructor(ctx, policy, control, permissionParameters) {
			super(ctx, "cuaAccess");
			this.policy = policy;
			this.control = control;
			this.permissionParameters = permissionParameters;
		}
		/** Read PTC execution state separately from native permission checks.
		* @returns Whether the shared runtime retains memory and has an editable profile entry.
		*/
		ptcConfiguration() {
			return {
				persistent: this.ctx.get("ptcRuntime")?.retainsState === true,
				writable: this.ctx.get("configEditor")?.entries().some((entry) => entry.options.id === "ptc-runtime") ?? false
			};
		}
		/** Persist in-memory PTC execution through the existing profile editor and Loader lifecycle.
		* @returns Completion after the shared runtime reload; already-persistent runtimes are left intact.
		*/
		async enablePersistentPtc() {
			if (this.ptcConfiguration().persistent) return;
			const editor = this.ctx.get("configEditor");
			const entry = editor?.entries().find((entry) => entry.options.id === "ptc-runtime");
			if (editor === void 0 || entry === void 0) throw new Error("PTC runtime has no editable profile entry");
			await editor.edit(entry, (current) => ({
				...current,
				...resolvePersistentExecution(this.ctx.get("ptcRuntime")?.programFormat)
			}));
		}
		/**
		* Read fresh stored application decisions without issuing a native request.
		* @returns Saved grants, refused applications and durable-storage availability.
		*/
		applications() {
			return this.policy.status();
		}
		/**
		* Inspect system privileges independently of application decisions and icons.
		* @returns Platform-tagged access observations and native process metadata.
		*/
		async systemStatus() {
			return systemPermissions.parse(await this.control("permissionStatus", {}));
		}
		/**
		* Load presentation icons separately from application decisions.
		* @returns Optional native PNG icons keyed by executable path; applications without paths are skipped.
		*/
		async applicationIcons() {
			const state = await this.policy.status();
			const paths = [...new Set([...state.allowedApps, ...state.blockedApps].flatMap((app) => app.executablePath === void 0 ? [] : [app.executablePath]))];
			return paths.length === 0 ? {} : z.record(z.string(), ApplicationIcon).parse(await this.control("applicationIcons", { paths }));
		}
		/**
		* Request the selected system privilege through the native provider.
		* @param permission macOS privilege to request.
		* @param locale Current Client language for provider-owned permission UI.
		* @returns Current permission observations; requesting does not establish consent.
		*/
		async requestPermission(permission, locale) {
			return systemPermissions.parse(await this.control("requestPermission", this.permissionParameters("requestPermission", permission, locale)));
		}
		/**
		* Open the macOS privacy pane selected by the user.
		* @param permission Corresponding system privilege.
		* @param locale Current Client language for provider-owned recovery instructions.
		* @returns Completion after macOS accepted the open request.
		*/
		async openSettings(permission, locale) {
			z.object({ opened: z.literal(true) }).parse(await this.control("openPermissionSettings", this.permissionParameters("openPermissionSettings", permission, locale)));
		}
		/**
		* Remove saved and session access and join affected operations.
		* @param id Application identity displayed on the permission page.
		* @returns Completion after persistence and cancellation; dispatched input cannot be undone.
		*/
		revoke(id) {
			return this.policy.revoke(id);
		}
		/**
		* Clear this application's refusals across sessions so each session may ask for access again.
		* @param id Refused or revoked application displayed on the permission page.
		* @returns Completion after clearing refusals; no permission is granted and no action is replayed.
		*/
		async retryApproval(id) {
			await this.policy.retryApproval(id);
		}
	};
})();
/**
* Install human-facing controls while keeping executor capabilities private to the provider.
* @param ctx Provider context that owns decisions and operation lifetimes.
* @param options Native transport and profile persistence.
* @returns Consent selection, guarded dispatch, and task cleanup capabilities.
*/
function installCuaAccess(ctx, options) {
	const policy = new ApplicationAccess(ctx, options);
	const lifetime = new AbortController();
	let client;
	let tail = Promise.resolve();
	const control = (method, params) => {
		lifetime.signal.throwIfAborted();
		const perform = async () => {
			lifetime.signal.throwIfAborted();
			if (client?.disposed) {
				const previous = client;
				try {
					await previous.dispose();
				} finally {
					client = void 0;
				}
			}
			lifetime.signal.throwIfAborted();
			if (!client || client.disposed) client = new NativeClient(ctx, options.native, options.createChannel);
			return client.request(method, params, lifetime.signal);
		};
		const operation = tail.then(perform, perform);
		tail = operation;
		return operation;
	};
	const dispose = ctx.effect(() => async () => {
		lifetime.abort();
		await Promise.allSettled([policy.dispose(), tail]);
		await client?.dispose();
	}, "cua-access.dispose");
	new CuaAccess(ctx, policy, control, options.permissionParameters);
	return {
		select: policy.select.bind(policy),
		run: policy.run.bind(policy),
		forget: policy.forget.bind(policy),
		dispose
	};
}
//#endregion
//#region lib/types/config.js
/** Schemastery fields for platform-specific native CUA configuration. */
const runtimeFields = {
	...NodePtcRuntime.Config.dict,
	executionMode: Schema.never().hidden(),
	scriptPersistence: Schema.never().hidden()
};
/** Validate CUA program limits with the shared Node and executor defaults. */
const CuaStandaloneRunCodeConfig = Schema.object({
	runtime: Schema.object(runtimeFields).default({}),
	executor: RunCodeConfig.default({})
});
/** Validate an explicit screenshot target; omission resolves the target from the Agent's model route. */
const CuaScreenshotTargetConfig = Schema.object({
	longEdge: Schema.number().step(1).min(1).max(16384).required(),
	maxBytes: Schema.number().step(1).min(1024).required()
});
/** Shared configuration fields extended by native platform providers. */
const CuaConfigFields = {
	requireSystemPointerApproval: Schema.boolean().default(true),
	agentPreset: Schema.union([Schema.string().min(1), Schema.const(false)]).default("ptc"),
	standaloneRunCode: CuaStandaloneRunCodeConfig.default({}),
	screenshotTarget: Schema.union([CuaScreenshotTargetConfig, Schema.const(void 0)]),
	allowedApps: Schema.array(Schema.object({
		id: Schema.string().pattern(/^[a-f0-9]{64}$/).required(),
		name: Schema.string().required(),
		executablePath: Schema.string().min(1)
	})).default([]),
	helperPath: Schema.string(),
	buildTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3e5),
	timeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3e4),
	connectTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5e3),
	screenshotTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5e3),
	axTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3e3),
	maxAppMatches: Schema.number().step(1).min(1).max(1e3).default(20),
	maxClipboardBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
	pasteReadTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(1e3),
	maxRequestBytes: Schema.number().step(1).min(1024).default(1024 * 1024),
	dragDurationMs: Schema.number().step(1).min(1).max(5e3).default(400),
	maxClickHoldMs: Schema.number().step(1).min(0).max(2 ** 31 - 1).default(5e3),
	dragSteps: Schema.number().step(1).min(1).max(240).default(20),
	maxResponseBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
	textEventIntervalMs: Schema.number().min(0).max(1e3).default(.25),
	graceMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3e3),
	maxElements: Schema.number().step(1).min(1).max(1e4).default(2e3),
	maxDepth: Schema.number().step(1).min(1).max(100).default(25)
};
//#endregion
//#region lib/types/tool-registration.js
/** Agent-scoped raw CUA and persistent program tool registrations. */
const programDescription = "Run a TypeScript program to observe and operate desktop applications. The global cua object is ready to use; retain application and window objects across calls. Only tools.cua is available inside the program. Call other session tools directly. Use inspect(...values) to display selected text and images.";
/**
* Project a configured screenshot target onto one stored image.
* @param configured - Validated `screenshotTarget`.
* @param image - Durable normalized screenshot.
* @returns The request target for that image: the long edge capped at the configured value, the configured byte budget.
*/
function fixedScreenshotTarget(configured, image) {
	return {
		...longEdgeDimensions(image.width, image.height, configured.longEdge),
		maxBytes: configured.maxBytes
	};
}
/**
* Register raw CUA for Agents on the configured preset and a persistent program tool for every other Agent,
* including Agents without a preset and compositions without a preset registry.
* @param ctx Provider context owning native calls and registrations.
* @param config Validated preset selection and dedicated runtime bounds.
* @param tool Internal native tool; Agents off the configured preset can reach it only through the program.
* @param guidance Raw-tool operation instructions for the configured preset.
* @param programGuidance Operation instructions available inside cua_run_code.
* @returns Exact registration disposer, draining programs before native resources can close.
*/
function installCuaTools(ctx, config, tool, guidance, programGuidance) {
	const ptcBridgeUrl = JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-cua/bridge'));
	const programBridgeUrl = JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-cua/bridge'));
	const prompt = {
		name: CUA_PROMPT_SECTION_NAME,
		order: ctx.systemPrompt.getSectionOrder("TOOL_COMPUTER_USE")
	};
	const rawPrompt = {
		...prompt,
		text: () => {
			return !ctx.get("ptcRuntime")?.retainsState ? guidance : `${guidance}

In persistent PTC, use the host-provided bridge initialization once and retain the returned objects; cua comes from that bridge and is not a preinstalled global.

Persistent PTC initialization:

\`\`\`ts
var { connectCua } = await import(${ptcBridgeUrl});
var cua = connectCua(() => tools.cua);
\`\`\``;
		}
	};
	const register = (scope, definition, instructions) => {
		const removeTool = scope.tools.register(definition);
		let removePrompt;
		try {
			removePrompt = scope.systemPrompt.section(instructions);
		} catch (error) {
			removeTool();
			throw error;
		}
		return () => {
			try {
				removePrompt();
			} finally {
				removeTool();
			}
		};
	};
	if (config.agentPreset === false) return register(ctx, tool, rawPrompt);
	return ctx.inject([
		"tools",
		"agents",
		"systemPrompt"
	], (base) => {
		const scopes = /* @__PURE__ */ new Map();
		let program;
		let programs;
		let closing = false;
		const modeOf = (agent) => base.get("agentPresets")?.composedPreset(agent.ctx) === config.agentPreset ? "raw" : "program";
		const sync = (agent) => {
			const mode = modeOf(agent);
			const definition = mode === "raw" ? tool : program;
			let entry = scopes.get(agent);
			if (entry?.current?.definition === definition) return;
			if (entry?.current !== void 0) {
				entry.current.remove();
				delete entry.current;
			}
			if (definition === void 0) return;
			if (entry === void 0) {
				const scope = createScope(agent.ctx, agent);
				entry = { scope };
				scopes.set(agent, entry);
				scope.ctx.effect(() => () => {
					scopes.delete(agent);
				}, "cua.agent-tools");
			}
			const remove = register(entry.scope.ctx, definition, mode === "raw" ? rawPrompt : {
				...prompt,
				text: programGuidance
			});
			entry.current = {
				definition,
				remove
			};
		};
		const syncAll = () => {
			for (const agent of base.agents.list()) sync(agent);
		};
		const resync = (agent) => {
			try {
				sync(agent);
			} catch (error) {
				base.logger.warn(`CUA tool scope update failed: ${String(error)}`);
			}
		};
		const resyncAll = () => {
			for (const agent of base.agents.list()) resync(agent);
		};
		base.effect(function* () {
			yield async () => {
				await Promise.all([...scopes.values()].map(({ scope }) => scope.dispose()));
			};
			const runtimeCtx = base.isolate("ptcRuntime");
			const runtime = runtimeCtx.plugin(NodePtcRuntime, {
				...config.standaloneRunCode.runtime,
				executionMode: "persistent-in-memory",
				scriptPersistence: false
			});
			yield runtime.dispose;
			const initializer = runtimeCtx.plugin({
				name: "cua-program-initializer",
				inject: ["ptcRuntime"],
				apply(owner) {
					owner.effect(function* () {
						yield owner.ptcRuntime.registerEnvironmentInitializer(`globalThis.cua = (await import(${programBridgeUrl})).connectCua(() => tools.cua);`);
						const child = owner.plugin({
							name: "cua-program-tools",
							inject: [
								"ptcRuntime",
								"tools",
								"workingDirectory"
							],
							apply(consumer) {
								const definition = createRunCodeTool(consumer, {
									name: "cua_run_code",
									description: programDescription,
									runtime: consumer.ptcRuntime,
									tools: [tool],
									limits: config.standaloneRunCode.executor
								});
								consumer.provide("cuaPrograms", {
									release: (agent) => consumer.ptcRuntime.release(agent),
									screenshotRequestTarget: (image) => config.screenshotTarget === void 0 ? void 0 : fixedScreenshotTarget(config.screenshotTarget, image)
								});
								consumer.effect(function* () {
									yield () => {
										if (program !== definition) return;
										program = void 0;
										syncAll();
									};
									program = definition;
									syncAll();
								}, "cua.program-publication");
							}
						});
						programs = child;
						yield () => {
							programs = void 0;
						};
						yield child.dispose;
					}, "cua.environment-initializer");
				}
			});
			yield initializer.dispose;
			yield base.on("agent/created", async ({ agent }) => {
				if (closing) return;
				if (modeOf(agent) === "program") {
					if (runtime.uid !== null) await runtime.await();
					await initializer.await();
					await programs?.await();
					if (closing) return;
					if (modeOf(agent) === "program" && program === void 0) throw new Error("CUA program tool is unavailable; restore its private runtime and workingDirectory services, or reload the provider");
				}
				sync(agent);
			});
			yield base.on("agent-preset/selected", (id) => {
				const agent = base.agents.get(id);
				if (agent !== void 0) resync(agent);
			});
			yield base.inject(["agentPresets"], (registry) => {
				registry.effect(() => () => {
					if (!closing) resyncAll();
				}, "cua.preset-registry");
				resyncAll();
			}).dispose;
			yield () => {
				closing = true;
				program = void 0;
				for (const entry of scopes.values()) {
					entry.current?.remove();
					delete entry.current;
				}
			};
			syncAll();
		}, "cua.program-runtime");
	}).dispose;
}
//#endregion
//#region lib/types/coordinates.js
/** Tracks only the current window geometry and last successfully prepared screenshot. */
var CuaCoordinates = class {
	applications = /* @__PURE__ */ new Map();
	/**
	* Invalidate screenshot mappings when a window closes or changes size.
	* @param appHandle - native application selection.
	* @param windows - freshly observed windows.
	* @param windowId - selected window for a scoped observation; omission means a complete application inventory.
	*/
	observe(appHandle, windows, windowId) {
		const previous = this.applications.get(appHandle);
		const current = new Map(windowId === void 0 ? [] : previous);
		if (windowId !== void 0 && !windows.some((window) => window.windowId === windowId)) current.delete(windowId);
		for (const window of windows) {
			const { width, height } = window.bounds;
			const old = previous?.get(window.windowId);
			current.set(window.windowId, old?.width === width && old.height === height ? old : {
				width,
				height
			});
		}
		this.applications.set(appHandle, current);
	}
	/**
	* Bind the exact image delivered to the model to its native window size.
	* @param appHandle - native application selection.
	* @param windowId - selected native window.
	* @param bounds - capture-time window size in the provider’s native units.
	* @param image - encoded model-request image dimensions.
	*/
	screenshot(appHandle, windowId, bounds, image) {
		let frames = this.applications.get(appHandle);
		if (!frames) {
			frames = /* @__PURE__ */ new Map();
			this.applications.set(appHandle, frames);
		}
		frames.set(windowId, {
			width: bounds.width,
			height: bounds.height,
			image: {
				width: image.width,
				height: image.height
			}
		});
	}
	/**
	* Convert admitted coordinate arguments once, before native dispatch.
	* @param request - model request already checked by the operation schema.
	* @returns native parameters with Host-only coordinate options removed.
	*/
	parameters(request) {
		const params = request.params;
		const native = z.record(z.string(), z.json()).parse(params);
		if (!("x" in params) && !("fromX" in params)) return native;
		const frame = this.applications.get(params.appHandle)?.get(params.windowId);
		if (!frame || frame.width <= 0 || frame.height <= 0) throw new NativeError("STALE_SNAPSHOT", "Read fresh window state before coordinate input");
		const relative = params.relative === true;
		if (!relative && !frame.image) throw new NativeError("SCREENSHOT_REQUIRED", "Take a fresh screenshot before using absolute pixel coordinates");
		const convert = (value, axis) => {
			const pixels = frame.image?.[axis] ?? frame[axis];
			if (relative) return Math.min(value / 1e3 * frame[axis], Math.max(0, frame[axis] - 1));
			if (value >= pixels) throw new NativeError("INVALID_ARGUMENT", "Coordinate is outside the latest screenshot");
			return value * frame[axis] / pixels;
		};
		delete native.relative;
		if ("x" in params) {
			native.x = convert(params.x, "width");
			native.y = convert(params.y, "height");
		} else {
			native.fromX = convert(params.fromX, "width");
			native.fromY = convert(params.fromY, "height");
			native.toX = convert(params.toX, "width");
			native.toY = convert(params.toY, "height");
		}
		return native;
	}
};
//#endregion
//#region lib/types/native-observation.js
/** Host-only decoding of native window observations before tool results reach a caller. */
const NativeWindows = WindowsResult.element.extend({ cacheOnly: z.literal(true).optional() }).array();
const NativeState = StateResult.extend({ windows: NativeWindows });
/**
* Keep geometry for every live window but return only discovered or explicitly selected windows.
* @param request - Authorized observation and its expected app/window identity.
* @param result - Untrusted native reply, including any cache-only records.
* @param coordinates - The calling Agent's screenshot and coordinate cache.
* @returns Public observation with private fields removed.
*/
function observeNativeWindows(request, result, coordinates) {
	const appHandle = request.params.appHandle;
	function observe(windows, selected) {
		coordinates.observe(appHandle, windows, selected);
		return windows.flatMap(({ cacheOnly, ...window }) => !cacheOnly || window.windowId === selected ? [window] : []);
	}
	if (request.method === "listWindows") return observe(NativeWindows.parse(result));
	const state = NativeState.parse(result);
	if (state.appHandle !== appHandle || state.windowId !== (request.params.windowId ?? null)) throw new NativeError("NATIVE_PROTOCOL", "Native observation belongs to another application or window");
	return {
		...state,
		windows: observe(state.windows, request.params.windowId)
	};
}
//#endregion
//#region lib/types/index.js
/** Shared CUA tool execution, application consent, and object-runtime integration. */
/** Validate shared configuration for native providers. */
const CuaConfig = Schema.object(CuaConfigFields);
function executionAgent(execution) {
	if (!execution.agent) throw new ToolContextUnavailableError("dsh-cua requires an agent-owned execution");
	return execution.agent;
}
/**
* Describe one request issue for the model. A union that no accepted form matches lists each form's own
* issues, so the model learns which field to add or remove, such as a missing `params.y`.
* @param issue - one issue from parsing the request.
* @param base - path of the value the issue belongs to.
* @returns a single-line violation naming the field and the reason.
*/
function requestViolation(issue, base = []) {
	const path = [...base, ...issue.path];
	const field = path.length > 0 ? path.map(String).join(".") : "arguments";
	if (issue.code !== "invalid_union" || issue.errors.length === 0) return `${field}: ${issue.message}`;
	return `${field}: matches none of the accepted forms: ${issue.errors.map((form) => `(${form.map((nested) => requestViolation(nested, path)).join("; ")})`).join(" or ")}`;
}
/** Parse the tool request; refinements the parameter schema cannot express fail as argument errors. */
function parseRequest(schema, args) {
	const parsed = schema.safeParse(args);
	if (!parsed.success) throw new ToolArgsError(parsed.error.issues.map((issue) => requestViolation(issue)));
	return parsed.data;
}
/** Native cancellation after the caller cancelled keeps its diagnostic; the tool registry records it as `ABORTED`. */
function callerCancelled(error) {
	const cancelled = new Error(error.message, { cause: error });
	cancelled.name = "AbortError";
	return cancelled;
}
const nativeDiscoveryRows = z.array(z.record(z.string(), z.json()));
/** Native values stay available to programs; only metadata and the stored image enter model content. */
function renderResult(args, value) {
	if (args.method !== "screenshot") return [{
		type: "text",
		text: JSON.stringify(value)
	}];
	const { data: _data, mimeType: _mimeType, attachment, ...metadata } = value;
	return [{
		type: "text",
		text: JSON.stringify(metadata)
	}, {
		type: "image",
		attachment
	}];
}
/** Resolve the attachment store and the request-image target before requesting a screenshot. */
async function screenshotStore(ctx, execution, configured) {
	const attachments = ctx.get("attachments");
	if (!attachments) throw new ToolContextUnavailableError("CUA screenshots require an attachment store");
	if (configured !== void 0) return {
		attachments,
		target: (image) => fixedScreenshotTarget(configured, image)
	};
	const agent = execution.agent;
	const routed = agent.session.requestHeader()?.config;
	const provider = routed?.provider ?? agent.options.provider;
	const model = routed?.model ?? agent.options.model;
	const llm = ctx.get("llm");
	if (provider === void 0 || model === void 0 || llm === void 0) throw new ToolContextUnavailableError("CUA screenshot model route could not be resolved");
	const info = await llm.resolveModelInfo(provider, model, execution.signal);
	execution.signal.throwIfAborted();
	if (!info.inputModalities?.includes("image")) throw new NativeError("MODEL_DOES_NOT_SUPPORT_IMAGES", `CUA screenshots require model "${model}" to declare image input`);
	return {
		attachments,
		target: (image) => llm.imageRequestTarget(provider, model, image)
	};
}
/**
* Install authorized CUA calls and Agent-owned native connections.
* @param ctx - Provider context with computer-use, subprocess, tools, prompt, and Agent services.
* @param config - Validated resource limits and live application grants.
* @param backend - Platform-owned executable, connection factory, and instructions.
*/
function installCua(ctx, config, backend) {
	const { helperPath } = backend;
	const systemPointer = backend.capabilities.systemPointer === true;
	const mouseControl = systemPointer ? new MouseControl(ctx, config.requireSystemPointerApproval) : void 0;
	const requestSchema = systemPointer ? SystemPointerRequest : Request;
	const formatGuidance = (text) => {
		return `${systemPointer ? withSystemPointerGuidance(text) : text}\n\nAX read defaults: maxElements=${config.maxElements}, maxDepth=${config.maxDepth}.\n\nMaximum click holdMs: ${config.maxClickHoldMs} ms.`;
	};
	const guidance = formatGuidance(backend.getGuidance("raw"));
	const programGuidance = formatGuidance(backend.getGuidance("standalone"));
	const native = {
		helperPath,
		cwd: process.cwd(),
		timeoutMs: config.timeoutMs,
		axTimeoutMs: config.axTimeoutMs,
		connectTimeoutMs: config.connectTimeoutMs,
		screenshotTimeoutMs: config.screenshotTimeoutMs,
		maxRequestBytes: config.maxRequestBytes,
		maxResponseBytes: config.maxResponseBytes,
		graceMs: config.graceMs,
		textEventIntervalMs: config.textEventIntervalMs,
		maxClickHoldMs: config.maxClickHoldMs
	};
	const access = installCuaAccess(ctx, {
		fullAccessControlsDesktop: config.fullAccessControlsDesktop === true,
		native,
		createChannel: backend.createChannel,
		permissionParameters: backend.permissionParameters,
		store: new CuaPermissionStore(ctx, config.allowedApps.map((grant) => ({
			...grant,
			id: grant.id
		})), config.timeoutMs)
	});
	const clients = /* @__PURE__ */ new Map();
	const lifetime = new AbortController();
	const pending = /* @__PURE__ */ new Map();
	const ownerCleanups = /* @__PURE__ */ new Map();
	const closedOwners = /* @__PURE__ */ new WeakSet();
	function ownerFor(agent) {
		if (closedOwners.has(agent) || ctx.agents.get(agent.id) !== agent) throw new ToolContextUnavailableError("dsh-cua agent has been disposed");
		const existing = ownerCleanups.get(agent);
		if (existing) return existing;
		const controller = new AbortController();
		let closing;
		const close = () => {
			closedOwners.add(agent);
			controller.abort();
			return closing ??= Promise.resolve().then(async () => {
				try {
					await clients.get(agent)?.dispose();
				} finally {
					await Promise.allSettled([...pending].filter(([, owner]) => owner === agent).map(([task]) => task));
					clients.delete(agent);
					access.forget(agent);
					ownerCleanups.delete(agent);
				}
			});
		};
		const owner = {
			close,
			release: agent.ctx.effect(() => close, "dsh-cua.agent"),
			signal: controller.signal,
			coordinates: new CuaCoordinates()
		};
		ownerCleanups.set(agent, owner);
		return owner;
	}
	ctx.effect(function* () {
		yield ctx.computerUse.register(brandString("dsh-cua"));
		yield async () => {
			lifetime.abort();
			const permissions = Promise.allSettled([access.dispose()]);
			await Promise.allSettled(pending.keys());
			const owners = [...ownerCleanups.values()];
			const results = await Promise.allSettled(owners.map((owner) => owner.close()));
			const releases = await Promise.allSettled(owners.map((owner) => owner.release()));
			const errors = [];
			for (const result of [
				...await permissions,
				...results,
				...releases
			]) if (result.status === "rejected") errors.push(result.reason);
			if (errors.length > 0) throw new AggregateError(errors, "dsh-cua helper cleanup failed");
		};
		const callNative = async (request, execution, useSystemPointer) => {
			const { method, params: parsedParams } = request;
			const params = execution.coordinates.parameters(request);
			const agent = execution.agent;
			const signal = execution.signal;
			signal.throwIfAborted();
			const client = execution.nativeClient;
			if (method !== "mouseMove" && !useSystemPointer) delete params.useSystemPointer;
			else if (useSystemPointer !== void 0) params.useSystemPointer = useSystemPointer;
			if (method === "sendKeyEvent" && backend.sendKeyEvent) return backend.sendKeyEvent(client, params, execution);
			if (method === "toggleMouse" && useSystemPointer && params.direction === "down") mouseControl?.trackPress(agent, client);
			const nativeParams = method === "findApps" ? {
				...params,
				maxAppMatches: config.maxAppMatches
			} : method === "paste" ? {
				...params,
				maxClipboardBytes: config.maxClipboardBytes,
				pasteReadTimeoutMs: config.pasteReadTimeoutMs,
				maxElements: config.maxElements,
				maxDepth: config.maxDepth
			} : method === "getState" ? {
				maxElements: config.maxElements,
				maxDepth: config.maxDepth,
				...params
			} : method === "drag" ? {
				...params,
				durationMs: config.dragDurationMs,
				steps: config.dragSteps
			} : params;
			const requestNative = () => client.request(method, nativeParams, signal, execution.callId);
			if (method === "screenshot") {
				const { attachments, target } = await screenshotStore(ctx, execution, config.screenshotTarget);
				const screenshot = NativeScreenshotResult.parse(await requestNative());
				if (screenshot.windowId !== parsedParams.windowId) throw new NativeError("NATIVE_PROTOCOL", "Native screenshot belongs to another window");
				signal.throwIfAborted();
				const stage = async (name, operation) => {
					try {
						return await operation();
					} catch (error) {
						signal.throwIfAborted();
						const code = attachments.isAttachmentError(error) ? error.code : "SCREENSHOT_IMAGE_FAILED";
						const summary = error instanceof Error ? error.message.slice(0, 300) : "Image processing failed";
						const cause = error instanceof Error && error.cause instanceof Error ? ` Cause: ${error.cause.message.slice(0, 300)}` : "";
						throw new NativeError(code, `Screenshot ${name} failed for window ${screenshot.windowId} (${screenshot.pixelWidth}x${screenshot.pixelHeight}, ${screenshot.data.length} encoded bytes): ${summary}${cause} No screenshot was delivered; capture fresh state before using image coordinates.`, { cause: error });
					}
				};
				const refs = await stage("image admission", () => admitEncodedImages(attachments, [{
					data: screenshot.data,
					mediaType: screenshot.mimeType
				}]));
				signal.throwIfAborted();
				let attachment = refs[0];
				const original = attachment.originalDimensions ?? attachment;
				if (original.width !== screenshot.pixelWidth || original.height !== screenshot.pixelHeight) throw new NativeError("NATIVE_PROTOCOL", "Native screenshot dimensions disagree with its decoded image");
				const image = await stage("model image preparation", () => attachments.readImageRequest(attachment, target(attachment), signal));
				signal.throwIfAborted();
				if (image.width !== attachment.width || image.height !== attachment.height) {
					attachment = await stage("image storage", () => attachments.saveImage({
						data: image.data,
						mediaType: image.mediaType
					}));
					signal.throwIfAborted();
				}
				execution.coordinates.screenshot(parsedParams.appHandle, screenshot.windowId, screenshot.bounds, image);
				return {
					...screenshot,
					mimeType: image.mediaType,
					data: Buffer$1.from(image.data).toString("base64"),
					pixelWidth: image.width,
					pixelHeight: image.height,
					coordinateSpace: "screenshot-pixels",
					attachment
				};
			}
			const result = method === "paste" ? await withFileLock(join(tmpdir(), "dsh-cua-system-clipboard"), requestNative, {
				waitMs: config.timeoutMs,
				signal
			}) : await requestNative();
			if (method === "getApp") {
				const prepared = AppResult.parse(result);
				const { authorization, applicationIcon } = z.object({
					authorization: ApplicationAuthorizationResult,
					applicationIcon: ApplicationIcon.optional()
				}).parse(result);
				await access.select(agent, client, prepared.appHandle, authorization, signal, applicationIcon);
				signal.throwIfAborted();
				const selected = prepared.running ? prepared : AppResult.parse(await access.run(client, prepared.appHandle, signal, (signal) => client.request("launchApp", { appHandle: prepared.appHandle }, signal, execution.callId)));
				if (selected.appHandle !== prepared.appHandle) throw new NativeError("NATIVE_PROTOCOL", "Launched application has another handle");
				return selected;
			}
			signal.throwIfAborted();
			if ((method === "listApps" || method === "findApps") && !backend.acceptsPidSelector) return nativeDiscoveryRows.parse(result).map(({ pid: _pid, ...record }) => record);
			if (method === "getCapabilities") {
				const runtime = z.record(z.string(), z.json()).parse(result);
				const capabilities = backend.capabilities;
				return {
					...runtime,
					platform: capabilities.platform,
					systemPointer,
					methods: [...capabilities.methods],
					appLevelAccessibility: capabilities.appLevelAccessibility,
					keyboard: [...capabilities.keyboard],
					browser: capabilities.browser,
					coordinateSpace: capabilities.coordinateSpace
				};
			}
			if (request.method === "getState" || request.method === "listWindows") return observeNativeWindows(request, result, execution.coordinates);
			return result;
		};
		yield installCuaTools(ctx, config, {
			name: "cua",
			description: "Inspect desktop access, select an application and window, read AX state, capture screenshots or dispatch input. Use appHandle from getApp; verify actions by reading fresh state.",
			parameters: {
				...z.record(z.string(), z.json()).parse(z.toJSONSchema(requestSchema)),
				type: "object"
			},
			output: {
				schema: {},
				render: renderResult
			},
			async execute(args, execution) {
				const request = parseRequest(requestSchema, args);
				const agent = executionAgent(execution);
				execution.signal.throwIfAborted();
				lifetime.signal.throwIfAborted();
				const owner = ownerFor(agent);
				const signal = AbortSignal.any([
					execution.signal,
					lifetime.signal,
					owner.signal
				]);
				signal.throwIfAborted();
				const operation = (async () => {
					const previous = clients.get(agent);
					if (previous?.disposed) try {
						await previous.dispose();
					} catch (error) {
						if (clients.get(agent) === previous) {
							clients.delete(agent);
							access.forget(agent);
							owner.coordinates = new CuaCoordinates();
						}
						throw error;
					}
					signal.throwIfAborted();
					let client = clients.get(agent);
					if ("appHandle" in request.params && !client) throw new NativeError("APP_ACCESS_REQUIRED", "Select the application with getApp before reading or controlling it");
					if (!client || client.disposed && !("appHandle" in request.params)) {
						client = new NativeClient(ctx, native, backend.createChannel, (message) => {
							ctx.logger.debug(message);
						});
						clients.set(agent, client);
						owner.coordinates = new CuaCoordinates();
					}
					const nativeClient = client;
					const route = request.method === "mouseMove" || request.method === "drag" || request.method === "toggleMouse" ? mouseControl?.resolve(agent, "useSystemPointer" in request.params && request.params.useSystemPointer === true) : void 0;
					if (route?.prepare) owner.coordinates.parameters(request);
					const dispatch = async (signal) => {
						const result = await callNative(request, {
							...execution,
							agent,
							signal,
							nativeClient,
							coordinates: owner.coordinates
						}, route?.useSystemPointer);
						signal.throwIfAborted();
						return result;
					};
					return "appHandle" in request.params ? access.run(nativeClient, request.params.appHandle, signal, dispatch, route?.prepare) : dispatch(signal);
				})();
				pending.set(operation, agent);
				try {
					return await operation;
				} catch (error) {
					if (execution.signal.aborted && error instanceof NativeError && error.code === "NATIVE_CANCELLED") throw callerCancelled(error);
					throw error;
				} finally {
					pending.delete(operation);
				}
			}
		}, guidance, programGuidance);
	}, "dsh-cua.runtime");
}
/** Host marker for the optional Client contribution; platform providers install native execution separately. */
function apply() {}
//#endregion
export { ApplicationAccess, CuaAccess, CuaConfig, apply, installCua };
