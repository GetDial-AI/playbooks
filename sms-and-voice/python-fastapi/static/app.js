"use strict";

const $ = (sel) => document.querySelector(sel);
const feed = $("#feed");
const callsEl = $("#calls");

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

// `status` may be a rich object {state, terminationType, label} (Call objects)
// or a plain string (live call.ended events). Normalise either way.
function statusObj(s) {
  return s && typeof s === "object" ? s : { state: s, label: s, terminationType: s };
}
function statusLabel(s) {
  s = statusObj(s);
  return s.label || s.terminationType || s.state || "unknown";
}
function statusClass(s) {
  s = statusObj(s);
  const t = String(s.terminationType || s.state || "").toLowerCase();
  if (["failed", "canceled", "cancelled", "no_answer", "busy"].includes(t)) return "failed";
  if (t === "completed") return "completed";
  return "queued";
}
function isTerminal(s) {
  s = statusObj(s);
  if (s.state === "Terminated") return true;
  return ["completed", "failed", "canceled", "cancelled", "no_answer", "busy"]
    .includes(String(s.terminationType || "").toLowerCase());
}

// ---------------- forms -----------------------------------------------------
async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

$("#smsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const status = $("#smsStatus");
  const btn = f.querySelector("button");
  status.className = "formstatus info"; status.textContent = "Sending…";
  btn.disabled = true;
  try {
    const data = await postJSON("/api/sms", {
      to: f.to.value, body: f.body.value,
    });
    status.className = "formstatus ok";
    status.textContent = `✓ Sent (status: ${data.message?.status || "ok"})`;
    f.body.value = "";
  } catch (err) {
    status.className = "formstatus err";
    status.textContent = "✕ " + err.message;
  } finally {
    btn.disabled = false;
  }
});

$("#callForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const status = $("#callStatus");
  const btn = f.querySelector("button");
  status.className = "formstatus info"; status.textContent = "Placing call…";
  btn.disabled = true;
  try {
    const data = await postJSON("/api/call", {
      to: f.to.value,
      instruction: f.instruction.value,
      language: f.language.value || null,
    });
    const call = data.call;
    status.className = "formstatus ok";
    status.textContent = `✓ Call queued (status: ${statusLabel(call.status)}). Tracking…`;
    trackCall(call.id, status);
    loadCalls();
  } catch (err) {
    status.className = "formstatus err";
    status.textContent = "✕ " + err.message;
  } finally {
    btn.disabled = false;
  }
});

// Poll a freshly-placed call until it reaches a terminal state.
async function trackCall(id, statusEl) {
  let tries = 0;
  const tick = async () => {
    tries++;
    try {
      const { call } = await (await fetch(`/api/calls/${id}`)).json();
      if (statusEl) {
        statusEl.className = "formstatus info";
        statusEl.textContent = `Call ${statusLabel(call.status)}${call.duration ? ` · ${call.duration}s` : ""}`;
      }
      if (isTerminal(call.status)) {
        if (statusEl) {
          statusEl.className = "formstatus ok";
          statusEl.innerHTML = `✓ Call ${esc(statusLabel(call.status))}` +
            (call.transcript ? ` · <a class="linklike" data-call="${esc(id)}">view transcript</a>` : "");
        }
        loadCalls();
        return;
      }
    } catch (_) { /* keep trying */ }
    if (tries < 90) setTimeout(tick, 4000);
  };
  setTimeout(tick, 3000);
}

// ---------------- websocket live feed --------------------------------------
let firstReal = true;
function renderEvent(ev, prepend = true) {
  if (!ev || !ev.type || ev.type.startsWith("_")) return;
  if (firstReal) { feed.innerHTML = ""; firstReal = false; }

  const d = ev.data || {};
  const el = document.createElement("div");
  let cls = "event", title = ev.type, inner = "";

  if (ev.type === "message.received") {
    cls += " sms";
    title = "Inbound SMS";
    inner = `<div class="ev-from">${esc(d.from)} → ${esc(d.to)}</div>
             <div class="ev-body">${esc(d.body)}</div>
             <div class="ev-meta">channel: ${esc(d.channel || "sms")}</div>`;
  } else if (ev.type === "call.ended") {
    cls += " call";
    title = "Call ended";
    inner = `<div class="ev-from">${esc(d.from)} → ${esc(d.to)} <span class="dir">(${esc(d.direction)})</span></div>
             <div class="ev-meta">status: ${esc(d.status)}${d.durationSeconds != null ? ` · ${d.durationSeconds}s` : ""}` +
            (d.callId ? ` · <a class="linklike" data-call="${esc(d.callId)}">details</a>` : "") + `</div>`;
  } else if (ev.type === "call.transcribed") {
    cls += " call";
    title = "Transcript ready";
    inner = `<div class="ev-meta">${d.callId ? `<a class="linklike" data-call="${esc(d.callId)}">view transcript</a>` : ""}</div>`;
  } else {
    inner = `<div class="ev-body">${esc(JSON.stringify(d))}</div>`;
  }

  el.className = cls;
  el.innerHTML = `<div class="ev-top"><span class="ev-type">${esc(title)}</span><span>${fmtTime(ev.createdAt)}</span></div>${inner}`;
  if (prepend) feed.prepend(el); else feed.appendChild(el);
}

function setWs(state) {
  const dot = $("#wsdot"), pill = $("#wsstatus");
  if (state === "live") { dot.className = "dot on"; pill.className = "pill live"; pill.textContent = "live"; }
  else if (state === "down") { dot.className = "dot off"; pill.className = "pill down"; pill.textContent = "reconnecting…"; }
  else { dot.className = "dot off"; pill.className = "pill"; pill.textContent = "connecting…"; }
}

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setWs("live");
  ws.onclose = () => { setWs("down"); setTimeout(connectWS, 2500); };
  ws.onerror = () => setWs("down");
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    const ev = msg.event;
    if (ev && ev.type === "_status") {
      setWs(ev.data && ev.data.connected ? "live" : "down");
      return;
    }
    // history replays oldest→newest: append; live: prepend
    renderEvent(ev, msg.kind === "live");
  };
}

// ---------------- call history ---------------------------------------------
async function loadCalls() {
  try {
    const { calls } = await (await fetch("/api/calls")).json();
    if (!calls.length) { callsEl.innerHTML = `<p class="empty">No calls yet.</p>`; return; }
    callsEl.innerHTML = "";
    calls.forEach((c) => {
      const row = document.createElement("div");
      row.className = "callrow";
      row.dataset.call = c.id;
      const other = c.direction === "outbound" ? c.to : c.from;
      row.innerHTML = `
        <span class="dir">${esc(c.direction)}</span>
        <span><strong>${esc(other)}</strong><br><span class="ev-meta">${fmtTime(c.created_at)}</span></span>
        <span class="badge ${statusClass(c.status)}">${esc(statusLabel(c.status))}</span>
        <span>${c.duration ? esc(c.duration) + "s" : "—"}</span>`;
      callsEl.appendChild(row);
    });
  } catch (err) {
    callsEl.innerHTML = `<p class="empty">Failed to load calls: ${esc(err.message)}</p>`;
  }
}

async function loadHistory() {
  // Seed the inbox with stored inbound messages (events only stream while running).
  try {
    const { messages } = await (await fetch("/api/messages?direction=inbound")).json();
    if (messages && messages.length) {
      if (firstReal) { feed.innerHTML = ""; firstReal = false; }
      messages.forEach((m) =>
        renderEvent({
          type: "message.received",
          createdAt: m.created_at,
          data: { from: m.from, to: m.to, body: m.body, channel: m.channel },
        }, false)
      );
    }
  } catch (_) { /* ignore */ }
}

// ---------------- call detail modal ----------------------------------------
async function showCall(id) {
  const modal = $("#modal"), body = $("#modalBody");
  body.innerHTML = "<p class='empty'>Loading…</p>";
  modal.classList.remove("hidden");
  try {
    const { call } = await (await fetch(`/api/calls/${id}`)).json();
    body.innerHTML = `
      <h3>Call detail</h3>
      <div class="kv">
        <span>Direction</span><span>${esc(call.direction)}</span>
        <span>From</span><span>${esc(call.from)}</span>
        <span>To</span><span>${esc(call.to)}</span>
        <span>Status</span><span>${esc(statusLabel(call.status))}</span>
        <span>Duration</span><span>${call.duration ? esc(call.duration) + "s" : "—"}</span>
        <span>Created</span><span>${fmtTime(call.created_at)}</span>
      </div>
      ${call.instruction ? `<h3>Agent instruction</h3><div class="transcript">${esc(call.instruction)}</div>` : ""}
      <h3>Transcript</h3>
      <div class="transcript">${call.transcript ? esc(call.transcript) : "No transcript available."}</div>`;
  } catch (err) {
    body.innerHTML = `<p class="empty">Failed to load: ${esc(err.message)}</p>`;
  }
}

$("#modalClose").addEventListener("click", () => $("#modal").classList.add("hidden"));
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") e.target.classList.add("hidden"); });

// Delegate clicks for any [data-call] (rows, transcript links, detail links)
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-call]");
  if (t) { e.preventDefault(); showCall(t.dataset.call); }
});

$("#refreshCalls").addEventListener("click", loadCalls);
$("#refreshInbox").addEventListener("click", () => { firstReal = true; feed.innerHTML = ""; loadHistory(); });

// ---------------- boot ------------------------------------------------------
setWs("connecting");
connectWS();
loadHistory();
loadCalls();
