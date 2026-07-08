import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { AudioPipeSession, verifyDialSignature, type DuplexSocket } from "@getdial/sdk";

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
 * Speaks the Self-hosted audio protocol via `@getdial/sdk`'s AudioPipeSession
 * (https://docs.getdial.ai/api-reference/self-hosted-audio-protocol).
 *
 * Env: PORT (default 8080), DIAL_SIGNING_SECRET (shown when you enable
 * Self-Hosted; copy it from the dashboard).
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
  const signature = req.headers["x-dial-signature"];
  if (!verifyDialSignature(SIGNING_SECRET, String(signature ?? ""), callId)) {
    ws.close(1008, "invalid signature");
    return;
  }

  const socket: DuplexSocket = {
    send: (data) => ws.send(data),
    onMessage: (cb) => ws.on("message", (d: Buffer) => cb(d.toString())),
    onClose: (cb) => ws.on("close", cb),
    close: () => ws.close(),
  };

  const session = new AudioPipeSession(socket, {
    onCallConnected: (info) =>
      console.log(`call ${info.call_id} (${info.direction})${info.reconnect ? " [reconnect]" : ""}`),
    onMedia: (audio) => session.sendMedia(audio), // echo the caller back to themselves
    onDtmf: (digit) => {
      if (digit === "#") session.endCall();
    },
    onCallEnded: (reason) => console.log(`call ended: ${reason}`),
  });
});

server.listen(PORT, () => console.log(`audio echo server listening on :${PORT}`));
