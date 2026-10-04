ALTER TABLE "Reference" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "cycleId"
    ORDER BY CASE WHEN title ~ '^Отрывок [0-9]+$' THEN substring(title FROM '[0-9]+$')::INTEGER ELSE 1000000 END,
      "createdAt", title, id
  ) AS number
  FROM "Reference"
)
UPDATE "Reference" AS reference SET "position" = ordered.number FROM ordered WHERE reference.id = ordered.id;
