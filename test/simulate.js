import { io } from "socket.io-client";

const SERVER = process.env.SERVER || "http://localhost:3000";
const USER_ID = process.env.USER_ID;
const QUIZ_ID = process.env.QUIZ_ID;

if (!USER_ID || !QUIZ_ID) {
  console.error("Set USER_ID and QUIZ_ID env vars (from `npm run seed` output)");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (who, ...args) => console.log(`[${who}]`, ...args);

async function main() {
  log("setup", "creating event via HTTP");
  const res = await fetch(`${SERVER}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: USER_ID, quizId: QUIZ_ID }),
  });
  const { event, hostToken } = await res.json();
  log("setup", `event ${event.id} pin=${event.pin}`);

  const host = io(`${SERVER}/host`, { auth: { token: hostToken } });
  await new Promise((r) => host.on("connect", r));
  log("host", "connected");

  const syncData = await new Promise((r) => host.emit("event:sync", {}, r));
  const questions = syncData.event.quiz.questions;
  log("host", `synced ${questions.length} questions`);

  host.on("lobby:player_joined", ({ nickname }) => log("host", `+ ${nickname} joined`));
  host.on("answers:progress", ({ count, total }) =>
    log("host", `answers ${count}/${total}`)
  );
  host.on("round:closed", ({ leaderboard }) => {
    log("host", "leaderboard:");
    leaderboard.forEach((p, i) =>
      log("host", `  ${i + 1}. ${p.nickname} — ${p.totalScore} pts`)
    );
  });

  const playerNicks = ["Marine", "Théo", "Sofia"];
  const players = [];
  for (const nick of playerNicks) {
    const sock = io(`${SERVER}/player`);
    await new Promise((r) => sock.on("connect", r));
    const joinRes = await new Promise((r) =>
      sock.emit("player:join", { pin: event.pin, nickname: nick }, r)
    );
    if (!joinRes.ok) throw new Error(`${nick} join failed: ${joinRes.error}`);
    log(nick, `joined playerId=${joinRes.playerId.slice(0, 8)}`);
    players.push({ nick, sock, playerId: joinRes.playerId, token: joinRes.token });
  }

  for (const p of players) {
    p.sock.on("question:shown", async ({ roundId, options, type }) => {
      const strategy = {
        Marine: 0.9,
        Théo: 0.65,
        Sofia: 0.4,
      }[p.nick];
      const willBeCorrect = Math.random() < strategy;
      const delayMs = 500 + Math.random() * 4000;
      await sleep(delayMs);

      p.sock.emit("answer:submit", { roundId, choiceIndex: willBeCorrect ? -1 : 99 }, async (res) => {
        if (!res.ok && res.reason === "already_answered") return;
      });
    });

    p.sock.on("round:reveal", ({ yourCorrect, yourPoints, totalScore, rank }) => {
      log(p.nick, `${yourCorrect ? "correct" : "wrong"} +${yourPoints} (total ${totalScore}, rank ${rank})`);
    });
  }

  await sleep(1500);

  for (const q of questions) {
    log("host", `\n=== launching Q${q.position + 1}: ${q.prompt.slice(0, 50)}...`);
    const launchRes = await new Promise((r) =>
      host.emit("question:launch", { questionId: q.id }, r)
    );
    const roundId = launchRes.roundId;

    for (const p of players) {
      p.sock.removeAllListeners("question:shown");
      p.sock.on("question:shown", async ({ roundId: rId, options }) => {
        const strategy = { Marine: 0.9, Théo: 0.65, Sofia: 0.4 }[p.nick];
        const willBeCorrect = Math.random() < strategy;
        const correctIdx = q.correctIndex;
        const wrongIdx = (correctIdx + 1) % options.length;
        const choice = willBeCorrect ? correctIdx : wrongIdx;
        const delayMs = 500 + Math.random() * (q.timeLimit * 1000 * 0.6);
        await sleep(delayMs);
        p.sock.emit("answer:submit", { roundId: rId, choiceIndex: choice });
      });
    }

    await sleep((q.timeLimit + 2) * 1000);
  }

  log("host", "\nending event");
  await new Promise((r) => host.emit("event:end", {}, r));

  await sleep(500);
  host.close();
  players.forEach((p) => p.sock.close());
  log("setup", "done");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
