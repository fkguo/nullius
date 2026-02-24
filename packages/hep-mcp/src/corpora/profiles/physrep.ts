import type { StyleProfile } from '../style/schemas.js';

export function defaultPhysrepProfile(): StyleProfile {
  return {
    version: 1,
    style_id: 'physrep',
    title: 'Physics Reports',
    description: 'Physics Reports style corpus (HEP-focused stratified sampling)',
    inspire_query: 'j:Phys.Rept.',
    selection: {
      strategy: 'stratified_v1',
      target_categories: ['hep-ph', 'hep-th', 'hep-ex', 'hep-lat', 'nucl-th', 'nucl-ex', 'astro-ph', 'gr-qc'],
      year_bins: [
        { id: 'pre1990', end_year: 1989 },
        { id: '1990s', start_year: 1990, end_year: 1999 },
        { id: '2000s', start_year: 2000, end_year: 2009 },
        { id: '2010s', start_year: 2010, end_year: 2019 },
        { id: '2020s', start_year: 2020 },
      ],
      sort_within_stratum: 'mostcited',
    },
    defaults: {
      target_papers: 200,
    },
  };
}

