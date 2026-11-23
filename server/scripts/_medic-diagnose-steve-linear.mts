/**
 * One-shot: diagnose Steve × Linear via platform-health service against local DB.
 */
import { createDb } from "@paperclipai/db";
import { platformHealthService } from "../src/services/platform-health.ts";

const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const db = createDb("postgres://paperclip:GrahamInHK2025@localhost:5432/paperclip");
const health = platformHealthService(db);

const snapshot = await health.getHealthSnapshot(COMPANY);
console.log(JSON.stringify({
  empty: snapshot.empty,
  connectorEmpty: snapshot.connectorEmpty,
  connectorReportDue: snapshot.connectorReportDue,
  connectorFindings: snapshot.connectorFindings,
  findingCount: snapshot.counts.findings,
}, null, 2));

const report = await health.diagnoseConnector(COMPANY, {
  agentName: "Steve",
  applicationKey: "linear",
  probe: true,
}, "operator-diagnose");
console.log(JSON.stringify({
  verdict: report.verdict,
  likelyCause: report.likelyCause,
  connection: report.connection,
  agent: report.agent,
  agentInstallPresent: report.agentInstallPresent,
  agentAccess: report.agentAccess
    ? {
      toolCount: report.agentAccess.toolCount,
      allowedCount: report.agentAccess.allowedCount,
      askFirstCount: report.agentAccess.askFirstCount,
      offCount: report.agentAccess.offCount,
    }
    : null,
  agentAccessError: report.agentAccessError,
  probe: report.probe
    ? {
      healthStatus: report.probe.healthStatus,
      healthMessage: report.probe.healthMessage,
      attention: report.probe.attention,
      probeError: report.probe.probeError,
    }
    : null,
  installs: report.installs,
  grants: report.grants,
}, null, 2));

process.exit(0);
