// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

const $ = (id) => document.getElementById(id);

function log(line) {
  const el = $("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}

async function ensureAuth(res) {
  if (res.status !== 401) return true;
  const password = window.prompt("Operator password:");
  if (!password) return false;
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) {
    log("login failed");
    return false;
  }
  return true;
}

async function refresh() {
  let res = await fetch("/api/state");
  if (res.status === 401) {
    if (!(await ensureAuth(res))) return;
    res = await fetch("/api/state");
  }
  const s = await res.json();
  const status = $("status");
  status.textContent = s.running ? "running" : "stopped";
  status.classList.toggle("running", s.running);

  const persona = $("persona");
  if (persona.options.length === 0) {
    for (const p of s.personas) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      opt.dataset.desc = p.description;
      persona.appendChild(opt);
    }
    persona.addEventListener("change", () => {
      $("persona-desc").textContent = persona.selectedOptions[0]?.dataset.desc ?? "";
    });
    persona.dispatchEvent(new Event("change"));
  }

  const eager = $("eagerness");
  if (eager.childElementCount === 0) {
    for (const level of ["reserved", "balanced", "eager"]) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "eagerness";
      radio.value = level;
      radio.checked = level === s.eagerness;
      radio.addEventListener("change", async () => {
        // Success is logged via the eagerness SSE echo (single source of truth).
        await fetch("/api/eagerness", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ eagerness: level }),
        });
      });
      label.append(radio, " " + level);
      eager.appendChild(label);
    }
  }

  const pvp = $("pvp");
  if (!pvp.dataset.wired) {
    pvp.dataset.wired = "1";
    pvp.addEventListener("change", async () => {
      // Success is reflected via the pvp SSE echo (single source of truth).
      await fetch("/api/pvp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: pvp.checked }),
      });
    });
  }

  renderOperator(s.operator);
  renderRoster(s.roster ?? []);
  renderIntake(s.intake);
  applyEagerness(s.eagerness);
  applyPvp(s.pvpEnabled);
  const dmAssign = (s.voiceAssignments ?? []).find((v) => v.subjectKind === "dm");
  if (dmAssign && dmAssign.personaId) applyDmVoice(dmAssign.personaId);
}

// Reflect a control change from any surface (console or slash) without a refresh.
function applyEagerness(level) {
  if (!level) return;
  const radio = document.querySelector(`input[name="eagerness"][value="${level}"]`);
  if (radio) radio.checked = true;
}

function applyPvp(enabled) {
  const box = $("pvp");
  if (box) box.checked = enabled === true;
}

function applyDmVoice(personaId) {
  if (!personaId) return;
  const persona = $("persona");
  if (persona && persona.value !== personaId) {
    persona.value = personaId;
    persona.dispatchEvent(new Event("change"));
  }
}

function renderOperator(op) {
  const el = $("operator-current");
  if (!el) return;
  if (op && op.operatorUserId) {
    el.textContent = (op.displayName || op.operatorUserId) + (op.displayName ? "" : " (id)");
  } else {
    el.textContent = "(not set)";
  }
}

async function setOperator(payload, note) {
  const r = await fetch("/api/operator", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((x) => x.json());
  if (r.error) log(`operator: ${r.error}`);
  else if (r.pending) log("operator: username saved — will resolve when a session starts");
  else log(note || "operator updated");
}

function renderIntake(intake) {
  const readyEl = $("intake-ready");
  const list = $("intake-findings");
  if (!readyEl || !list) return;
  const ready = !intake || intake.ready !== false;
  readyEl.textContent = ready
    ? "Ready: yes (announce-ready unblocked)"
    : "Ready: blocked on unresolved critical findings";
  const findings = (intake && intake.findings) || [];
  list.innerHTML = "";
  if (!findings.length) {
    list.textContent = "(no intake findings)";
    return;
  }
  for (const f of findings) {
    const wrap = document.createElement("div");
    wrap.style.margin = "0.4rem 0";
    const title = document.createElement("div");
    title.textContent = `[${f.kind}] ${f.summary}` + (f.dmOnly ? "  (DM-only)" : "");
    wrap.appendChild(title);
    if (f.detail) {
      const detail = document.createElement("div");
      detail.style.color = "#555";
      detail.textContent = f.detail;
      wrap.appendChild(detail);
    }
    if (f.options && f.options.length) {
      const row = document.createElement("div");
      row.className = "row";
      for (const opt of f.options) {
        const btn = document.createElement("button");
        btn.textContent = opt.label;
        btn.style.fontSize = "0.75rem";
        btn.addEventListener("click", async () => {
          const r = await fetch("/api/intake/resolve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ findingId: f.id, optionId: opt.id }),
          }).then((x) => x.json());
          log(`intake resolve ${f.id} → ${opt.id} (${r.status || "ok"})`);
        });
        row.appendChild(btn);
      }
      wrap.appendChild(row);
    }
    list.appendChild(wrap);
  }
}

function renderRoster(members) {
  const el = $("operator-roster");
  if (!el) return;
  el.innerHTML = "";
  if (!members.length) {
    el.textContent = "(no one in the voice channel yet)";
    return;
  }
  for (const m of members) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.margin = "0.2rem 0";
    const name = document.createElement("span");
    name.textContent = (m.displayName || m.id) + (m.isOperator ? "  ⭐ operator" : "");
    const btn = document.createElement("button");
    btn.textContent = "This is me";
    btn.style.fontSize = "0.75rem";
    btn.style.padding = "0.1rem 0.5rem";
    btn.disabled = !!m.isOperator;
    btn.addEventListener("click", () =>
      setOperator({ discordId: m.id }, `operator → ${m.displayName || m.id}`),
    );
    row.append(name, btn);
    el.appendChild(row);
  }
}

$("start").addEventListener("click", async () => {
  log("starting…");
  await fetch("/api/session/start", { method: "POST" });
});
$("stop").addEventListener("click", async () => {
  log("stopping…");
  await fetch("/api/session/stop", { method: "POST" });
  refresh();
});
$("apply-voice").addEventListener("click", async () => {
  const personaId = $("persona").value;
  // Success is logged via the dmVoice SSE echo; only surface errors here.
  const r = await fetch("/api/dm-voice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId }),
  }).then((x) => x.json());
  if (r.error) log(`DM voice error: ${r.error}`);
});

$("operator-save").addEventListener("click", () => {
  const username = $("operator-username").value.trim();
  if (username) setOperator({ username }, `operator → @${username}`);
});
$("operator-clear").addEventListener("click", () =>
  setOperator({ clear: true }, "operator cleared"),
);

// Event "kind" strings below mirror the AppEvent union in
// app/src/session_manager.ts — that union is the source of truth (this is
// unbundled static JS, so it can't import it; keep the two in sync by hand).
const events = new EventSource("/api/events");
events.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.kind === "decision") log(`· decide respond=${ev.respond} (${ev.reason}) ← "${ev.heard}"`);
  else if (ev.kind === "turn")
    log(`🗣 DM: ${ev.narration}` + (ev.tools.length ? ` [tools: ${ev.tools.join(", ")}]` : ""));
  else if (ev.kind === "status") {
    log(`status: ${ev.status}`);
    refresh();
  } else if (ev.kind === "consent_prompt") log(`(consent prompt sent to ${ev.speaker})`);
  else if (ev.kind === "roster") renderRoster(ev.members);
  else if (ev.kind === "operator") renderOperator(ev);
  else if (ev.kind === "eagerness") {
    applyEagerness(ev.eagerness);
    log(`eagerness → ${ev.eagerness}`);
  } else if (ev.kind === "dmVoice") {
    applyDmVoice(ev.personaId);
    log(`DM voice → ${ev.personaId || ev.voiceId}`);
  } else if (ev.kind === "pvp") {
    applyPvp(ev.enabled);
    log(`PvP → ${ev.enabled ? "on" : "off"}`);
  } else if (ev.kind === "intake") {
    renderIntake(ev);
    log(`intake ready=${ev.ready} findings=${(ev.findings || []).length}`);
  }
};

refresh();
