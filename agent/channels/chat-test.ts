// Test channel: chat endpoints for the analyst. Streams replies and answers approvals.
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { defineChannel, POST } from "eve/channels";
import { parseInputResponses } from "eve/client";
import { httpBasic, localDev, routeAuth } from "eve/channels/auth";

// Events that mean the reply is finished, or that the analyst is waiting on a person.
const TERMINAL = new Set(["session.waiting", "session.completed", "session.failed", "turn.waiting"]);
// Accepts the chat app's username and password when they are set, plus local development.
function analystAuth() {
    const entries = [];
    if (process.env.ANALYST_USER && process.env.ANALYST_PASSWORD) {
        entries.push(httpBasic({ username: process.env.ANALYST_USER, password: process.env.ANALYST_PASSWORD }));
    }
    entries.push(localDev());
    return entries;
}
const textId = "answer";

type EveEvent = { type: string; data?: any };

// Turns Eve events into AI SDK chunks. Events are ignored until `begin` returns true.
function toUIStream(eveStream: ReadableStream<unknown>, begin: (event: EveEvent) => boolean) {
    return createUIMessageStream({
        onError: (error) => {
            console.error("chat-test failed:", error);
            return "Analyst error. See the dev window.";
        },
        execute: async ({ writer }) => {
            let textOpen = false;
            let started = false;
            let finished = false;
            const reader = eveStream.getReader();

            writer.write({ type: "start" });
            try {
                while (!finished) {
                    const chunk = await reader.read();
                    if (chunk.done) {
                        break;
                    }
                    const event = chunk.value as EveEvent;

                    if (!started) {
                        if (!begin(event)) {
                            continue;
                        }
                        started = true;
                    }

                    if (event.type === "action.result") {
                        const result = event.data?.result;
                        if (result?.toolName === "run_sql" && result.output?.columns) {
                            const output = result.output as { columns: { name: string }[]; rows: unknown[][] };
                            writer.write({
                                type: "data-spec",
                                data: {
                                    root: "card",
                                    elements: {
                                        card: { type: "Card", props: { title: "Query result" }, children: ["table"] },
                                        table: {
                                            type: "Table",
                                            props: {
                                                columns: output.columns.map((c) => c.name),
                                                rows: output.rows.map((r) => r.map((cell) => String(cell))),
                                            },
                                            children: [],
                                        },
                                    },
                                },
                            } as never);
                        }
                        // Sends WooCommerce report results to the chat app as raw data. The console.log is temporary, to see the output shape. Remove it later.
                        if (result?.toolName?.startsWith("woocommerce__") && result.output) {
                            console.log("woo output:", JSON.stringify(result.output));
                            writer.write({
                                type: "data-report",
                                data: { tool: result.toolName, output: result.output },
                            } as never);
                        }
                    }

                    if (event.type === "input.requested") {
                        for (const request of event.data?.requests ?? []) {
                            writer.write({
                                type: "data-approval",
                                data: {
                                    requestId: request.requestId,
                                    prompt: request.prompt,
                                    purpose: request.action?.input?.purpose ?? "",
                                    options: request.options,
                                },
                            } as never);
                        }
                    }

                    if (event.type === "message.appended" && event.data?.messageDelta) {
                        if (!textOpen) {
                            writer.write({ type: "text-start", id: textId });
                            textOpen = true;
                        }
                        writer.write({ type: "text-delta", id: textId, delta: event.data.messageDelta });
                    }

                    if (TERMINAL.has(event.type)) {
                        finished = true;
                    }
                }
            } finally {
                await reader.cancel().catch(() => { });
            }

            if (textOpen) {
                writer.write({ type: "text-end", id: textId });
            }
            writer.write({ type: "finish" });
        },
    });
}

export default defineChannel({
    routes: [
        // Sends a question and streams the reply.
        POST("/chat-test/:threadId", async (request, { attachSession, from, params }) => {
            // Local development only for now. Replaced with real auth before sharing.
            const auth = await routeAuth(request, analystAuth());
            if (auth instanceof Response) {
                return auth;
            }

            const body = (await request.json()) as { message?: unknown };
            const message = typeof body.message === "string" ? body.message.trim() : "";
            if (!message) {
                return Response.json({ ok: false, error: "message is required" }, { status: 400 });
            }

            const sent = await from(params.threadId).send(message, { auth });
            const eveStream = await attachSession(sent.id).getEventStream();

            return createUIMessageStreamResponse({
                stream: toUIStream(eveStream, (event) => event.type === "message.received" && JSON.stringify(event).includes(message)),
            });
        }),

        // Answers an approval, then streams the resumed reply.
        POST("/chat-test/:threadId/answer", async (request, { attachSession, from, params, resolveSession }) => {
            const auth = await routeAuth(request, analystAuth());
            if (auth instanceof Response) {
                return auth;
            }

            const body = (await request.json()) as { requestId?: string; optionId?: string };
            if (!body.requestId || !body.optionId) {
                return Response.json({ ok: false, error: "requestId and optionId are required" }, { status: 400 });
            }

            await from(params.threadId).respond(
                parseInputResponses([{ requestId: body.requestId, optionId: body.optionId }]),
                { auth },
            );

            const current = await resolveSession(params.threadId);
            if (!current) {
                return Response.json({ ok: false, error: "no session for this thread" }, { status: 404 });
            }

            // Starts the stream at the approval with this requestId, so older results aren't replayed.
            const requestId = body.requestId;
            const eveStream = await attachSession(current.id).getEventStream({ startIndex: -60 });
            return createUIMessageStreamResponse({
                stream: toUIStream(
                    eveStream,
                    (event) => event.type === "approval.settled" && JSON.stringify(event.data ?? {}).includes(requestId),
                ),
            });
        }),
    ],
});