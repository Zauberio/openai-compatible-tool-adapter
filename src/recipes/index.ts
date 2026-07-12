import { genericRecipe } from "./generic.js";
import { createClawSweeperRecipe } from "./clawsweeper/index.js";
import type { AdapterRecipe, RecipeLoadOptions } from "./types.js";

export type {
  AdapterRecipe,
  CandidateNormalization,
  RecipeContext,
  RecipeLoadOptions,
  RecipeMessage,
  RecipeToolCall,
} from "./types.js";

export function loadRecipe(name: string, options: RecipeLoadOptions): AdapterRecipe {
  const normalized = name.trim().toLowerCase();
  if (!normalized || normalized === "generic") return genericRecipe;
  if (normalized === "clawsweeper") return createClawSweeperRecipe(options);
  throw new Error(`unknown adapter recipe: ${name}`);
}
