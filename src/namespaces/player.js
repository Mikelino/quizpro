import { verifyToken, signPlayerToken } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { redis, keys } from "../lib/redis.js";
import { submitAnswer } from "../services/roundService.js";

export function registerPlayerNamespace(io) {
  const nsp = io.of("/player");

  nsp.on("connection", (socket) => {
    socket.on("player:join", async ({ pin, nickname }, ack) => {
      try {
        const event = await prisma.event.findFirst({
          where: { pin, status: { in: ["lobby", "in_question", "between_questions"] } },
        });
        if (!event) return ack?.({ ok: false, error: "event_not_found" });

        const clean = String(nickname || "").trim().slice(0, 24);
        if (!clean) return ack?.({ ok: false, error: "invalid_nickname" });

        const existing = await prisma.player.findUnique({
          where: { eventId_nickname: { eventId: event.id, nickname: clean } },
        });
        if (existing) return ack?.({ ok: false, error: "nickname_taken" });

        const player = await prisma.player.create({
          data: { eventId: event.id, nickname: clean, socketId: socket.id },
        });

        socket.data.playerId = player.id;
        socket.data.eventId = event.id;
        socket.join(`event:${event.id}`);
        await redis.set(keys.playerSocket(event.id, player.id), socket.id);

        io.of("/host").to(`event:${event.id}`).emit("lobby:player_joined", {
          playerId: player.id,
          nickname: player.nickname,
        });

        ack?.({
          ok: true,
          playerId: player.id,
          eventId: event.id,
          token: signPlayerToken(player.id, event.id),
        });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    socket.on("player:reconnect", async ({ token }, ack) => {
      const payload = verifyToken(token);
      if (!payload || payload.role !== "player") {
        return ack?.({ ok: false, error: "invalid_token" });
      }
      const { playerId, eventId } = payload;
      const player = await prisma.player.findUnique({ where: { id: playerId } });
      if (!player || player.eventId !== eventId) {
        return ack?.({ ok: false, error: "player_not_found" });
      }

      socket.data.playerId = playerId;
      socket.data.eventId = eventId;
      socket.join(`event:${eventId}`);
      await redis.set(keys.playerSocket(eventId, playerId), socket.id);
      await prisma.player.update({
        where: { id: playerId },
        data: { socketId: socket.id },
      });

      const state = await redis.hgetall(keys.eventState(eventId));
      let currentQuestion = null;
      let secondsLeft = 0;
      let alreadyAnswered = false;

      if (state.current_round_id && state.status === "in_question") {
        const meta = await redis.hgetall(keys.roundMeta(state.current_round_id));
        if (meta.launchedAt) {
          const elapsed = (Date.now() - Number(meta.launchedAt)) / 1000;
          secondsLeft = Math.max(0, Number(meta.timeLimit) - Math.floor(elapsed));
          const q = await prisma.question.findUnique({
            where: { id: meta.questionId },
            select: {
              id: true, type: true, prompt: true, options: true, timeLimit: true,
            },
          });
          currentQuestion = { roundId: state.current_round_id, ...q };
          alreadyAnswered = Boolean(
            await redis.hget(keys.roundAnswers(state.current_round_id), playerId)
          );
        }
      }

      ack?.({
        ok: true,
        playerId,
        eventId,
        nickname: player.nickname,
        totalScore: player.totalScore,
        currentQuestion,
        secondsLeft,
        alreadyAnswered,
        eventStatus: state.status || "lobby",
      });
    });

    socket.on("answer:submit", async ({ roundId, choiceIndex, choiceIndexes, orderedIndexes }, ack) => {
      const { playerId, eventId } = socket.data;
      if (!playerId) return ack?.({ ok: false, error: "not_joined" });

      const result = await submitAnswer({ roundId, playerId, choiceIndex, choiceIndexes, orderedIndexes, io });
      ack?.(result);
    });

    socket.on("disconnect", async () => {
      const { playerId, eventId } = socket.data;
      if (!playerId) return;
      await redis.del(keys.playerSocket(eventId, playerId));
    });
  });
}
