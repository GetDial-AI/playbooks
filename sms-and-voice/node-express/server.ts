// Express dashboard for @getdial/sdk — place AI voice calls + send/receive SMS.

import express from "express";
import type { Request, Response } from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSettings } from "./config.ts";
import { DialService } from "./dial-service.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const E164 = /^\+[1-9]\d{1,14}$/;
function validE164(v: string): string {
  const s = (v || "").trim().replace(/[\s-]/g, "");
  if (!E164.test(s)) throw new Error("Phone number must be E.164, e.g. +14155550123");
  return s;
}
function requireText(v: string, label: string): string {
  const s = (v || "").trim();
  if (!s) throw new Error(`${label} cannot be empty`);
  return s;
}

const settings = loadSettings();
const service = new DialService(settings);
await service.start();

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const direction = (req: Request) => {
  const d = req.query.direction;
  return d === "inbound" || d === "outbound" ? d : undefined;
};

app.get("/api/numbers", async (_req: Request, res: Response) => {
  res.json({ numbers: await service.refreshNumbers(), defaultNumberId: service.defaultNumberId });
});

app.get("/api/messages", async (req: Request, res: Response) => {
  res.json({ messages: await service.listMessages(direction(req)) });
});

app.get("/api/calls", async (req: Request, res: Response) => {
  res.json({ calls: await service.listCalls(direction(req)) });
});

app.get("/api/calls/:id", async (req: Request, res: Response) => {
  try {
    res.json({ call: await service.getCall(String(req.params.id)) });
  } catch (e) {
    res.status(404).json({ detail: (e as Error).message });
  }
});

app.post("/api/sms", async (req: Request, res: Response) => {
  try {
    const to = validE164(req.body.to);
    const body = requireText(req.body.body, "Message body");
    const message = await service.sendSms(to, body, req.body.fromNumberId);
    res.json({ ok: true, message });
  } catch (e) {
    res.status(400).json({ detail: (e as Error).message });
  }
});

app.post("/api/call", async (req: Request, res: Response) => {
  try {
    const to = validE164(req.body.to);
    const instruction = requireText(req.body.instruction, "Call instruction");
    const call = await service.placeCall(to, instruction, req.body.language || undefined, req.body.fromNumberId);
    res.json({ ok: true, call });
  } catch (e) {
    res.status(400).json({ detail: (e as Error).message });
  }
});

const server = createServer(app);

// Live inbound events over WebSocket at /ws.
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws: WebSocket) => {
  // replay recent events so a fresh dashboard isn't empty
  for (const ev of service.hub.recent()) {
    ws.send(JSON.stringify({ kind: "history", event: ev }));
  }
  const unsubscribe = service.hub.subscribe((ev) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: "live", event: ev }));
  });
  ws.on("close", unsubscribe);
  ws.on("error", unsubscribe);
});

const PORT = Number(process.env.PORT ?? 8000);
server.listen(PORT, () => console.log(`Dial dashboard running on http://localhost:${PORT}`));

async function shutdown() {
  await service.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
