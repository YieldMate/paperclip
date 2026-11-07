export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  /**
   * True failures for the day, excluding process-loss/restart kills that were
   * later recovered by a successful retry (those are surfaced in `recovered`).
   */
  failed: number;
  /**
   * Runs that terminated as failed, timed_out, or interrupted (shutdown) but
   * whose retry chain eventually succeeded — e.g. restart-killed runs and
   * shutdown interrupts that recovered. Kept out of `failed` so the headline
   * failure count reflects true, unrecovered failures.
   */
  recovered: number;
  other: number;
  total: number;
  /**
   * Per-error-code breakdown of the (true) `failed` count for the day, so a
   * spike can be attributed to an error class (e.g. `process_lost`,
   * `provider_quota`, `workspace_validation_failed`). Recovered runs are not
   * included here. Runs with no error code are bucketed under `unknown`.
   */
  failedByErrorCode: Record<string, number>;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    /** Known / priced ledger sum for the UTC month (unpriced rows contribute $0). */
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
    /** Metered events with cost_status=unpriced in the UTC month (same definition as CostSummary). */
    unpricedEventCount: number;
    /** Terminal runs still awaiting cost accounting in the UTC month. */
    pendingRunCount: number;
    /** True when unpricedEventCount === 0 and pendingRunCount === 0. */
    pricingComplete: boolean;
    /** Events with billing_type=unknown in the UTC month. */
    unknownBillingEventCount?: number;
    /**
     * Net Nous Portal spend for the UTC month when a Portal CSV/API import exists.
     * Null when no Portal import has been recorded — do not treat as $0.
     */
    portalMonthSpendCents?: number | null;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
}
