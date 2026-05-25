import { analyzeProjectDocking } from "../../docking/project-analyzer.js";

export async function analyzeDocking(projectRoot: string): Promise<string> {
  const analysis = await analyzeProjectDocking(projectRoot);
  return `${JSON.stringify(analysis, null, 2)}\n`;
}
