import { verifyToken } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { redis, keys } from "../lib/redis.js";
import { launchRound, closeRound } from "../services/roundService.js";

export function registerHostNamespace(io) {
  const nsp = io.of("/host");

  nsp.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = verifyToken(token);
    if (!payload || payload.role !== "host") {
      return next(new Error("unauthorized"));
    }
    socket.data.userId = payload.userId;
    socket.data.eventId = payload.eventId;
    next();
  });

  nsp.on("connection", (socket) => {
    const { eventId, userId } = socket.data;
    socket.join(`event:${eventId}`);
    console.log(`[host] connected user=${userId} event=${eventId}`);

    socket.on("event:sync", async (_, ack) => {
      const event = await prisma.event.findUnique({
        where: { id: eventId },
        include: {
          players: { orderBy: { totalScore: "desc" } },
          quiz: { include: { questions: { orderBy: { position: "asc" } } } },
        },
      });
      const state = await redis.hgetall(keys.eventState(eventId));
      ack?.({ event, state });
    });

    socket.on("question:launch", async ({ questionId }, ack) => {
      try {
        const round = await launchRound({ eventId, questionId, io });
        ack?.({ ok: true, roundId: round.id });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    socket.on("round:close", async ({ roundId }, ack) => {
      try {
        await closeRound({ eventId, roundId, io, reason: "host" });
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    socket.on("event:end", async (_, ack) => {
      await prisma.event.update({
        where: { id: eventId },
        data: { status: "ended", endedAt: new Date() },
      });
      const players = await prisma.player.findMany({
        where: { eventId },
        orderBy: { totalScore: "desc" },
      });
      nsp.to(`event:${eventId}`).emit("event:final_leaderboard", { players });
      io.of("/player").to(`event:${eventId}`).emit("event:final_leaderboard", { players });
      await redis.del(keys.eventState(eventId));
      ack?.({ ok: true });
    });

    socket.on("disconnect", () => {
      console.log(`[host] disconnected user=${userId} event=${eventId}`);
    });
  });
}
