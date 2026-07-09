import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { parseDialAudioMessage, serializeServerAudioMessage, verifyDialSignature } from "@getdial/sdk";

/**
 * Stupid-simple Dial Self-Hosted AUDIO server.
 *
 * In the "audio" variant, Dial pipes the raw call audio to your server over a
 * WebSocket (one per call, at `wss://<this-server>/<call_id>`, signed with
 * `X-Dial-Signature`). This server verifies the signature and echoes the
 * caller's audio straight back — so the caller hears themselves. Press `#` to
 * hang up. It's the smallest possible conformant server; swap the echo for your
 * own speech-to-speech model or STT→LLM→TTS chain.
 *
 * The SDK (`@getdial/sdk`) gives you the protocol types + `parseDialAudioMessage`
 * / `serializeServerAudioMessage`; you own the WebSocket loop
 * (https://docs.getdial.ai/api-reference/self-hosted-audio-protocol).
 *
 * Env: PORT (default 8080), DIAL_SIGNING_SECRET (copy it from the dashboard).
 */

const PORT = Number(process.env.PORT || 8080);
const SIGNING_SECRET = process.env.DIAL_SIGNING_SECRET;
if (!SIGNING_SECRET) throw new Error("DIAL_SIGNING_SECRET is required");

const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("dial self-hosted audio echo\n");
});
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req) => {
  // The Dial call id is the last path segment.
  const callId = (req.url ?? "").split("/").filter(Boolean).pop() ?? "";
  if (!verifyDialSignature(SIGNING_SECRET, String(req.headers["x-dial-signature"] ?? ""), callId)) {
    ws.close(1008, "invalid signature");
    return;
  }

  // ws.send is fire-and-forget; its optional callback is the only place a send
  // failure surfaces (socket closing mid-call, write backpressure). Log it so a
  // dropped frame shows up instead of becoming a silent gap in the audio.
  const send = (frame: Parameters<typeof serializeServerAudioMessage>[0]) => {
    ws.send(serializeServerAudioMessage(frame), (err) => {
      if (err) console.error(`call ${callId}: failed to send ${frame.type}: ${err.message}`);
    });
  };

  ws.on("message", (data: Buffer) => {
    let msg;
    try {
      msg = parseDialAudioMessage(data.toString());
    } catch {
      return; // a malformed frame must not kill the call
    }
    switch (msg.type) {
      case "call_connected":
        console.log(`call ${msg.call_id} (${msg.direction})${msg.reconnect ? " [reconnect]" : ""}`);
        break;
      case "media":
        // Echo: send the same audio back. A real agent would decode
        // Buffer.from(msg.payload, "base64"), run its stack, and re-encode.
        send({ type: "media", payload: msg.payload });
        break;
      case "dtmf":
        if (msg.digit === "#") send({ type: "end_call" });
        break;
      case "ping_pong":
        send({ type: "ping_pong", timestamp: msg.timestamp });
        break;
      case "call_ended":
        console.log(`call ended: ${msg.reason}`);
        break;
    }
  });
});

server.listen(PORT, () => console.log(`audio echo server listening on :${PORT}`));
