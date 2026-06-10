const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || data.result || r.statusText);
  return data;
};

let NUMBERS = [];
let lastMsgIds = new Set();

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) +
        " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
const esc = (s) => (s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ── Status + numbers ──────────────────────────────────────────────
async function loadStatus() {
  try {
    const s = await api("/api/status");
    $("#acct-email").textContent = s.number_count
      ? `${s.number_count} number${s.number_count > 1 ? "s" : ""}`
      : "connected";
    $("#acct-number").textContent = s.default_number || "no number";
    $("#conn-dot").classList.add("ok");
  } catch (e) {
    $("#acct-email").textContent = "auth error";
    $("#conn-dot").classList.add("err");
  }
}

async function loadNumbers() {
  const { numbers } = await api("/api/numbers");
  NUMBERS = numbers;
  for (const id of ["#sms-from", "#call-from"]) {
    const sel = $(id);
    sel.innerHTML = numbers
      .map((n) => `<option value="${n.id}">${esc(n.number)}${n.nickname ? " (" + esc(n.nickname) + ")" : ""}</option>`)
      .join("");
  }
}

// ── Inbox ─────────────────────────────────────────────────────────
async function loadMessages() {
  try {
    const { messages } = await api("/api/messages");
    $("#msg-count").textContent = messages.length;
    const box = $("#messages");
    if (!messages.length) {
      box.innerHTML = `<div class="empty">No messages yet. Text your number and it'll show up here.</div>`;
    } else {
      box.innerHTML = messages.map((m) => {
        const inbound = m.direction === "inbound";
        const peer = inbound ? m.from : m.to;
        return `<div class="row ${m.direction}">
          <div class="meta">
            <span class="who">${inbound ? "From" : "To"} ${esc(peer)}
              <span class="pill ${inbound ? "in" : "out"}">${inbound ? "received" : "sent"}</span>
              ${m.channel === "whatsapp" ? '<span class="pill out">whatsapp</span>' : ""}
            </span>
            <span>${fmtTime(m.created_at)}</span>
          </div>
          <div class="body">${esc(m.body)}</div>
        </div>`;
      }).join("");
    }
    // subtle notify on new inbound
    const inboundIds = messages.filter((m) => m.direction === "inbound").map((m) => m.id);
    const fresh = inboundIds.filter((id) => !lastMsgIds.has(id));
    if (lastMsgIds.size && fresh.length) flashTitle(`📩 ${fresh.length} new SMS`);
    lastMsgIds = new Set(inboundIds);
  } catch (e) {
    $("#messages").innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

let flashTimer;
function flashTitle(t) {
  clearTimeout(flashTimer);
  const orig = "Dial Dashboard";
  document.title = t;
  flashTimer = setTimeout(() => (document.title = orig), 4000);
}

// ── Calls ─────────────────────────────────────────────────────────
function statusPill(s) {
  const l = (s || "").toLowerCase();
  if (l.includes("complet") || l.includes("terminat")) return '<span class="pill done">' + esc(s) + "</span>";
  if (l.includes("fail") || l.includes("cancel") || l.includes("error")) return '<span class="pill fail">' + esc(s) + "</span>";
  return '<span class="pill live">' + esc(s) + "</span>";
}

async function loadCalls() {
  try {
    const { calls } = await api("/api/calls");
    $("#call-count").textContent = calls.length;
    const box = $("#calls");
    if (!calls.length) {
      box.innerHTML = `<div class="empty">No calls yet.</div>`;
      return;
    }
    box.innerHTML = calls.map((c) => {
      const inbound = c.direction === "inbound";
      const peer = inbound ? c.from : c.to;
      const dur = c.duration != null ? `${c.duration}s` : "";
      return `<div class="row ${c.direction} clickable" data-id="${c.id}">
        <div class="meta">
          <span class="who">${inbound ? "From" : "To"} ${esc(peer)}
            <span class="pill ${inbound ? "in" : "out"}">${c.direction}</span>
          </span>
          <span>${fmtTime(c.created_at)}</span>
        </div>
        <div class="meta">
          ${statusPill(c.status)}
          <span>${dur}${c.transcript ? " · transcript ›" : ""}</span>
        </div>
      </div>`;
    }).join("");
    box.querySelectorAll(".row").forEach((el) =>
      el.addEventListener("click", () => openCall(el.dataset.id))
    );
  } catch (e) {
    $("#calls").innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

async function openCall(id) {
  const { call } = await api(`/api/calls/${id}`);
  $("#modal-title").textContent = `${call.direction} call · ${call.to}`;
  let html = `<div class="kv"><b>${esc(call.from)}</b> → <b>${esc(call.to)}</b> · ${statusPill(call.status)} ${call.duration != null ? "· " + call.duration + "s" : ""}</div>`;
  if (call.instruction) html += `<div class="kv">Instruction: ${esc(call.instruction)}</div>`;
  if (call.transcript) {
    html += `<div class="transcript">` + call.transcript.split("\n").filter((l) => l.trim()).map((line) => {
      const m = line.match(/^(User|Agent|Assistant):\s*(.*)$/i);
      if (!m) return `<div class="t-line user">${esc(line)}</div>`;
      const role = /agent|assistant/i.test(m[1]) ? "agent" : "user";
      return `<div class="t-line ${role}"><span class="role">${esc(m[1])}</span>${esc(m[2])}</div>`;
    }).join("") + `</div>`;
  } else {
    html += `<div class="empty">No transcript available.</div>`;
  }
  $("#modal-body").innerHTML = html;
  $("#modal").hidden = false;
}

// ── Forms ─────────────────────────────────────────────────────────
$("#sms-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  const res = $("#sms-result");
  const f = new FormData(e.target);
  btn.disabled = true; res.className = "form-result"; res.textContent = "Sending…";
  try {
    await api("/api/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: f.get("to"), body: f.get("body"), from_number_id: f.get("from_number_id") }),
    });
    res.className = "form-result ok"; res.textContent = "✓ Sent";
    e.target.querySelector("textarea").value = "";
    loadMessages();
  } catch (err) {
    res.className = "form-result err"; res.textContent = "✗ " + err.message;
  } finally { btn.disabled = false; }
});

$("#call-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  const res = $("#call-result");
  const f = new FormData(e.target);
  btn.disabled = true; res.className = "form-result"; res.textContent = "Dialing…";
  try {
    const body = { to: f.get("to"), outbound_instruction: f.get("outbound_instruction"), from_number_id: f.get("from_number_id") };
    if (f.get("language")) body.language = f.get("language");
    await api("/api/call", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    res.className = "form-result ok"; res.textContent = "✓ Call started — watch Call History";
    setTimeout(loadCalls, 1500);
  } catch (err) {
    res.className = "form-result err"; res.textContent = "✗ " + err.message;
  } finally { btn.disabled = false; }
});

// ── Wiring ────────────────────────────────────────────────────────
$("#refresh-msgs").addEventListener("click", loadMessages);
$("#refresh-calls").addEventListener("click", loadCalls);
$("#modal-close").addEventListener("click", () => ($("#modal").hidden = true));
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; });

let pollTimer;
function setupPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if ($("#autorefresh").checked) { loadMessages(); loadCalls(); }
  }, 5000);
}

(async function init() {
  await loadStatus();
  await loadNumbers();
  await loadMessages();
  await loadCalls();
  setupPolling();
})();

// ── AI Agent (LangChain) ──────────────────────────────────────────
async function loadAgentInfo() {
  try {
    const i = await api("/api/agent/info");
    $("#agent-provider").textContent = i.provider;
    $("#agent-model").textContent = i.is_fake ? "scripted offline model" : i.model;
  } catch (e) {
    $("#agent-provider").textContent = "error";
  }
}

function renderAgent(res) {
  const box = $("#agent-output");
  let html = "";
  if (res.steps && res.steps.length) {
    html += res.steps.slice().reverse().map((s) => `<div class="agent-step">
        <span class="tool">🔧 ${esc(s.tool)}</span>
        <div class="args">args: ${esc(JSON.stringify(s.args))}</div>
        <pre>${esc(s.result)}</pre>
      </div>`).join("");
  }
  html += `<div class="agent-final">🤖 ${esc(res.output)}</div>`;
  box.innerHTML = html;
}

$("#agent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  const err = $("#agent-error");
  const f = new FormData(e.target);
  btn.disabled = true; err.className = "form-result"; err.textContent = "";
  $("#agent-output").innerHTML = `<div class="agent-final muted">Running agent…</div>`;
  try {
    const res = await api("/api/agent", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: f.get("input"), allow_writes: $("#agent-writes").checked }),
    });
    renderAgent(res);
    loadMessages(); loadCalls(); // reflect any side effects
  } catch (e2) {
    $("#agent-output").innerHTML = "";
    err.className = "form-result err"; err.textContent = "✗ " + e2.message;
  } finally { btn.disabled = false; }
});

loadAgentInfo();
