import type { IntegrityReport } from '../model/integrity-report.js';
import type { ResearchOutcome } from '../model/research-outcome.js';
import type { ResearchStrategy } from '../model/research-strategy.js';
import type { RepAssetByType, RepAssetType } from '../model/rep-envelope.js';
import { hashWithoutField } from '../protocol/content-hash.js';
import { getSchemaValidator, toValidationIssues } from './schema-registry.js';
import { validationFailure, validationSuccess, type ValidationResult } from './result.js';
import type { SchemaName } from './schema-file.js';

const schemaByAssetType: Record<RepAssetType, SchemaName> = {
  strategy: 'research_strategy_v1',
  outcome: 'research_outcome_v1',
  integrity_report: 'integrity_report_v1',
};

function readAssetId(assetType: RepAssetType, asset: ResearchStrategy | ResearchOutcome | IntegrityReport): string {
  if (assetType === 'strategy') {
    return (asset as ResearchStrategy).strategy_id;
  }
  if (assetType === 'outcome') {
    return (asset as ResearchOutcome).outcome_id;
  }
  return (asset as IntegrityReport).report_id;
}

function readAssetIdField(assetType: RepAssetType): string {
  if (assetType === 'strategy') {
    return 'strategy_id';
  }
  if (assetType === 'outcome') {
    return 'outcome_id';
  }
  return 'report_id';
}

export function validateAsset<TAssetType extends RepAssetType>(
  assetType: TAssetType,
  input: unknown,
): ValidationResult<RepAssetByType[TAssetType]> {
  const validator = getSchemaValidator(schemaByAssetType[assetType]);
  if (!validator(input)) {
    return validationFailure(toValidationIssues(validator.errors));
  }

  const asset = input as RepAssetByType[TAssetType];
  const idField = readAssetIdField(assetType);
  const expectedId = hashWithoutField(asset as unknown as Record<string, unknown>, idField);
  const actualId = readAssetId(assetType, asset as ResearchStrategy | ResearchOutcome | IntegrityReport);

  if (actualId !== expectedId) {
    return validationFailure([
      {
        path: `/${idField}`,
        message: `Content-addressed ${idField} does not match the canonical REP hash.`,
      },
    ]);
  }

  return validationSuccess(asset);
}
