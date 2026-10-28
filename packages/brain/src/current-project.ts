import { recordHumanSignoff, revokeHumanSignoff } from './human-approval.js';
import {
  type AddVerificationEvidenceOptions,
  type AskProjectQuestionOptions,
  type ExplainProjectTargetOptions,
  type ReviewProjectChangesOptions,
  addVerificationEvidence,
  askProjectQuestion,
  explainProjectTarget,
  reviewProjectChanges,
} from './index.js';
import { prepareProjectStore } from './project-store.js';

async function currentOutputDir(rootDir: string, rizzHome?: string) {
  const project = await prepareProjectStore({
    rootDir,
    ...(rizzHome === undefined ? {} : { rizzHome }),
  });
  return project.ok ? { ok: true as const, value: project.value.projectDir } : project;
}

export async function reviewCurrentProject(
  options: Omit<ReviewProjectChangesOptions, 'outputDir'>,
) {
  const output = await currentOutputDir(options.rootDir);
  return output.ok ? reviewProjectChanges({ ...options, outputDir: output.value }) : output;
}

export async function verifyCurrentProject(
  options: Omit<AddVerificationEvidenceOptions, 'outputDir'>,
) {
  const output = await currentOutputDir(options.rootDir);
  return output.ok ? addVerificationEvidence({ ...options, outputDir: output.value }) : output;
}

export async function explainCurrentProject(
  options: Omit<ExplainProjectTargetOptions, 'outputDir'> & { readonly rizzHome?: string },
) {
  const output = await currentOutputDir(options.rootDir, options.rizzHome);
  return output.ok ? explainProjectTarget({ ...options, outputDir: output.value }) : output;
}

export async function askCurrentProject(options: Omit<AskProjectQuestionOptions, 'outputDir'>) {
  const output = await currentOutputDir(options.rootDir);
  return output.ok ? askProjectQuestion({ ...options, outputDir: output.value }) : output;
}

interface HumanDecisionOptions {
  readonly rootDir: string;
  readonly summary: string;
  readonly approver: string;
  readonly now?: Date;
}

export async function signoffCurrentProject(
  options: HumanDecisionOptions & { readonly expiresAt?: string },
) {
  const output = await currentOutputDir(options.rootDir);
  return output.ok ? recordHumanSignoff({ ...options, outputDir: output.value }) : output;
}

export async function revokeCurrentProjectSignoff(options: HumanDecisionOptions) {
  const output = await currentOutputDir(options.rootDir);
  return output.ok ? revokeHumanSignoff({ ...options, outputDir: output.value }) : output;
}
