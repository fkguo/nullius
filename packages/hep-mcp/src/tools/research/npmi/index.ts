/**
 * NPMI Distance Matrix Module
 * Exports for measuring semantic distance between arXiv categories
 */

export {
  HEP_CATEGORIES,
  CATEGORY_GROUPS,
  SPECIFIC_DISTANCES,
  GROUP_DISTANCES,
  getCategoryGroup,
  type HEPCategory,
} from './categories.js';

export {
  buildMatrix,
  loadMatrix,
  getDistance,
  isMatrixLoaded,
  getMatrixStats,
  type MatrixData,
  type BuildProgress,
  type MatrixStats,
} from './distanceMatrix.js';

export {
  calculateRaoStirling,
  type RaoStirlingResult,
  type InterpretationType,
} from './raoStirling.js';
