import type { IntegrityReport } from './integrity-report.js';
import type { ResearchEvent } from './research-event.js';
import type { ResearchOutcome } from './research-outcome.js';
import type { ResearchStrategy } from './research-strategy.js';

export type RepProtocol = 'rep-a2a';
export type RepMessageType = 'hello' | 'publish' | 'fetch' | 'report' | 'review' | 'revoke';
export type RepAssetType = 'strategy' | 'outcome' | 'integrity_report';

export interface RepSignature {
  algorithm?: 'hmac-sha256' | 'none';
  value?: string;
  key_id?: string;
}

export interface HelloPayload {
  capabilities: string[];
  domain: string;
  agent_name?: string;
  agent_version?: string;
  supported_check_domains?: string[];
}

export interface PublishPayload {
  asset_type: RepAssetType;
  asset: ResearchStrategy | ResearchOutcome | IntegrityReport;
  rdi_gate_result?: {
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; message?: string }>;
  };
  revision_of?: {
    original_asset_id: string;
    review_message_id?: string;
  };
}

export interface FetchPayload {
  asset_type: RepAssetType;
  filters?: {
    domain?: string;
    preset?: string;
    status?: string;
    min_rdi_rank?: number;
    since?: string;
  };
  limit?: number;
}

export interface ReportPayload {
  event: ResearchEvent;
}

export interface ReviewPayload {
  target_asset_id: string;
  decision: 'approve' | 'reject' | 'revise';
  review_comments?: string;
  reviewer_id?: string;
  integrity_report_ref?: string;
}

export interface RevokePayload {
  target_asset_id: string;
  reason: string;
  superseded_by?: string;
}

export type RepAssetByType = {
  strategy: ResearchStrategy;
  outcome: ResearchOutcome;
  integrity_report: IntegrityReport;
};

export interface RepEnvelopePayloadMap {
  hello: HelloPayload;
  publish: PublishPayload;
  fetch: FetchPayload;
  report: ReportPayload;
  review: ReviewPayload;
  revoke: RevokePayload;
}

export interface BaseRepEnvelope<TType extends RepMessageType, TPayload> {
  protocol: RepProtocol;
  protocol_version: string;
  message_type: TType;
  message_id: string;
  sender_id: string;
  recipient_id?: string;
  timestamp: string;
  content_hash?: string;
  payload: TPayload;
  signature?: RepSignature;
  trace_id?: string;
}

export type RepEnvelopeByType = {
  [TType in RepMessageType]: BaseRepEnvelope<TType, RepEnvelopePayloadMap[TType]>;
};

export type RepEnvelope = RepEnvelopeByType[RepMessageType];
