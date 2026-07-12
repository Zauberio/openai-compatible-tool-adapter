export type RecipeToolCall = {
  id: string;
  function: { name: string; arguments?: string };
};

export type RecipeMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: RecipeToolCall[];
};

export type RecipeContext = {
  rawPrompt: string;
  cwd: string;
  outputSchema: string;
  allowedFiles: string[];
  toolsExecuted: number;
  diffExists: boolean;
  observedEvidence: string[];
  messages: RecipeMessage[];
};

export type CandidateNormalization = {
  content: string;
  retryPrompt?: string;
};

export type RecipeLoadOptions = {
  env: NodeJS.ProcessEnv;
};

export interface AdapterRecipe {
  name: string;
  preparePrompt(rawPrompt: string, cwd: string): string;
  systemInstructions(context: RecipeContext): string[];
  normalizeCandidate?(
    content: string,
    context: RecipeContext,
  ): CandidateNormalization | null;
  normalizeFinal?(content: string, context: RecipeContext): string;
  buildExhaustionFinalization?(context: RecipeContext): RecipeMessage[] | null;
  schemaRepairInstructions?(context: RecipeContext): string[];
  allowSchemaRepair?(context: RecipeContext): boolean;
  rewriteCommand?(command: string): string | null;
  allowExhaustedWithoutDiff?(context: RecipeContext): boolean;
}
