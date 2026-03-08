/**
 * Unified Z-score thresholds for anomaly detection across all subsystems.
 * Single source of truth — all modules should import from here.
 */
export const ANOMALY_THRESHOLDS = {
  /** Z > 2.5: Record anomaly, no action */
  NOTICE: 2.5,
  /** Z > 3.0: Trigger circuit-breaker adjustment */
  WARNING: 3.0,
  /** Z > 3.5: Kill-switch → RESTRICTED mode */
  RESTRICTED: 3.5,
  /** Z > 4.5: Kill-switch → EMERGENCY mode */
  EMERGENCY: 4.5,
} as const;
