export type BoundaryAction = 'allow' | 'review' | 'confirm' | 'deny';

export type BoundaryRisk = 'low' | 'medium' | 'high';

export interface BoundaryOperation {
  tool: string;
  input: unknown;
}

export interface BoundaryContext {
  workspace: string;
}

export interface BoundaryDecision {
  action: BoundaryAction;
  risk: BoundaryRisk;
  reasons: string[];
  normalizedScope: string[];
  fingerprint: string;
}
