import { randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import type { ActorContext } from "@ai-office-suite/shared-contracts";
import { assertPolicyAllowed } from "@ai-office-suite/authorization";
import { DataPreparationPipeline, profileDataset, stageCsvSource } from "@ai-office-suite/data-processing";
import { dataPrepStageProfileSchema } from "@ai-office-suite/validation";
import type { DocumentGateway } from "../documentGateway.ts";
import type { ConcurrencyGate } from "./documentRoutes.ts";

export interface DataPrepRoutesDeps {
  gateway: DocumentGateway;
  getActor: (req: Request) => ActorContext;
  dataPrepGate: ConcurrencyGate;
}

export function registerDataPrepRoutes(app: Express, deps: DataPrepRoutesDeps): void {
  const { gateway, getActor, dataPrepGate } = deps;

  app.post("/api/data-prep/stage-and-profile", async (req, res, next) => {
    const release = dataPrepGate.tryAcquire();
    if (!release) {
      res.setHeader("Retry-After", "2");
      res.status(503).json({
        error: "Data preparation workers are currently at capacity. Please retry shortly.",
        code: "SERVICE_BUSY",
        retryAfterSeconds: 2,
      });
      return;
    }
    try {
      const actor = getActor(req);
      assertPolicyAllowed({
        actor,
        resourceTenantId: actor.tenantId,
        resourceWorkspaceId: actor.workspaceId,
        resource: "document",
        action: "write",
        source: "manual",
        ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
      });
      const parsed = dataPrepStageProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid data-prep staging payload", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }

      const staged = stageCsvSource(parsed.data.csvText, parsed.data.filename, {
        delimiter: parsed.data.delimiter ?? "auto",
        maxRows: 50_000,
      });
      // Yield to event loop between heavy CSV staging and profiling/recipe execution (H17)
      await new Promise<void>((resolve) => setImmediate(resolve));

      const profile = profileDataset(staged.source.sourceId, staged.rows, {
        scope: parsed.data.profileScope,
        sampleSize: parsed.data.sampleSize,
      });

      let dryRunArtifact: {
        status: string;
        outputSha256: string;
        reconciliation: unknown;
        exceptionCount: number;
        sampleRows: Array<Record<string, unknown>>;
      } | null = null;

      if (parsed.data.steps && parsed.data.steps.length > 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const expectedColumns =
          parsed.data.expectedColumns && parsed.data.expectedColumns.length > 0
            ? parsed.data.expectedColumns
            : staged.source.columnNames;
        const sandboxPipeline = new DataPreparationPipeline();
        const artifact = sandboxPipeline.executeRecipe({
          actor,
          recipe: {
            recipeId: `sandbox_${randomUUID().slice(0, 8)}`,
            version: 1,
            tenantId: actor.tenantId,
            workspaceId: actor.workspaceId,
            pinnedInputSha256s: [staged.source.sha256],
            idempotencyKey: `idem_${randomUUID()}`,
            steps: parsed.data.steps,
          },
          salesSources: [staged],
          expectedColumns,
        });
        dryRunArtifact = {
          status: artifact.status,
          outputSha256: artifact.outputSha256,
          reconciliation: artifact.reconciliation,
          exceptionCount: artifact.exceptions.length,
          sampleRows: artifact.rows.slice(0, 50),
        };
      }

      await gateway.recordAudit(actor, {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "import",
        action: "data_prep.stage_and_profile",
        outcome: "success",
        targetType: "data_prep",
        summary: `Staged '${parsed.data.filename}' (${staged.source.acceptedRows} accepted, ${staged.source.rejectedRows} rejected).`,
      });

      res.json({
        source: staged.source,
        profile,
        rejects: staged.rejects.slice(0, 50),
        sampleRows: staged.rows.slice(0, 50),
        dryRun: dryRunArtifact,
      });
    } catch (err) {
      next(err);
    } finally {
      release();
    }
  });
}
