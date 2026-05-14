import Redis from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:6379";

export const redis = new Redis(url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export const pubClient = new Redis(url);
export const subClient = pubClient.duplicate();

redis.on("error", (err) => console.error("[redis] error:", err.message));
redis.on("connect", () => console.log("[redis] connected"));

export const keys = {
  eventState: (eventId) => `event:${eventId}:state`,
  roundAnswers: (roundId) => `round:${roundId}:answers`,
  roundMeta: (roundId) => `round:${roundId}:meta`,
  pinToEvent: (pin) => `pin:${pin}`,
  playerSocket: (eventId, playerId) => `event:${eventId}:player:${playerId}:socket`,
};
