/**
 * Gate result returned by all gate checks.
 */
export interface GateResult {
  ok: boolean;
  gateId: string;
  reason?: string;
  fixHint?: string;
  missing?: string[];
}
