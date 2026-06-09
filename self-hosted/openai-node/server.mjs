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

const SYSTEM_PROMPT =
  "You are a friendly, concise voice agent on a phone call. Keep replies short and natural.";

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

/** Map the Dial transcript to OpenAI chat messages. */
function toMessages(transcript) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...transcript.map((t) => ({ role: t.role === "agent" ? "assistant" : "user", content: t.content })),
  ];
}

function handleCall(ws, callId) {
  console.log(`[${callId}] connected`);
  let inFlight = null; // AbortController for the current OpenAI stream

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
        { model: MODEL, messages: toMessages(transcript), stream: true },
        { signal: controller.signal },
      );
      for await (const chunk of stream) {
        if (controller.signal.aborted) return; // superseded by a newer turn
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          ws.send(serializeServerMessage({ type: "response", response_id: responseId, content: delta, content_complete: false }));
        }
      }
      if (!controller.signal.aborted) {
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
    switch (msg.type) {
      case "call_started":
        console.log(`[${callId}] ${msg.direction} call ${msg.from} -> ${msg.to}`);
        break;
      case "response_required":
      case "reminder_required":
        void answer(msg.response_id, msg.transcript);
        break;
      case "transcript_update":
        // Live transcript; nothing to do until Dial asks for a turn.
        break;
    }
  });

  ws.on("close", () => {
    cancelInFlight();
    console.log(`[${callId}] closed`);
  });
}

server.listen(PORT, () => console.log(`Self-Hosted playbook server listening on :${PORT}`));
