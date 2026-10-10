BEGIN;

-- CreateTable
CREATE TABLE "processed_job" (
    "queue" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "processed_by" TEXT NOT NULL,
    "first_processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duplicate_deliveries" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "processed_job_pkey" PRIMARY KEY ("queue","job_id")
);

COMMIT;
