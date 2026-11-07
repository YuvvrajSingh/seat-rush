import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "dotenv";
import {
  ALL_SEAT_LABELS, SCREENING_DURATION_MINUTES, SEAT_PRICE_PAISE,
} from "@seatrush/shared";
import { createPrismaClient, type PrismaClient } from "./client.js";

export async function seedDemo(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO screenings (demo_key, title, starts_at, duration_minutes, seat_price_paise)
      VALUES ('demo-screening', 'SeatRush: Opening Night', now() + interval '1 day',
        ${SCREENING_DURATION_MINUTES}, ${SEAT_PRICE_PAISE})
      ON CONFLICT (demo_key) DO UPDATE SET
        starts_at = CASE WHEN screenings.starts_at <= now() THEN now() + interval '1 day' ELSE screenings.starts_at END
    `;
    const screening = await tx.screening.findUniqueOrThrow({ where: { demoKey: "demo-screening" } });
    await tx.seat.createMany({
      data: ALL_SEAT_LABELS.map((label) => ({
        screeningId: screening.id, label, row: label.charAt(0), number: Number(label.slice(1)),
      })),
      skipDuplicates: true,
    });
    await tx.identity.createMany({
      data: [
        ...Array.from({ length: 1_050 }, (_, i) => ({
          demoKey: `customer-${String(i + 1).padStart(4, "0")}`,
          displayName: `Demo Customer ${i + 1}`, role: "customer",
        })),
        { demoKey: "operator", displayName: "Demo Operator", role: "operator" },
      ],
      skipDuplicates: true,
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const prisma = createPrismaClient(databaseUrl);
  try {
    await seedDemo(prisma);
    const [screenings, seats, customers, operators] = await Promise.all([
      prisma.screening.count(), prisma.seat.count(),
      prisma.identity.count({ where: { role: "customer" } }),
      prisma.identity.count({ where: { role: "operator" } }),
    ]);
    console.log(JSON.stringify({ screenings, seats, customers, operators }));
  } finally {
    await prisma.$disconnect();
  }
}
