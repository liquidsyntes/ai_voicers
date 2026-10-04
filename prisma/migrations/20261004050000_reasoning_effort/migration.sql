ALTER TABLE "Settings" ADD COLUMN "defaultReasoningEffort" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "Cycle" ADD COLUMN "reasoningEffort" TEXT NOT NULL DEFAULT 'auto';
UPDATE "Settings" SET "defaultReasoningEffort" = 'low' WHERE "defaultModel" = 'z-ai/glm-5.3-flash';
