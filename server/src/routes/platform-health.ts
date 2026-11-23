import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  platformHealthApplyDeskTriageSchema,
  platformHealthAutoHealSchema,
  platformHealthDiagnoseConnectorSchema,
  platformHealthEnsureMedicSchema,
  platformHealthProbeConnectorSchema,
  platformHealthSettlePendingRunSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { heartbeatService } from "../services/index.js";
import { platformHealthService } from "../services/platform-health.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";

const reconcileBodySchema = z.object({
  dryRun: z.boolean().optional().default(false),
}).default({});

export function platformHealthRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const health = platformHealthService(db, {
    cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
    wakeupAgent: async (input) => {
      const payload: Record<string, unknown> = {};
      if (input.issueId) payload.issueId = input.issueId;
      if (input.recoveryActionId) payload.recoveryActionId = input.recoveryActionId;
      if (input.reason === "issue_recovery_action_restored") {
        payload.mutation = "recovery_action_resolution";
      }
      return heartbeat.wakeup(input.agentId, {
        failedRunId: input.failedRunId ?? null,
        source: input.source,
        triggerDetail: input.triggerDetail,
        reason: input.reason,
        payload: Object.keys(payload).length > 0 ? payload : null,
        requestedByActorType: "user",
        requestedByActorId: input.requestedByUserId,
        contextSnapshot: {
          triggeredBy: "board",
          responsibleUserId: input.requestedByUserId,
          actorId: input.requestedByUserId,
          platformHealthDeskTriage: true,
        },
      });
    },
  });

  function assertOpsAccess(req: Parameters<typeof assertCompanyAccess>[0], companyId: string) {
    assertBoardOrAgent(req);
    assertCompanyAccess(req, companyId);
  }

  function actorId(req: Parameters<typeof getActorInfo>[0]) {
    const info = getActorInfo(req);
    return info.actorId || (req.actor.type === "agent" ? req.actor.agentId ?? "agent" : "board");
  }

  router.get("/companies/:companyId/ops/health/snapshot", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertOpsAccess(req, companyId);
    const pendingAgeMinutes = req.query.pendingAgeMinutes != null
      ? Number(req.query.pendingAgeMinutes)
      : undefined;
    const resumingAgeMinutes = req.query.resumingAgeMinutes != null
      ? Number(req.query.resumingAgeMinutes)
      : undefined;
    res.json(await health.getHealthSnapshot(companyId, {
      pendingAgeMinutes: Number.isFinite(pendingAgeMinutes) ? pendingAgeMinutes : undefined,
      resumingAgeMinutes: Number.isFinite(resumingAgeMinutes) ? resumingAgeMinutes : undefined,
    }));
  });

  router.post(
    "/companies/:companyId/ops/accounting/settle-pending-run",
    validate(platformHealthSettlePendingRunSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertOpsAccess(req, companyId);
      res.json(await health.settlePendingRun(companyId, req.body, actorId(req)));
    },
  );

  router.post(
    "/companies/:companyId/ops/agents/:agentId/reconcile-and-resume",
    validate(reconcileBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertOpsAccess(req, companyId);
      res.json(await health.reconcileAndResume(companyId, {
        agentId,
        dryRun: req.body.dryRun ?? false,
      }, actorId(req)));
    },
  );

  router.post(
    "/companies/:companyId/ops/health/auto-heal",
    validate(platformHealthAutoHealSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertOpsAccess(req, companyId);
      res.json(await health.autoHeal(companyId, req.body, actorId(req)));
    },
  );

  router.post(
    "/companies/:companyId/ops/medic/ensure",
    validate(platformHealthEnsureMedicSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const result = await health.ensureMedicAgent(
        companyId,
        req.body,
        req.actor.userId ?? getActorInfo(req).actorId,
      );
      res.status(result.created && !result.dryRun ? 201 : 200).json(result);
    },
  );

  router.get("/companies/:companyId/ops/health/desk-triage", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertOpsAccess(req, companyId);
    res.json(await health.proposeDeskActions(companyId));
  });

  router.post(
    "/companies/:companyId/ops/health/apply-desk-triage",
    validate(platformHealthApplyDeskTriageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertOpsAccess(req, companyId);
      res.json(await health.applyDeskTriage(companyId, req.body, actorId(req)));
    },
  );

  router.get("/companies/:companyId/ops/health/connectors", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertOpsAccess(req, companyId);
    const intervalRaw = req.query.connectorCheckIntervalSec != null
      ? Number(req.query.connectorCheckIntervalSec)
      : undefined;
    const findings = await health.listConnectorFindings(companyId, {
      connectorCheckIntervalSec: Number.isFinite(intervalRaw) ? intervalRaw : undefined,
    });
    res.json({
      companyId,
      checkedAt: new Date().toISOString(),
      empty: findings.length === 0,
      reportDue: findings.some((f) => f.reportDue),
      findings,
    });
  });

  router.post(
    "/companies/:companyId/ops/health/connectors/probe",
    validate(platformHealthProbeConnectorSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertOpsAccess(req, companyId);
      res.json(await health.probeConnector(companyId, req.body, actorId(req)));
    },
  );

  router.post(
    "/companies/:companyId/ops/health/connectors/diagnose",
    validate(platformHealthDiagnoseConnectorSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertOpsAccess(req, companyId);
      res.json(await health.diagnoseConnector(companyId, req.body, actorId(req)));
    },
  );

  const acknowledgeBodySchema = z.object({
    fingerprints: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  }).default({});

  router.post(
    "/companies/:companyId/ops/health/connectors/acknowledge",
    validate(acknowledgeBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertOpsAccess(req, companyId);
      res.json(await health.acknowledgeConnectorFindings(
        companyId,
        actorId(req),
        req.body.fingerprints,
      ));
    },
  );

  return router;
}
