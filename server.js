const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

// ─── In-memory rooms ────────────────────────────────────────────
const rooms = new Map();
const FIBONACCI = [0, 1, 2, 3, 5, 8, 13, 21];
const TSHIRT = [
  { label: "XS", max: 1.5, color: "#4CAF50" },
  { label: "S", max: 3.5, color: "#8BC34A" },
  { label: "M", max: 6.5, color: "#FFC107" },
  { label: "L", max: 10.5, color: "#FF9800" },
  { label: "XL", max: 17, color: "#FF5722" },
  { label: "XXL", max: Infinity, color: "#D32F2F" },
];

function uid() {
  return Math.random().toString(36).slice(2, 9);
}
function getTShirt(avg) {
  if (avg == null || isNaN(avg)) return { label: "—", color: "#999" };
  for (const s of TSHIRT) if (avg <= s.max) return s;
  return TSHIRT[TSHIRT.length - 1];
}
function genCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => c[Math.floor(Math.random() * c.length)]).join("");
}

function createRoom() {
  return {
    code: genCode(),
    issues: [],
    currentIndex: 0,
    participants: [],
    settings: { timerDuration: 60, anonymous: true, autoReveal: true },
    phase: "idle",
    timerRemaining: 60,
    reactions: [],
  };
}

function broadcastState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  // Strip internal fields (_timer, _ws) to avoid circular JSON errors
  const safeState = {
    code: room.code,
    issues: room.issues,
    currentIndex: room.currentIndex,
    participants: room.participants.map(({ _ws, ...rest }) => rest),
    settings: room.settings,
    phase: room.phase,
    timerRemaining: room.timerRemaining,
    reactions: room.reactions,
  };
  const msg = JSON.stringify({ type: "state", state: safeState });
  room.participants.forEach((p) => {
    if (p._ws && p._ws.readyState === 1) p._ws.send(msg);
  });
}

function broadcastReaction(roomCode, emoji, userName) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const r = { id: uid(), emoji, user: userName, ts: Date.now() };
  room.reactions = [...room.reactions.slice(-29), r];
  const msg = JSON.stringify({ type: "reaction", ...r });
  room.participants.forEach((p) => {
    if (p._ws && p._ws.readyState === 1) p._ws.send(msg);
  });
}

function checkAutoReveal(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.phase !== "voting" || !room.settings.autoReveal) return;
  const issue = room.issues[room.currentIndex];
  if (!issue) return;
  const voters = room.participants.filter((p) => p.role === "voter");
  const allVoted = voters.length > 0 && voters.every((p) => issue.votes[p.id] !== undefined);
  if (allVoted) {
    setTimeout(() => revealVotes(roomCode), 400);
  }
}

function revealVotes(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.phase !== "voting") return;
  clearInterval(room._timer);
  const issue = room.issues[room.currentIndex];
  if (!issue) return;
  const numericVotes = Object.values(issue.votes).filter((v) => typeof v === "number");
  const avg =
    numericVotes.length > 0
      ? Math.round((numericVotes.reduce((a, b) => a + b, 0) / numericVotes.length) * 10) / 10
      : null;
  const allSame = numericVotes.length > 1 && numericVotes.every((v) => v === numericVotes[0]);
  issue.result = { avg, tshirt: getTShirt(avg), totalVoters: numericVotes.length, consensus: allSame };
  room.phase = "revealed";
  broadcastState(roomCode);
}

function startTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  clearInterval(room._timer);
  room.timerRemaining = room.settings.timerDuration;
  room._timer = setInterval(() => {
    room.timerRemaining--;
    if (room.timerRemaining <= 0) {
      revealVotes(roomCode);
    } else {
      broadcastState(roomCode);
    }
  }, 1000);
}

// ─── WebSocket Handler ──────────────────────────────────────────
wss.on("connection", (ws) => {
  let myRoom = null;
  let myId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "create": {
        const room = createRoom();
        myId = uid();
        myRoom = room.code;
        room.participants.push({
          id: myId, name: msg.name || "Host", role: msg.role || "voter",
          avatar: msg.avatar || "🙋", vote: null, isHost: true, _ws: ws,
        });
        rooms.set(room.code, room);
        ws.send(JSON.stringify({ type: "joined", roomCode: room.code, userId: myId }));
        broadcastState(room.code);
        break;
      }

      case "join": {
        const room = rooms.get(msg.room?.toUpperCase());
        if (!room) { ws.send(JSON.stringify({ type: "error", message: "Sala no encontrada" })); return; }
        myId = uid();
        myRoom = room.code;
        room.participants.push({
          id: myId, name: msg.name || "Guest", role: msg.role || "voter",
          avatar: msg.avatar || "🙋", vote: null, isHost: false, _ws: ws,
        });
        ws.send(JSON.stringify({ type: "joined", roomCode: room.code, userId: myId }));
        broadcastState(room.code);
        break;
      }

      case "addIssue": {
        const room = rooms.get(myRoom);
        if (!room) return;
        room.issues.push({ id: uid(), title: msg.title, description: msg.description || "", votes: {}, result: null, round: 1 });
        broadcastState(myRoom);
        break;
      }

      case "removeIssue": {
        const room = rooms.get(myRoom);
        if (!room || room.phase !== "idle") return;
        room.issues = room.issues.filter((i) => i.id !== msg.issueId);
        room.currentIndex = Math.min(room.currentIndex, Math.max(0, room.issues.length - 1));
        broadcastState(myRoom);
        break;
      }

      case "setCurrent": {
        const room = rooms.get(myRoom);
        if (!room || room.phase !== "idle") return;
        room.currentIndex = Math.max(0, Math.min(msg.index, room.issues.length - 1));
        broadcastState(myRoom);
        break;
      }

      case "startVoting": {
        const room = rooms.get(myRoom);
        if (!room || !room.issues[room.currentIndex]) return;
        room.phase = "voting";
        room.issues[room.currentIndex].votes = {};
        room.issues[room.currentIndex].result = null;
        room.participants.forEach((p) => (p.vote = null));
        startTimer(myRoom);
        broadcastState(myRoom);
        break;
      }

      case "vote": {
        const room = rooms.get(myRoom);
        if (!room || room.phase !== "voting") return;
        const issue = room.issues[room.currentIndex];
        if (!issue) return;
        issue.votes[myId] = msg.value;
        const p = room.participants.find((x) => x.id === myId);
        if (p) p.vote = msg.value;
        broadcastState(myRoom);
        checkAutoReveal(myRoom);
        break;
      }

      case "reveal": {
        revealVotes(myRoom);
        break;
      }

      case "revote": {
        const room = rooms.get(myRoom);
        if (!room) return;
        const issue = room.issues[room.currentIndex];
        if (!issue) return;
        issue.votes = {};
        issue.result = null;
        issue.round++;
        room.participants.forEach((p) => (p.vote = null));
        room.phase = "voting";
        startTimer(myRoom);
        broadcastState(myRoom);
        break;
      }

      case "nextIssue": {
        const room = rooms.get(myRoom);
        if (!room) return;
        room.currentIndex = Math.min(room.currentIndex + 1, room.issues.length - 1);
        room.phase = "idle";
        clearInterval(room._timer);
        broadcastState(myRoom);
        break;
      }

      case "updateSettings": {
        const room = rooms.get(myRoom);
        if (!room) return;
        Object.assign(room.settings, msg.settings);
        broadcastState(myRoom);
        break;
      }

      case "reaction": {
        const room = rooms.get(myRoom);
        if (!room) return;
        const me = room.participants.find((x) => x.id === myId);
        broadcastReaction(myRoom, msg.emoji, me?.name || "Anon");
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!myRoom || !myId) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    room.participants = room.participants.filter((p) => p.id !== myId);
    if (room.participants.length === 0) {
      clearInterval(room._timer);
      rooms.delete(myRoom);
    } else {
      if (room.phase === "voting") checkAutoReveal(myRoom);
      broadcastState(myRoom);
    }
  });
});

// ─── Cleanup stale rooms every 30 min ──────────────────────────
setInterval(() => {
  for (const [code, room] of rooms) {
    const alive = room.participants.some((p) => p._ws && p._ws.readyState === 1);
    if (!alive) { clearInterval(room._timer); rooms.delete(code); }
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🃏 GROOMY running on port ${PORT}`));
