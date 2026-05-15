import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where : { email: "host@demo.com" },
    update: {},
    create: { email: "host@demo.com", orgName: "Demo Events Co" },
  });

  await prisma.quiz.deleteMany({ where: { ownerId: user.id } });

  const quiz = await prisma.quiz.create({
    data: {
      ownerId    : user.id,
      title      : "Kickoff Q2 — Mix complet",
      description: "Quiz + blind test + image + vrai/faux + multi + ordre",
      questions  : {
        create: [
          {
            position    : 0,
            type        : "qcm",
            prompt      : "En quelle année l'entreprise a-t-elle été fondée ?",
            options     : ["2008", "2012", "2015", "2019"],
            correctIndex: 1,
            timeLimit   : 15,
            scoringMode : "speed",
          },
          {
            position    : 1,
            type        : "truefalse",
            prompt      : "Notre produit phare est utilisé dans plus de 50 pays.",
            options     : ["Vrai", "Faux"],
            correctIndex: 0,
            timeLimit   : 10,
            scoringMode : "speed",
          },
          {
            position    : 2,
            type        : "blindtest",
            prompt      : "Quel est ce morceau joué à chaque all-hands ?",
            options     : ["Eye of the Tiger", "Don't Stop Me Now", "We Are the Champions", "Thunderstruck"],
            correctIndex: 1,
            hostNotes   : {
              title        : "Don't Stop Me Now",
              artist       : "Queen",
              year         : 1978,
              cueSuggestion: "1:05 — lancer au refrain",
            },
            timeLimit   : 25,
            scoringMode : "speed",
          },
          {
            position    : 3,
            type        : "image",
            prompt      : "Quel collaborateur se cache derrière cet avatar ?",
            options     : ["Julien (CTO)", "Marie (CPO)", "David (CEO)", "Sophie (CFO)"],
            correctIndex: 2,
            hostNotes   : {
              imageUrl: "https://i.pravatar.cc/400?img=12",
            },
            timeLimit   : 20,
            scoringMode : "double",
          },
          {
            position    : 4,
            type        : "qcm",
            prompt      : "Quelle ville accueillera notre prochain séminaire ?",
            options     : ["Lyon", "Bordeaux", "Nantes", "Lille"],
            correctIndex: 0,
            timeLimit   : 15,
            scoringMode : "speed",
          },
          {
            position       : 5,
            type           : "multianswer",
            prompt         : "Quelles sont les valeurs de l'entreprise ? (plusieurs réponses)",
            options        : ["Innovation", "Agilité", "Transparence", "Rentabilité"],
            correctIndex   : null,
            correctIndexes : [0, 1, 2],
            timeLimit      : 25,
            scoringMode    : "standard",
          },
          {
            position    : 6,
            type        : "ordering",
            prompt      : "Remettez les étapes du lancement produit dans le bon ordre.",
            options     : ["Recherche utilisateur", "Prototype", "Tests bêta", "Lancement public"],
            correctIndex: null,
            timeLimit   : 30,
            scoringMode : "standard",
          },
        ],
      },
    },
    include: { questions: true },
  });

  console.log("Seeded user:", user.id);
  console.log("Seeded quiz:", quiz.id, "(" + quiz.questions.length + " questions)");
  console.log("\nUse these in test/simulate.js:");
  console.log(`  USER_ID=${user.id}`);
  console.log(`  QUIZ_ID=${quiz.id}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());