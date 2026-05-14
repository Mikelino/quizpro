# QuizPro — Real-time quiz server

Event-driven quiz/blind test platform for pro events. Server-authoritative scoring, Redis-backed live state, Socket.IO over WebSockets.

## Stack

- Node.js 20+ (ESM)
- Socket.IO 4 with Redis adapter
- Postgres 15 (via Prisma)
- Redis 7

## Quick start

```bash
cp .env.example .env
docker-compose up -d
npm install
npm run db:generate
npm run db:push
npm run seed
```

The seed script prints `USER_ID` and `QUIZ_ID` — copy them.

## Run the server

```bash
npm run dev
```

## Simulate a full event (host + 3 players)

In a separate terminal, with the env vars from the seed output:

```bash
USER_ID=... QUIZ_ID=... npm run test:simulate
```

The simulator creates an event via HTTP, connects a host socket and three player sockets, plays all four questions with randomized correctness/timing, and dumps the leaderboard after each round.

## Architecture

- `src/server.js` — HTTP + Socket.IO bootstrap
- `src/namespaces/host.js` — `/host` namespace (JWT-authenticated)
- `src/namespaces/player.js` — `/player` namespace with reconnect support
- `src/services/roundService.js` — round lifecycle (launch → tick → submit → close → reveal)
- `src/lib/*` — Redis, Prisma, auth, scoring helpers
- `prisma/schema.prisma` — data model
- `prisma/seed.js` — demo data
- `test/simulate.js` — end-to-end simulation

## Key design decisions

**Server-authoritative timing.** `time_ms` for every answer is computed server-side from the `launched_at` timestamp stored in Redis — clients cannot spoof speed.

**Redis hot path, Postgres cold path.** Live answers accumulate in `round:{id}:answers` as a hash, never hitting Postgres until the round closes. One transactional write at close time persists everything.

**Reconnect via JWT.** Players get a token on join (stored client-side). `player:reconnect` with that token restores full state including the current question, seconds left, and whether they already answered.

**Blind test = QCM + host_notes.** Since audio comes from the host's mixing console, there is no audio streaming layer. The only difference between a QCM and a blind test is the `host_notes` jsonb field (title/artist/cue) that the server never broadcasts to players.

## Next steps

- Frontend (Next.js) consuming these sockets
- Team mode (players in groups, scores aggregated)
- Open-answer matching (Levenshtein with accent normalization)
- CSV export of event results
- Admin dashboard for quiz library
