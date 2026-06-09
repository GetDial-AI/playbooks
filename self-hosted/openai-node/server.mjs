import http from "node:http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import {
  parseDialMessage,
  serializeServerMessage,
  verifyDialSignature,
} from "@getdial/sdk";

/**
 * Reference Self-Hosted server for Dial.
 *
 * Dial opens one WebSocket per call to `wss://<this-server>/<call_id>`, signed
 * with `X-Dial-Signature`. This server verifies the signature, then drives the
 * conversation with the OpenAI SDK — streaming tokens back as `response` frames.
 *
 * The focus is **transcript interrupts**: when a newer `response_required`
 * arrives (the caller spoke again), we abort the in-flight OpenAI stream and
 * answer the new turn, so the agent never talks over the user. See
 * https://docs.getdial.ai/documentation/platform/self-hosted.
 *
 * Env: PORT (default 8080), OPENAI_API_KEY, OPENAI_MODEL (default gpt-4o-mini),
 *      DIAL_SIGNING_SECRET (shown once when you enable Self-Hosted).
 */

const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SIGNING_SECRET = process.env.DIAL_SIGNING_SECRET;
if (!SIGNING_SECRET) throw new Error("DIAL_SIGNING_SECRET is required");

const openai = new OpenAI();

// Used until `call_started` arrives with Dial's per-call instruction (the
// system_prompt — your outbound/inbound instruction plus Dial's general context
// like the current time and the voice's gender).
const DEFAULT_PROMPT =
  "You are a friendly, concise voice agent on a phone call. Keep replies short and natural.";

// Appended to the active system prompt so the model knows it can hang up.
const END_CALL_HINT =
  "When the conversation is finished or the caller wants to hang up, call the end_call tool " +
  "with a brief, natural farewell instead of replying with text.";

// OpenAI function tools live *inside* this server. The Dial protocol abstracts
// tools away — there's no tool channel on the wire — so when the model calls
// end_call we simply send a `response` with `end_call: true`, which tells Dial
// to hang up after the farewell is spoken.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "end_call",
      description:
        "End the phone call. Use when the task is complete, the caller says goodbye, or the conversation has naturally concluded.",
      parameters: {
        type: "object",
        properties: {
          farewell: { type: "string", description: "A short, natural goodbye to say before hanging up." },
        },
        required: ["farewell"],
      },
    },
  },
];

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const callId = url.pathname.split("/").filter(Boolean).pop();
  const signature = req.headers["x-dial-signature"];

  // Authorize at request time: confirm the connection is genuinely from Dial.
  if (!callId || !signature || !verifyDialSignature(SIGNING_SECRET, String(signature), callId)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleCall(ws, callId));
});

/** Map the Dial transcript to OpenAI chat messages under the given system prompt. */
function toMessages(instruction, transcript) {
  return [
    { role: "system", content: `${instruction}\n\n${END_CALL_HINT}` },
    ...transcript.map((t) => ({ role: t.role === "agent" ? "assistant" : "user", content: t.content })),
  ];
}

function handleCall(ws, callId) {
  console.log(`[${callId}] connected`);
  let inFlight = null; // AbortController for the current OpenAI stream
  let systemInstruction = DEFAULT_PROMPT; // replaced by call_started.instruction

  const cancelInFlight = () => {
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
    }
  };

  async function answer(responseId, transcript) {
    // Interrupt focus: a new turn supersedes any response still streaming.
    cancelInFlight();
    const controller = new AbortController();
    inFlight = controller;
    try {
      const stream = await openai.chat.completions.create(
        { model: MODEL, messages: toMessages(systemInstruction, transcript), stream: true, tools: TOOLS, tool_choice: "auto" },
        { signal: controller.signal },
      );
      let toolName = "";
      let toolArgs = "";
      for await (const chunk of stream) {
        if (controller.signal.aborted) return; // superseded by a newer turn
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          ws.send(serializeServerMessage({ type: "response", response_id: responseId, content: delta.content, content_complete: false }));
        }
        const call = delta?.tool_calls?.[0];
        if (call?.function?.name) toolName = call.function.name;
        if (call?.function?.arguments) toolArgs += call.function.arguments;
      }
      if (controller.signal.aborted) return;

      if (toolName === "end_call") {
        // Map the model's tool call to the protocol's end_call: speak the
        // farewell, then Dial hangs up.
        let farewell = "Thanks for calling — goodbye!";
        try {
          const args = JSON.parse(toolArgs || "{}");
          if (typeof args.farewell === "string" && args.farewell.trim()) farewell = args.farewell;
        } catch { /* keep the default farewell */ }
        ws.send(serializeServerMessage({ type: "response", response_id: responseId, content: farewell, content_complete: true, end_call: true }));
      } else {
        ws.send(serializeServerMessage({ type: "response", response_id: responseId, content: "", content_complete: true }));
      }
    } catch (err) {
      if (controller.signal.aborted) return; // expected on interrupt
      console.error(`[${callId}] openai error`, err);
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = parseDialMessage(raw.toString());
    } catch {
      return; // ignore frames we don't recognize
    }
    // Print every message arriving from Dial (already debounced/deduped by Dial).
    console.log(`[${callId}] <- ${msg.type}`, JSON.stringify(msg));
    switch (msg.type) {
      case "call_started":
        // Use Dial's per-call instruction (system_prompt + general context) as
        // the system prompt; falls back to DEFAULT_PROMPT when absent.
        if (msg.instruction) systemInstruction = msg.instruction;
        break;
      case "response_required":
      case "reminder_required":
        void answer(msg.response_id, msg.transcript);
        break;
    }
  });

  ws.on("close", () => {
    cancelInFlight();
    console.log(`[${callId}] closed`);
  });
}

server.listen(PORT, () => console.log(`Self-Hosted playbook server listening on :${PORT}`));
