import { PgBoss } from 'pg-boss';
let bossPromise: Promise<PgBoss> | undefined;
export function queue() {
  if (!bossPromise) bossPromise = (async () => {
    const boss = new PgBoss(process.env.DATABASE_URL!);
    boss.on('error', () => {});
    await boss.start();
    await boss.createQueue('ai-operation');
    return boss;
  })();
  return bossPromise;
}
