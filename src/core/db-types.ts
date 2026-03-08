/** Row interfaces for all SQLite tables — matches schema in database.ts */

export interface NarrativeRow {
  id: number;
  timestamp: string;
  type: string;
  summary: string;
  emotion: string | null;
  significance: number;
  related_to: string | null;
  data: string | null;
  created_at: string;
}

export interface AuditChainRow {
  idx: number;
  timestamp: string;
  type: string;
  prev_hash: string;
  payload: string;
  merkle_root: string | null;
  hash: string;
}

export interface WitnessRow {
  id: number;
  timestamp: string;
  merkle_root: string;
  chain_tip: string;
  chain_length: number;
  state: string;
  audit_log_hash: string | null;
  narrative_hash: string | null;
}

export interface TransitionRow {
  idx: number;
  timestamp: string;
  from_state: string;
  to_state: string;
  reason: string;
  duration_ms: number;
  context: string;
  prev_hash: string;
  hash: string;
  vector_clock: string | null;
}

export interface AnomalyRow {
  id: number;
  timestamp: string;
  state: string;
  anomalies: string;
}

export interface AgentTaskRow {
  id: string;
  agent_name: string;
  prompt: string;
  status: string;
  priority: number;
  source: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  worker_id: number | null;
  result: string | null;
  error: string | null;
  cost_usd: number;
  duration: number | null;
  confidence: number | null;
  trace_summary: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  parent_task_id: string | null;
  chain_depth: number;
  retry_count: number;
  retry_after: string | null;
  depends_on: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  trace: string | null;
  metadata: string | null;
  origin_agent: string | null;
}

export interface AgentReportRow {
  id: number;
  timestamp: string;
  agent_name: string;
  task_id: string | null;
  prompt: string | null;
  result: string | null;
  cost_usd: number;
  duration: number | null;
  confidence: number | null;
  trace_summary: string | null;
  metadata: string | null;
}

export interface UserRow {
  id: number;
  name: string;
  username: string;
  first_seen: string;
  last_seen: string;
  message_count: number;
  facts: string;
  preferences: string;
  activity_hours: string;
}

export interface DailyMetricsRow {
  date: string;
  messages: string;
  agents: string;
  evolution: string;
  performance: string;
  lifecycle: string;
  cost: string;
}

export interface SchemaVersionRow {
  version: number;
  applied_at: string;
}
