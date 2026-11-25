import OBR from "https://esm.sh/@owlbear-rodeo/sdk";

const META_KEY = "com.custom.clash-timeline/state";
const SFX_CHANNEL = "com.custom.clash-timeline/sfx";

const ACTIONS = [
  { id: "LIGHT", name: "⚡ Light Atk", type: "ATTACK", startup: 3, power: 4, desc: "F:3 | Pow:4" },
  { id: "HEAVY", name: "💥 Heavy Atk", type: "ATTACK", startup: 7, power: 9, desc: "F:7 | Pow:9" },
  { id: "GUARD", name: "🛡️ Guard",     type: "GUARD",  startup: 2, power: 0, desc: "F:2 | กันได้ +2 FA" },
  { id: "EVADE", name: "💨 Evade",     type: "EVADE",  startup: 3, power: 0, desc: "F:3 | หลบได้ +1 FA" }
];

// สถานะเริ่มต้นของระบบ
let isOBR = false;
let myId = "local-gm";
let myRole = "GM";
let selectedActionId = "LIGHT";

let state = {
  round: 1,
  phase: "PLANNING", // 'PLANNING' | 'REVEAL'
  fighters: {},      // { [id]: { id, name, speedMod, statMod, frameAdv, isNpc } }
  locked: {},        // { [id]: { actorId, targetId, actionId } }
  resolution: null   // ผลลัพธ์หลังกด Resolve
};

// ---------------- ระบบเสียง SFX (ไม่ต้องใช้ไฟล์ MP3) ----------------
function playSfx(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === "CLASH") {
      // เสียงเหล็กปะทะหนักๆ + เขย่าจอ
      document.body.classList.remove("shake");
      void document.body.offsetWidth;
      document.body.classList.add("shake");

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(180, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(45, ctx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } else {
      // เสียงติ๊งเบาๆ ตอน Lock-in หรือเปิดไพ่
      osc.type = "triangle";
      osc.frequency.setValueAtTime(520, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    }
  } catch (e) { /* เผื่อเบราว์เซอร์บล็อกเสียงก่อนคลิก */ }
}

// ---------------- ซิงก์ข้อมูลกับ Owlbear Rodeo ----------------
async function saveState(newState) {
  state = newState;
  if (isOBR) {
    await OBR.room.setMetadata({ [META_KEY]: state });
  } else {
    render();
  }
}

function broadcastSfx(type) {
  playSfx(type);
  if (isOBR) {
    OBR.broadcast.sendMessage(SFX_CHANNEL, { type });
  }
}

// ---------------- สูตรคำนวณ Core Mechanics ----------------
function calcEffectiveFrame(fighter, action) {
  return Math.max(1, action.startup - (fighter.speedMod || 0) - (fighter.frameAdv || 0));
}

function rollD10() {
  return Math.floor(Math.random() * 10) + 1;
}

function resolveTurn() {
  const entries = Object.values(state.locked).map(lock => {
    const fighter = state.fighters[lock.actorId];
    const action = ACTIONS.find(a => a.id === lock.actionId);
    const frame = calcEffectiveFrame(fighter, action);
    return { ...lock, fighter, action, frame, resolved: false, interrupted: false };
  });

  // เรียงลำดับจากเฟรมน้อยไปมาก
  entries.sort((a, b) => a.frame - b.frame);

  const clashes = [];
  const logs = [];
  const nextFA = {}; // เก็บค่า FA สำหรับรอบถัดไป
  Object.keys(state.fighters).forEach(id => { nextFA[id] = 0; });

  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    if (a.resolved) continue;

    // เช็กว่าเป้าหมาย (b) เล็งกลับมาที่ a เหมือนกันหรือไม่
    const b = entries.find(e => e.actorId === a.targetId && e.targetId === a.actorId && !e.resolved);

    if (b) {
      const df = Math.abs(a.frame - b.frame);

      // กรณีที่ 1: โจมตีชนโจมตี
      if (a.action.type === "ATTACK" && b.action.type === "ATTACK") {
        if (df <= 1) {
          // CLASH!
          const rollA = rollD10();
          const rollB = rollD10();
          const scoreA = a.action.power + (a.fighter.statMod || 0) + rollA;
          const scoreB = b.action.power + (b.fighter.statMod || 0) + rollB;

          let resultText = "เสมอ! ดีดตัวออกจากกัน (FA รีเซ็ตเป็น 0)";
          if (scoreA > scoreB) {
            resultText = `🏆 ${a.fighter.name} ชนะ Clash! ตีเต็มดาเมจ (+2 FA) | ${b.fighter.name} ชะงัก (-2 FA)`;
            nextFA[a.actorId] = 2;
            nextFA[b.actorId] = -2;
          } else if (scoreB > scoreA) {
            resultText = `🏆 ${b.fighter.name} ชนะ Clash! ตีเต็มดาเมจ (+2 FA) | ${a.fighter.name} ชะงัก (-2 FA)`;
            nextFA[b.actorId] = 2;
            nextFA[a.actorId] = -2;
          }

          clashes.push({
            aName: a.fighter.name, aAct: a.action.name, aDetail: `${a.action.power}+${a.fighter.statMod}+🎲${rollA}`, scoreA,
            bName: b.fighter.name, bAct: b.action.name, bDetail: `${b.action.power}+${b.fighter.statMod}+🎲${rollB}`, scoreB,
            resultText
          });
          logs.push({ type: "clash", text: `F${a.frame}: 🔥 CLASH! ${a.fighter.name} ปะทะ ${b.fighter.name} -> ${resultText}` });
        } else {
          // COUNTER / INTERRUPT (เพราะเรียงลำดับแล้ว a จะเฟรมน้อยกว่า b เสมอ)
          b.interrupted = true;
          nextFA[a.actorId] = 1;
          nextFA[b.actorId] = -2;
          logs.push({
            type: "counter",
            text: `F${a.frame}: ⚡ COUNTER! ${a.fighter.name} ออกท่าไวกว่า ขัดจังหวะ ${b.fighter.name} (F${b.frame}) เต็มๆ! (${b.fighter.name} ติด -2 FA)`
          });
        }
        a.resolved = true;
        b.resolved = true;
        continue;
      }

      // กรณีที่ 2: โจมตีชนป้องกัน (Guard) หรือหลบ (Evade)
      const atk = a.action.type === "ATTACK" ? a : (b.action.type === "ATTACK" ? b : null);
      const def = atk === a ? b : a;

      if (atk && def.action.type === "GUARD") {
        if (def.frame <= atk.frame) {
          nextFA[def.actorId] = 2;
          logs.push({
            type: "guard",
            text: `F${def.frame}: 🛡️ GUARD & PUNISH! ${def.fighter.name} ตั้งการ์ดรับ ${atk.action.name} ของ ${atk.fighter.name} (ลดดาเมจครึ่งหนึ่ง, ได้ +2 FA)`
          });
        } else {
          logs.push({
            type: "counter",
            text: `F${atk.frame}: 💥 การ์ดไม่ทัน! ${atk.fighter.name} ซัด ${def.fighter.name} เข้าเต็มๆ ก่อนจะยกการ์ด (F${def.frame})`
          });
        }
        a.resolved = true;
        b.resolved = true;
        continue;
      }

      if (atk && def.action.type === "EVADE") {
        if (def.frame <= atk.frame) {
          nextFA[def.actorId] = 1;
          logs.push({
            type: "evade",
            text: `F${def.frame}: 💨 EVADE! ${def.fighter.name} หลบ ${atk.action.name} ของ ${atk.fighter.name} พ้นสวยงาม (+1 FA)`
          });
        } else {
          logs.push({
            type: "counter",
            text: `F${atk.frame}: 💥 หลบไม่ทัน! ${atk.fighter.name} ตีโดน ${def.fighter.name} เต็มๆ`
          });
        }
        a.resolved = true;
        b.resolved = true;
        continue;
      }
    }

    // กรณีไม่ได้เล็งสวนกันตรงๆ (ตีฝ่ายเดียว หรือต่างคนต่างตั้งรับ)
    const targetName = state.fighters[a.targetId]?.name || "เป้าหมาย";
    if (a.interrupted) {
      logs.push({ type: "counter", text: `F${a.frame}: ❌ ${a.fighter.name} ถูกขัดจังหวะ ท่าถูกยกเลิก` });
    } else if (a.action.type === "ATTACK") {
      logs.push({ type: "normal", text: `F${a.frame}: ⚔️ ${a.fighter.name} ใช้ ${a.action.name} ใส่ ${targetName} (Pow ${a.action.power + (a.fighter.statMod || 0)})` });
    } else {
      logs.push({ type: "normal", text: `F${a.frame}: ${a.fighter.name} ตั้งท่า ${a.action.name}` });
    }
    a.resolved = true;
  }

  const timeline = entries.map(e => ({
    name: e.fighter.name,
    frame: Math.min(10, e.frame),
    type: e.action.type
  }));

  saveState({
    ...state,
    phase: "REVEAL",
    resolution: { timeline, clashes, logs, nextFA }
  });

  broadcastSfx(clashes.length > 0 ? "CLASH" : "PING");
}

// ---------------- อัปเดตหน้าจอ UI ----------------
function render() {
  document.getElementById("round-label").textContent = `ROUND ${state.round}`;
  document.getElementById("mode-label").textContent = isOBR ? "Owlbear Live Sync" : "Local Demo Mode (ทดสอบออฟไลน์)";
  document.getElementById("role-badge").textContent = myRole;

  const phaseBadge = document.getElementById("phase-badge");
  phaseBadge.textContent = state.phase;
  phaseBadge.className = "badge " + (state.phase === "REVEAL" ? "ready" : "");

  const isGM = myRole === "GM";
  document.getElementById("gm-add-row").classList.toggle("hidden", !isGM);
  document.getElementById("gm-controls").classList.toggle("hidden", !isGM);
  document.getElementById("gm-next-controls").classList.toggle("hidden", !isGM);

  const isReveal = state.phase === "REVEAL";
  document.getElementById("planning-panel").classList.toggle("hidden", isReveal);
  document.getElementById("roster-panel").classList.toggle("hidden", isReveal);
  document.getElementById("reveal-panel").classList.toggle("hidden", !isReveal);

  // เติมรายชื่อตัวละครใน Dropdown
  const actorSelect = document.getElementById("actor-select");
  const targetSelect = document.getElementById("target-select");
  const currentActor = actorSelect.value || myId;
  const currentTarget = targetSelect.value;

  const fightersList = Object.values(state.fighters);
  const controllable = isGM ? fightersList : fightersList.filter(f => f.id === myId);

  actorSelect.innerHTML = controllable.map(f =>
    `<option value="${f.id}">${f.name} ${f.isNpc ? "(NPC)" : ""}</option>`
  ).join("");
  if (controllable.some(f => f.id === currentActor)) actorSelect.value = currentActor;

  const activeActorId = actorSelect.value;
  const targets = fightersList.filter(f => f.id !== activeActorId);
  targetSelect.innerHTML = targets.length
    ? targets.map(f => `<option value="${f.id}">${f.name}</option>`).join("")
    : `<option value="">-- รอผู้เล่นอื่นหรือเพิ่ม NPC --</option>`;
  if (targets.some(f => f.id === currentTarget)) targetSelect.value = currentTarget;

  // โชว์ค่า Stat ของตัวละครที่เลือกอยู่
  const f = state.fighters[activeActorId];
  if (f) {
    document.getElementById("input-spd").value = f.speedMod || 0;
    document.getElementById("input-stat").value = f.statMod || 0;
    document.getElementById("input-fa").value = f.frameAdv || 0;
  }

  // เรนเดอร์ปุ่มเลือกแอ็กชัน
  const grid = document.getElementById("action-grid");
  grid.innerHTML = ACTIONS.map(a => `
    <button class="action-btn ${selectedActionId === a.id ? "selected" : ""}" data-id="${a.id}">
      <span class="action-name">${a.name}</span>
      <span class="action-meta">${a.desc}</span>
    </button>
  `).join("");
  grid.querySelectorAll(".action-btn").forEach(btn => {
    btn.onclick = () => { selectedActionId = btn.dataset.id; render(); };
  });

  // เรนเดอร์สถานะ Ready ของทุกคนในห้อง
  const lockedCount = Object.keys(state.locked).length;
  document.getElementById("ready-count").textContent = `${lockedCount}/${fightersList.length} Ready`;
  document.getElementById("roster-list").innerHTML = fightersList.map(fighter => {
    const isLocked = Boolean(state.locked[fighter.id]);
    const fa = fighter.frameAdv || 0;
    const faClass = fa > 0 ? "fa-pos" : (fa < 0 ? "fa-neg" : "fa-zero");
    const faText = fa > 0 ? `+${fa} FA` : `${fa} FA`;
    return `
      <div class="roster-item">
        <span><strong>${fighter.name}</strong> <span class="fa-tag ${faClass}">${faText}</span></span>
        <span style="color:${isLocked ? "var(--green)" : "var(--muted)"}">
          ${isLocked ? "🟢 Ready" : "⏳ กำลังคิด..."}
        </span>
      </div>
    `;
  }).join("");

  // เรนเดอร์หน้า Reveal (Timeline + Clash + Logs)
  if (isReveal && state.resolution) {
    const { timeline, clashes, logs } = state.resolution;

    const track = document.getElementById("timeline-track");
    track.innerHTML = "";
    for (let fr = 1; fr <= 10; fr++) {
      const items = timeline.filter(t => t.frame === fr);
      const chips = items.map(t => {
        const cls = t.type === "ATTACK" ? "chip-atk" : (t.type === "GUARD" ? "chip-def" : "chip-evd");
        return `<div class="frame-chip ${cls}" title="${t.name}">${t.name}</div>`;
      }).join("");
      track.innerHTML += `<div class="frame-col"><div class="frame-num">F${fr}</div>${chips}</div>`;
    }

    document.getElementById("clash-container").innerHTML = clashes.map(c => {
      const total = Math.max(1, c.scoreA + c.scoreB);
      const pctA = Math.round((c.scoreA / total) * 100);
      return `
        <div class="clash-box">
          <div class="clash-title">⚔️ CLASH DETECTED!! ⚔️</div>
          <div class="clash-vs">
            <div><strong>${c.aName}</strong> (${c.aAct})<br><small>${c.aDetail} = <strong>${c.scoreA}</strong></small></div>
            <div style="text-align:right"><strong>${c.bName}</strong> (${c.bAct})<br><small>${c.bDetail} = <strong>${c.scoreB}</strong></small></div>
          </div>
          <div class="tug-bar"><div class="tug-left" style="width:${pctA}%"></div></div>
          <div style="text-align:center; margin-top:6px; font-weight:bold; font-size:12px;">${c.resultText}</div>
        </div>
      `;
    }).join("");

    document.getElementById("log-container").innerHTML = logs.map(l =>
      `<div class="log-item log-${l.type}">${l.text}</div>`
    ).join("");
  }
}

// ---------------- Event Listeners ----------------
document.getElementById("actor-select").onchange = render;

["input-spd", "input-stat", "input-fa"].forEach(id => {
  document.getElementById(id).onchange = () => {
    const actorId = document.getElementById("actor-select").value;
    if (!state.fighters[actorId]) return;
    const updated = structuredClone(state);
    updated.fighters[actorId].speedMod = parseInt(document.getElementById("input-spd").value) || 0;
    updated.fighters[actorId].statMod = parseInt(document.getElementById("input-stat").value) || 0;
    updated.fighters[actorId].frameAdv = parseInt(document.getElementById("input-fa").value) || 0;
    saveState(updated);
  };
});

document.getElementById("btn-add-npc").onclick = () => {
  const input = document.getElementById("new-npc-name");
  const name = input.value.trim();
  if (!name) return;
  const id = "npc-" + Date.now();
  const updated = structuredClone(state);
  updated.fighters[id] = { id, name, speedMod: 0, statMod: 1, frameAdv: 0, isNpc: true };
  input.value = "";
  saveState(updated);
};

document.getElementById("btn-lock").onclick = () => {
  const actorId = document.getElementById("actor-select").value;
  const targetId = document.getElementById("target-select").value;
  if (!actorId || !targetId) return alert("กรุณาเลือกตัวละครและเป้าหมายก่อนครับ");

  const updated = structuredClone(state);
  updated.locked[actorId] = { actorId, targetId, actionId: selectedActionId };
  playSfx("PING");
  saveState(updated);
};

document.getElementById("btn-resolve").onclick = () => {
  if (Object.keys(state.locked).length === 0) return alert("ยังไม่มีใครกด Lock-in เลยครับ");
  resolveTurn();
};

document.getElementById("btn-next-round").onclick = () => {
  const updated = structuredClone(state);
  const nextFA = state.resolution?.nextFA || {};
  Object.keys(updated.fighters).forEach(id => {
    if (nextFA[id] !== undefined) updated.fighters[id].frameAdv = nextFA[id];
  });
  updated.round += 1;
  updated.phase = "PLANNING";
  updated.locked = {};
  updated.resolution = null;
  saveState(updated);
};

// ---------------- เริ่มต้นการทำงาน ----------------
if (OBR.isAvailable) {
  isOBR = true;
  OBR.onReady(async () => {
    myId = await OBR.player.getId();
    myRole = await OBR.player.getRole();
    const myName = await OBR.player.getName();

    const meta = await OBR.room.getMetadata();
    if (meta[META_KEY]) {
      state = meta[META_KEY];
    }

    // ลงทะเบียนผู้เล่นเข้าห้องอัตโนมัติ
    if (!state.fighters[myId]) {
      const updated = structuredClone(state);
      updated.fighters[myId] = { id: myId, name: myName, speedMod: 0, statMod: 0, frameAdv: 0, isNpc: false };
      await saveState(updated);
    }

    OBR.room.onMetadataChange((newMeta) => {
      if (newMeta[META_KEY]) {
        state = newMeta[META_KEY];
        render();
      }
    });

    OBR.broadcast.onMessage(SFX_CHANNEL, (event) => {
      playSfx(event.data?.type || "PING");
    });

    render();
  });
} else {
  // โหมดทดสอบออฟไลน์ (เปิดบนเบราว์เซอร์ตรงๆ)
  isOBR = false;
  myId = "player-1";
  myRole = "GM";
  state.fighters = {
    "player-1": { id: "player-1", name: "ผู้เล่น A", speedMod: 1, statMod: 2, frameAdv: 0, isNpc: false },
    "boss-1":   { id: "boss-1",   name: "บอสหุ่นยนต์", speedMod: 0, statMod: 2, frameAdv: 0, isNpc: true }
  };
  render();
}
