import type { Express, Request } from "express";
import type { ActorContext } from "@ai-office-suite/shared-contracts";
import { assertPolicyAllowed } from "@ai-office-suite/authorization";
import { getSpeechAdapter } from "@ai-office-suite/speech-engine";
import {
  aiApplyRequestSchema,
  aiPlanRequestSchema,
  speechTranscribeRequestSchema,
} from "@ai-office-suite/validation";
import type { DocumentGateway } from "../documentGateway.ts";
import { isValidDocumentIdParam } from "./documentRoutes.ts";

export interface AiAndSpeechRoutesDeps {
  gateway: DocumentGateway;
  getActor: (req: Request) => ActorContext;
}

export function registerAiAndSpeechRoutes(app: Express, deps: AiAndSpeechRoutesDeps): void {
  const { gateway, getActor } = deps;

  app.post("/api/documents/:id/ai/plan", async (req, res, next) => {
    try {
      if (!isValidDocumentIdParam(req.params.id)) {
        res.status(400).json({ error: "Invalid document id parameter", code: "INVALID_DOCUMENT_ID" });
        return;
      }
      const actor = getActor(req);
      const parsed = aiPlanRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI plan request", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      const proposal = await gateway.planAiOperation(actor, req.params.id, parsed.data);
      res.json({ proposal });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/documents/:id/ai/apply", async (req, res, next) => {
    try {
      if (!isValidDocumentIdParam(req.params.id)) {
        res.status(400).json({ error: "Invalid document id parameter", code: "INVALID_DOCUMENT_ID" });
        return;
      }
      const actor = getActor(req);
      const parsed = aiApplyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI apply request", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      if (parsed.data.proposal.documentId !== req.params.id) {
        res.status(400).json({ error: "Proposal documentId mismatch", code: "DOCUMENT_MISMATCH" });
        return;
      }
      const result = await gateway.applyAiOperation(
        actor,
        req.params.id,
        parsed.data.proposal,
        parsed.data.approved,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/speech/transcribe", async (req, res, next) => {
    try {
      const actor = getActor(req);
      assertPolicyAllowed({
        actor,
        resourceTenantId: actor.tenantId,
        resourceWorkspaceId: actor.workspaceId,
        resource: "speech",
        action: "transcribe",
        source: "voice_command",
        ...(actor.workspaceVisibility ? { workspaceVisibility: actor.workspaceVisibility } : {}),
      });
      const parsed = speechTranscribeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid speech request", code: "VALIDATION_ERROR", issues: parsed.error.issues });
        return;
      }
      const adapter = getSpeechAdapter(parsed.data.provider);
      const result = await adapter.transcribe(parsed.data);
      await gateway.recordAudit(actor, {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        actorRole: actor.role,
        source: "voice_command",
        action: "speech.transcribed",
        outcome: "success",
        targetType: "speech",
        summary: `Speech transcription via '${parsed.data.provider}' (${parsed.data.language}, isMock=${String(result.isMock)})`,
      });
      res.json({ recognition: result });
    } catch (err) {
      next(err);
    }
  });
}
