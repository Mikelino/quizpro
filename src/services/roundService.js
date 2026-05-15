import { prisma } from "../lib/prisma.js";
import { redis, keys } from "../lib/redis.js";
import { computeScore } from "../lib/scoring.js";

const roundTimers = new Map();

export async function launchRound({ eventId, questionId, io }) {
  const question = await prisma.question.findUnique({ where: { id: questionId } });
  if (!question) throw new Error("Question not found");

  const priorRounds = await prisma.round.count({ where: { eventId } });

  const round = await prisma.round.create({
    data: {
      eventId,
      questionId,
      position: priorRounds,
      launchedAt: new Date(),
    },
  });

  // For ordering: shuffle option indexes once and store
  let shuffledIndexes = null;
  if (question.type === "ordering") {
    const n = (question.options || []).length;
    shuffledIndexes = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledIndexes[i], shuffledIndexes[j]] = [shuffledIndexes[j], shuffledIndexes[i]];
    }
  }

  const meta = {
    eventId,
    questionId,
    roundId: round.id,
    launchedAt: round.launchedAt.getTime(),
    timeLimit: question.timeLimit,
    questionType: question.type,
    correctIndex: question.correctIndex ?? "",
    correctIndexes: (question.correctIndexes || []).join(","),
    scoringMode: question.scoringMode,
  };
  if (shuffledIndexes) meta.shuffledIndexes = shuffledIndexes.join(",");

  await redis.hset(keys.roundMeta(round.id), meta);
  await redis.expire(keys.roundMeta(round.id), 3600);
  await redis.hset(keys.eventState(eventId), {
    current_round_id: round.id,
    status: "in_question",
  });

  const basePayload = {
    roundId: round.id,
    questionId: question.id,
    type: question.type,
    prompt: question.prompt,
    options: question.options,
    timeLimit: question.timeLimit,
    position: round.position,
  };
  if (shuffledIndexes) basePayload.shuffledIndexes = shuffledIndexes;

  io.of("/player").to(`event:${eventId}`).emit("question:shown", basePayload);

  io.of("/host").to(`event:${eventId}`).emit("question:shown", {
    ...basePayload,
    hostNotes: question.hostNotes,
  });

  io.of("/host").to(`event:${eventId}`).emit("round:started", {
    roundId: round.id,
    launchedAt: round.launchedAt.getTime(),
  });

  startTimerTicks({ eventId, roundId: round.id, timeLimit: question.timeLimit, io });

  const timeout = setTimeout(() => {
    closeRound({ eventId, roundId: round.id, io, reason: "timeout" }).catch((e) =>
      console.error("[closeRound]", e)
    );
  }, question.timeLimit * 1000);
  roundTimers.set(round.id, timeout);

  return round;
}

function startTimerTicks({ eventId, roundId, timeLimit, io }) {
  let secondsLeft = timeLimit;
  const interval = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft < 0) {
      clearInterval(interval);
      return;
    }
    io.of("/player").to(`event:${eventId}`).emit("timer:tick", { roundId, secondsLeft });
    io.of("/host").to(`event:${eventId}`).emit("timer:tick", { roundId, secondsLeft });
  }, 1000);
  const existing = roundTimers.get(`tick:${roundId}`);
  if (existing) clearInterval(existing);
  roundTimers.set(`tick:${roundId}`, interval);
}

function encodePayload({ type, choiceIndex, choiceIndexes, orderedIndexes, timeMs, points, correct }) {
  if (type === "multianswer") {
    return `m:${(choiceIndexes || []).join(",")}:${timeMs}:${points}:${correct ? 1 : 0}`;
  }
  if (type === "ordering") {
    return `o:${(orderedIndexes || []).join(",")}:${timeMs}:${points}:${correct ? 1 : 0}`;
  }
  return `${choiceIndex}:${timeMs}:${points}:${correct ? 1 : 0}`;
}

function decodePayload(payload) {
  if (payload.startsWith("m:")) {
    const [, csv, timeMs, points, correct] = payload.split(":");
    const choiceIndexes = csv ? csv.split(",").map(Number) : [];
    return { type: "multianswer", choiceIndexes, choiceIndex: null, orderedIndexes: null,
      timeMs: Number(timeMs), points: Number(points), correct: correct === "1" };
  }
  if (payload.startsWith("o:")) {
    const [, csv, timeMs, points, correct] = payload.split(":");
    const orderedIndexes = csv ? csv.split(",").map(Number) : [];
    return { type: "ordering", orderedIndexes, choiceIndex: null, choiceIndexes: null,
      timeMs: Number(timeMs), points: Number(points), correct: correct === "1" };
  }
  const [choiceIndex, timeMs, points, correct] = payload.split(":").map(Number);
  return { type: "standard", choiceIndex, choiceIndexes: null, orderedIndexes: null,
    timeMs, points, correct: Boolean(correct) };
}

export async function submitAnswer({ roundId, playerId, choiceIndex, choiceIndexes, orderedIndexes, io }) {
  const meta = await redis.hgetall(keys.roundMeta(roundId));
  if (!meta.launchedAt) {
    return { ok: false, reason: "round_not_found" };
  }

  const existing = await redis.hget(keys.roundAnswers(roundId), playerId);
  if (existing) {
    return { ok: false, reason: "already_answered" };
  }

  const launchedAt = Number(meta.launchedAt);
  const timeLimitMs = Number(meta.timeLimit) * 1000;
  const timeMs = Date.now() - launchedAt;

  if (timeMs > timeLimitMs + 500) {
    return { ok: false, reason: "too_late" };
  }

  const qType = meta.questionType || "qcm";
  let correct = false;

  if (qType === "multianswer") {
    const correctSet = new Set((meta.correctIndexes || "").split(",").map(Number).filter(n => !isNaN(n)));
    const chosen = new Set((choiceIndexes || []).map(Number));
    correct = correctSet.size === chosen.size && [...correctSet].every(i => chosen.has(i));
  } else if (qType === "ordering") {
    const naturalOrder = (meta.shuffledIndexes ? meta.shuffledIndexes.split(",").map(Number) : []);
    // correct order is [0,1,2,...,n-1] — compare submitted orderedIndexes to that
    const n = orderedIndexes?.length || 0;
    correct = n > 0 && orderedIndexes.every((v, i) => v === i);
  } else {
    correct = Number(meta.correctIndex) === choiceIndex;
  }

  const points = computeScore({
    correct,
    timeMs,
    timeLimitMs,
    mode: meta.scoringMode,
  });

  const payload = encodePayload({ type: qType, choiceIndex, choiceIndexes, orderedIndexes, timeMs, points, correct });
  await redis.hset(keys.roundAnswers(roundId), playerId, payload);
  await redis.expire(keys.roundAnswers(roundId), 3600);

  const total = await redis.hlen(keys.roundAnswers(roundId));
  const playersInEvent = await prisma.player.count({ where: { eventId: meta.eventId } });

  io.of("/host").to(`event:${meta.eventId}`).emit("answers:progress", {
    roundId,
    count: total,
    total: playersInEvent,
  });

  if (total >= playersInEvent) {
    await closeRound({
      eventId: meta.eventId,
      roundId,
      io,
      reason: "all_answered",
    });
  }

  return { ok: true };
}

export async function closeRound({ eventId, roundId, io, reason = "manual" }) {
  const alreadyClosed = await redis.hget(keys.eventState(eventId), "last_closed_round");
  if (alreadyClosed === roundId) return;
  await redis.hset(keys.eventState(eventId), "last_closed_round", roundId);

  const timeout = roundTimers.get(roundId);
  if (timeout) {
    clearTimeout(timeout);
    roundTimers.delete(roundId);
  }
  const tick = roundTimers.get(`tick:${roundId}`);
  if (tick) {
    clearInterval(tick);
    roundTimers.delete(`tick:${roundId}`);
  }

  const meta = await redis.hgetall(keys.roundMeta(roundId));
  const answersRaw = await redis.hgetall(keys.roundAnswers(roundId));

  const answerRows = Object.entries(answersRaw).map(([playerId, payload]) => {
    const decoded = decodePayload(payload);
    return { playerId, ...decoded };
  });

  if (answerRows.length > 0) {
    await prisma.$transaction([
      prisma.answer.createMany({
        data: answerRows.map((a) => ({
          roundId,
          playerId: a.playerId,
          choiceIndex: a.choiceIndex ?? null,
          textAnswer: a.choiceIndexes
            ? JSON.stringify(a.choiceIndexes)
            : a.orderedIndexes
              ? JSON.stringify(a.orderedIndexes)
              : null,
          timeMs: a.timeMs,
          pointsAwarded: a.points,
        })),
        skipDuplicates: true,
      }),
      ...answerRows.map((a) =>
        prisma.player.update({
          where: { id: a.playerId },
          data: { totalScore: { increment: a.points } },
        })
      ),
    ]);
  }

  await prisma.round.update({
    where: { id: roundId },
    data: { closedAt: new Date() },
  });

  const players = await prisma.player.findMany({
    where: { eventId },
    orderBy: { totalScore: "desc" },
    select: { id: true, nickname: true, totalScore: true },
  });

  const qType = meta.questionType || "qcm";
  const correctIndexes = (meta.correctIndexes || "").split(",").map(Number).filter(n => !isNaN(n) && meta.correctIndexes);

  const stats = {
    questionType: qType,
    correctIndex: meta.correctIndex !== "" ? Number(meta.correctIndex) : null,
    correctIndexes,
    shuffledIndexes: meta.shuffledIndexes ? meta.shuffledIndexes.split(",").map(Number) : null,
    distribution: answerRows.reduce((acc, a) => {
      if (a.choiceIndex !== null && a.choiceIndex !== undefined) {
        acc[a.choiceIndex] = (acc[a.choiceIndex] || 0) + 1;
      }
      return acc;
    }, {}),
    totalAnswers: answerRows.length,
    reason,
  };

  const answerByPlayer = Object.fromEntries(answerRows.map((a) => [a.playerId, a]));
  for (const player of players) {
    const socketId = await redis.get(keys.playerSocket(eventId, player.id));
    const a = answerByPlayer[player.id];
    const rank = players.findIndex((p) => p.id === player.id) + 1;
    if (socketId) {
      io.of("/player").to(socketId).emit("round:reveal", {
        roundId,
        questionType: qType,
        correctIndex: stats.correctIndex,
        correctIndexes,
        yourChoice: a?.choiceIndex ?? null,
        yourChoices: a?.choiceIndexes ?? null,
        yourOrder: a?.orderedIndexes ?? null,
        yourPoints: a?.points ?? 0,
        yourCorrect: a?.correct ?? false,
        totalScore: player.totalScore,
        rank,
        playersCount: players.length,
      });
    }
  }

  io.of("/host").to(`event:${eventId}`).emit("round:closed", {
    roundId,
    stats,
    leaderboard: players,
  });

  await redis.hset(keys.eventState(eventId), "status", "between_questions");
  await redis.del(keys.roundAnswers(roundId));
}
