// Thin async wrapper around @getdial/sdk + a live event hub.
//
//   * owns a single long-lived DialClient
//   * exposes call/SMS/list helpers
//   * runs a background loop that consumes the SDK's live EventsConnection
//     (message.received / call.ended / call.transcribed) and fans each event
//     out to every connected dashboard via an in-memory pub/sub hub.

import { DialClient } from "@getdial/sdk";
import type { DialEvent, EventsConnection, PhoneNumber, Call, Message } from "@getdial/sdk";
import type { Settings } from "./config.ts";

const UI_EVENT_TYPES = new Set(["message.received", "call.ended", "call.transcribed"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Direction = "inbound" | "outbound";
type Listener = (event: unknown) => void;

// In-memory pub/sub with a small replay buffer for late subscribers.
export class EventHub {
  private subscribers = new Set<Listener>();
  private history: unknown[] = [];
  private readonly max = 200;

  publish(event: unknown): void {
    this.history.push(event);
    if (this.history.length > this.max) this.history = this.history.slice(-this.max);
    for (const fn of [...this.subscribers]) {
      try { fn(event); } catch { /* ignore bad subscriber */ }
    }
  }
  subscribe(fn: Listener): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
  recent(): unknown[] {
    return [...this.history];
  }
}

export class DialService {
  private client: DialClient;
  readonly hub = new EventHub();
  numbers: PhoneNumber[] = [];
  defaultNumberId?: string;
  private conn?: EventsConnection;
  private stopped = false;

  constructor(private settings: Settings) {
    this.client = new DialClient({ apiKey: settings.apiKey, baseUrl: settings.baseUrl });
    this.defaultNumberId = settings.numberId;
  }

  // ---- lifecycle ----------------------------------------------------------
  async start(): Promise<void> {
    // Best-effort initial number fetch — a slow/transient API call must not
    // block the dashboard from booting. /api/numbers refreshes on demand.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.refreshNumbers(); break; }
      catch (e) {
        if (attempt === 2) console.error(`[dial] initial listNumbers failed (${(e as Error).message}); will load lazily.`);
        else await sleep(1500);
      }
    }
    void this.eventsLoop(); // fire-and-forget background reconnect loop
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.conn) await this.conn.close().catch(() => {});
  }

  // ---- numbers ------------------------------------------------------------
  async refreshNumbers(): Promise<PhoneNumber[]> {
    this.numbers = await this.client.listNumbers();
    if (!this.defaultNumberId && this.numbers.length) this.defaultNumberId = this.numbers[0].id;
    return this.numbers;
  }

  private resolveFrom(fromNumberId?: string): string {
    const nid = fromNumberId || this.defaultNumberId;
    if (!nid) throw new Error("No sending number available. Provision a number in Dial first.");
    return nid;
  }

  // ---- actions ------------------------------------------------------------
  sendSms(to: string, body: string, fromNumberId?: string): Promise<Message> {
    return this.client.sendMessage({ to, fromNumberId: this.resolveFrom(fromNumberId), body, channel: "sms" });
  }

  placeCall(to: string, outboundInstruction: string, language?: string, fromNumberId?: string): Promise<Call> {
    return this.client.makeCall({ to, fromNumberId: this.resolveFrom(fromNumberId), outboundInstruction, language });
  }

  getCall(id: string): Promise<Call> {
    return this.client.getCall(id);
  }
  listCalls(direction?: Direction): Promise<Call[]> {
    return this.client.listCalls(direction ? { direction } : undefined);
  }
  listMessages(direction?: Direction): Promise<Message[]> {
    return this.client.listMessages(direction ? { direction } : undefined);
  }

  // ---- live events --------------------------------------------------------
  private async eventsLoop(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        this.conn = await this.client.newEventsConnection();
        this.hub.publish({ type: "_status", data: { connected: true } });
        backoff = 1000;
        for await (const ev of this.conn) {
          if (UI_EVENT_TYPES.has((ev as DialEvent).type)) this.hub.publish(ev);
        }
      } catch (e) {
        this.hub.publish({ type: "_status", data: { connected: false, error: (e as Error).message } });
      } finally {
        if (this.conn) await this.conn.close().catch(() => {});
        this.conn = undefined;
      }
      if (this.stopped) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}
