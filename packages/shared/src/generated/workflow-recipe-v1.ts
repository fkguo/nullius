/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
export interface WorkflowRecipeV1 {
  recipe_id: string;
  name: string;
  description: string;
  entry_tool: string;
  /**
   * @minItems 1
   */
  steps: [
    {
      id: string;
      tool: string;
      purpose: string;
      depends_on?: string[];
      params?: {
        [k: string]: unknown;
      };
    },
    ...{
      id: string;
      tool: string;
      purpose: string;
      depends_on?: string[];
      params?: {
        [k: string]: unknown;
      };
    }[],
  ];
}
