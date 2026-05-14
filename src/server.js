import "dotenv/config";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";

import { prisma } from "./lib/prisma.js";
import { redis, pubClient, subClient, keys } from "./lib/redis.js";
import { signHostToken } from "./lib/auth.js";
import { generatePin } from "./lib/scoring.js";
import { registerHostNamespace } from "./namespaces/host.js";
import { registerPlayerNamespace } from "./namespaces/player.js";

const PORT = process.env.PORT || 3000;

const httpServer = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "POST" && req.url === "/api/events") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { userId, quizId } = JSON.parse(body);
        let pin;
        for (let i = 0; i < 5; i++) {
          pin = generatePin();
          const clash = await prisma.event.findFirst({
            where: { pin, status: { in: ["lobby", "in_question", "between_questions"] } },
          });
          if (!clash) break;
        }
        const event = await prisma.event.create({
          data: { quizId, hostId: userId, pin, status: "lobby", startedAt: new Date() },
        });
        await redis.hset(keys.eventState(event.id), { status: "lobby" });
        const token = signHostToken(userId, event.id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ event, hostToken: token }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

if (req.method === "POST" && req.url === "/api/join") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { pin, nickname } = JSON.parse(body);
        const event = await prisma.event.findFirst({
          where: { pin, status: { in: ["lobby", "in_question", "between_questions"] } },
        });
        if (!event) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "event_not_found" }));
        }
        const clean = String(nickname || "").trim().slice(0, 24);
        if (!clean) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "invalid_nickname" }));
        }
        const existing = await prisma.player.findUnique({
          where: { eventId_nickname: { eventId: event.id, nickname: clean } },
        });
        if (existing) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "nickname_taken" }));
        }
        const { signPlayerToken } = await import("./lib/auth.js");
const player = await prisma.player.create({
  data: { eventId: event.id, nickname: clean },
});
const token = signPlayerToken(player.id, event.id);

// Notifier l'animateur en temps réel
io.of("/host").to(`event:${event.id}`).emit("lobby:player_joined", {
  playerId: player.id,
  nickname: clean,
});

res.writeHead(200, { "Content-Type": "application/json" });
res.end(JSON.stringify({
  ok: true,
  playerId: player.id,
  eventId: event.id,
  token,
}));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    return res.end("ok");
  }

  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:3001",
      "https://fluffy-space-adventure-rjrgw54p625pv9-3001.app.github.dev",
    ],
    credentials: true,
    methods: ["GET", "POST"],
  },
});

Promise.all([pubClient.ping(), subClient.ping()]).then(() => {
  io.adapter(createAdapter(pubClient, subClient));
  console.log("[socket.io] redis adapter attached");
});

registerHostNamespace(io);
registerPlayerNamespace(io);

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

const shutdown = async () => {
  console.log("\n[server] shutting down");
  await io.close();
  await prisma.$disconnect();
  await redis.quit();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
