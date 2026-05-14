import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export function signHostToken(userId, eventId) {
  return jwt.sign({ userId, eventId, role: "host" }, SECRET, { expiresIn: "6h" });
}

export function signPlayerToken(playerId, eventId) {
  return jwt.sign({ playerId, eventId, role: "player" }, SECRET, { expiresIn: "6h" });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}
