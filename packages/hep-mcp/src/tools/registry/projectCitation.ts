import { invalidParams, HEP_RUN_BUILD_CITATION_MAPPING } from '@autoresearch/shared';
import { getRun, updateRunManifestAtomic, type RunArtifactRef, type RunManifest } from '../../core/runs.js';
import { buildAllowedCitationsArtifact, buildCitekeyToInspireStats, writeRunJsonArtifact } from '../../core/citations.js';
import type { ToolSpec } from './types.js';
import { HepRunBuildCitationMappingToolSchema } from './projectSchemas.js';

export const RAW_PROJECT_CITATION_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  {
    name: HEP_RUN_BUILD_CITATION_MAPPING,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build bibliography→INSPIRE mapping artifacts for a run (runs locally; uses INSPIRE network) and write `bibliography_raw_v1.json`, `citekey_to_inspire_v1.json`, `allowed_citations_v1.json` (Evidence-first URIs + summary).',
    zodSchema: HepRunBuildCitationMappingToolSchema,
    handler: async params => {
      const run = getRun(params.run_id);

      const stepName = 'citation_mapping';
      const startedAt = new Date().toISOString();
      const toolInfo = {
        name: HEP_RUN_BUILD_CITATION_MAPPING,
        args: { run_id: params.run_id, identifier: params.identifier },
      };

      const computeRunStatus = (manifest: { steps: Array<{ status?: string }> }): RunManifest['status'] => {
        const statuses = manifest.steps.map(s => s.status);
        if (statuses.includes('failed')) return 'failed';
        if (statuses.includes('pending') || statuses.includes('in_progress')) return 'running';
        return 'done';
      };

      await updateRunManifestAtomic({
        run_id: params.run_id,
        tool: toolInfo,
        update: current => {
          const step = { step: stepName, status: 'in_progress' as const, started_at: startedAt };
          const next = { ...current, updated_at: startedAt, steps: [...current.steps, step] };
          return { ...next, status: computeRunStatus(next) };
        },
      });

      const artifacts: RunArtifactRef[] = [];

      try {
        const { extractBibliography } = await import('../research/extractBibliography.js');
        const bib = await extractBibliography({ identifier: params.identifier });

        const { mapBibEntriesToInspire } = await import('../research/latex/citekeyMapper.js');
        const mappings = await mapBibEntriesToInspire(bib.entries);

        const bibliographyRaw = {
          version: 1 as const,
          generated_at: startedAt,
          source: {
            identifier: params.identifier,
            arxiv_id: bib.arxiv_id,
            source_file: bib.source_file,
          },
          entries: bib.entries,
        };

        const citekeyToInspire = {
          version: 1 as const,
          generated_at: startedAt,
          mappings,
          stats: buildCitekeyToInspireStats(mappings),
        };

        const secondary = Object.values(mappings).flatMap(m => (m.status === 'matched' && m.recid ? [m.recid] : []));

        const allowedCitations = buildAllowedCitationsArtifact({
          include_mapped_references: params.include_mapped_references,
          allowed_citations_primary: params.allowed_citations_primary,
          allowed_citations_secondary: secondary,
        });

        const bibliographyRef = writeRunJsonArtifact(params.run_id, 'bibliography_raw_v1.json', bibliographyRaw);
        const mappingRef = writeRunJsonArtifact(params.run_id, 'citekey_to_inspire_v1.json', citekeyToInspire);
        const allowedRef = writeRunJsonArtifact(params.run_id, 'allowed_citations_v1.json', allowedCitations);

        artifacts.push(bibliographyRef, mappingRef, allowedRef);

        const completedAt = new Date().toISOString();
        await updateRunManifestAtomic({
          run_id: params.run_id,
          tool: toolInfo,
          update: current => {
            const idx = current.steps.findIndex(s => s.step === stepName && s.started_at === startedAt);
            if (idx < 0) {
              throw invalidParams('Internal: unable to locate citation_mapping run step (fail-fast)', {
                run_id: params.run_id,
                step: stepName,
                started_at: startedAt,
              });
            }
            const byName = new Map<string, RunArtifactRef>();
            for (const a of current.steps[idx]?.artifacts ?? []) byName.set(a.name, a);
            for (const a of artifacts) byName.set(a.name, a);
            const merged = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

            const step = {
              ...current.steps[idx],
              status: 'done' as const,
              completed_at: completedAt,
              artifacts: merged,
            };
            const next = {
              ...current,
              updated_at: completedAt,
              steps: current.steps.map((s, i) => (i === idx ? step : s)),
            };
            return { ...next, status: computeRunStatus(next) };
          },
        });

        return {
          run_id: params.run_id,
          project_id: run.project_id,
          manifest_uri: `hep://runs/${encodeURIComponent(params.run_id)}/manifest`,
          artifacts,
          summary: {
            bibliography_entries: bib.total,
            mapped_matched: citekeyToInspire.stats.matched,
            mapped_not_found: citekeyToInspire.stats.not_found,
            mapped_errors: citekeyToInspire.stats.errors,
            match_methods: citekeyToInspire.stats.by_method,
            include_mapped_references: params.include_mapped_references,
            allowed_primary: allowedCitations.allowed_citations_primary.length,
            allowed_secondary: allowedCitations.allowed_citations_secondary.length,
            allowed_total: allowedCitations.allowed_citations.length,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          const failedAt = new Date().toISOString();
          await updateRunManifestAtomic({
            run_id: params.run_id,
            tool: toolInfo,
            update: current => {
              const idx = current.steps.findIndex(s => s.step === stepName && s.started_at === startedAt);
              if (idx < 0) return current;
              const byName = new Map<string, RunArtifactRef>();
              for (const a of current.steps[idx]?.artifacts ?? []) byName.set(a.name, a);
              for (const a of artifacts) byName.set(a.name, a);
              const merged = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

              const step = {
                ...current.steps[idx],
                status: 'failed' as const,
                completed_at: failedAt,
                artifacts: merged,
                notes: message,
              };
              const next = {
                ...current,
                updated_at: failedAt,
                steps: current.steps.map((s, i) => (i === idx ? step : s)),
              };
              return { ...next, status: computeRunStatus(next) };
            },
          });
        } catch {
          // ignore secondary failures
        }
        throw err;
      }
    },
  },
];
