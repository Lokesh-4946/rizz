import {
  type GenerateProjectBrainOptions,
  type GenerateProjectBrainSummary,
  generateProjectBrain,
} from './index.js';
import { type ProjectStore, prepareProjectStore } from './project-store.js';

export async function prepareRepository(
  options: GenerateProjectBrainOptions & { readonly rizzHome?: string },
): Promise<
  | {
      readonly ok: true;
      readonly value: {
        readonly project: ProjectStore;
        readonly brain: GenerateProjectBrainSummary;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
> {
  const project = await prepareProjectStore({
    rootDir: options.rootDir,
    ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
  });
  if (!project.ok) return project;
  const brain = await generateProjectBrain({
    ...options,
    rootDir: project.value.rootPath,
    outputDir: project.value.projectDir,
  });
  return brain.ok ? { ok: true, value: { project: project.value, brain: brain.value } } : brain;
}
