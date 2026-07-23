import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import type {
  WorkflowConditionExpression,
  WorkflowJsonValue
} from "./conditions.js";
import type { WorkflowJoinPolicy } from "./types.js";

export type WorkflowNodeDependencyCondition = {
  condition_node_id: string;
  equals: boolean;
};

type WorkflowDefinitionNodeBase = {
  id: string;
  depends_on: string[];
  branch_id?: string;
  when?: WorkflowNodeDependencyCondition;
};

export type WorkflowTaskDefinitionNode = WorkflowDefinitionNodeBase & {
  type: "task";
  task_id: string;
  resource_keys: string[];
  retry?: {
    max_attempts: number;
    backoff_seconds: number;
  };
  compensation?: {
    task_id: string;
    resource_keys: string[];
  };
};

export type WorkflowManualGateDefinitionNode = WorkflowDefinitionNodeBase & {
  type: "manual_gate";
  approval_id: string;
};

export type WorkflowConditionDefinitionNode = WorkflowDefinitionNodeBase & {
  type: "condition";
  expression: WorkflowConditionExpression;
};

export type WorkflowParallelDefinitionNode = WorkflowDefinitionNodeBase & {
  type: "parallel";
  branches: Array<{
    id: string;
    entry_node_id: string;
  }>;
};

export type WorkflowJoinDefinitionNode = WorkflowDefinitionNodeBase & {
  type: "join";
  policy: WorkflowJoinPolicy;
  threshold?: number;
};

export type WorkflowDefinitionNode =
  | WorkflowTaskDefinitionNode
  | WorkflowManualGateDefinitionNode
  | WorkflowConditionDefinitionNode
  | WorkflowParallelDefinitionNode
  | WorkflowJoinDefinitionNode;

export type WorkflowDefinition = {
  schema_version: "0.1";
  artifact_kind: "workflow_definition";
  workflow_id: string;
  objective: string;
  entry_node_id: string;
  input: Record<string, WorkflowJsonValue>;
  nodes: WorkflowDefinitionNode[];
};

export type WorkflowDefinitionDiagnostic = {
  code:
    | "schema_invalid"
    | "duplicate_node"
    | "missing_entry"
    | "missing_dependency"
    | "cycle"
    | "unreachable_node"
    | "invalid_join"
    | "invalid_condition_dependency"
    | "invalid_parallel_branch"
    | "duplicate_branch";
  message: string;
  node_id?: string;
};

export type WorkflowDefinitionValidationResult = {
  valid: boolean;
  definition?: WorkflowDefinition;
  diagnostics: WorkflowDefinitionDiagnostic[];
  digest?: string;
};

const jsonValueSchema: z.ZodType<WorkflowJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

const conditionOperatorSchema = z.enum([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "exists"
]);

const conditionExpressionSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("input"),
      path: z.string().min(1),
      operator: conditionOperatorSchema,
      value: jsonValueSchema.optional()
    })
    .strict(),
  z
    .object({
      source: z.literal("node"),
      node_id: z.string().min(1),
      field: z.enum(["status", "attempt", "condition_result"]),
      operator: conditionOperatorSchema,
      value: jsonValueSchema.optional()
    })
    .strict()
]);

const dependencyConditionSchema = z
  .object({
    condition_node_id: z.string().min(1),
    equals: z.boolean()
  })
  .strict();

const nodeBase = {
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  depends_on: z.array(z.string().min(1)).default([]),
  branch_id: z.string().min(1).optional(),
  when: dependencyConditionSchema.optional()
};

const resourceKeysSchema = z.array(z.string().min(1)).default([]);

const workflowNodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...nodeBase,
      type: z.literal("task"),
      task_id: z.string().regex(/^TASK-[A-Za-z0-9_-]+$/),
      resource_keys: resourceKeysSchema,
      retry: z
        .object({
          max_attempts: z.number().int().min(1).max(10),
          backoff_seconds: z.number().int().min(0).max(3600)
        })
        .strict()
        .optional(),
      compensation: z
        .object({
          task_id: z.string().regex(/^TASK-[A-Za-z0-9_-]+$/),
          resource_keys: resourceKeysSchema
        })
        .strict()
        .optional()
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      type: z.literal("manual_gate"),
      approval_id: z.string().regex(/^APR-[A-Za-z0-9_-]+$/)
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      type: z.literal("condition"),
      expression: conditionExpressionSchema
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      type: z.literal("parallel"),
      branches: z
        .array(
          z
            .object({
              id: z.string().min(1),
              entry_node_id: z.string().min(1)
            })
            .strict()
        )
        .min(2)
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      type: z.literal("join"),
      policy: z.enum(["all", "any", "threshold"]),
      threshold: z.number().int().min(1).optional()
    })
    .strict()
]);

const workflowDefinitionSchema = z
  .object({
    schema_version: z.literal("0.1"),
    artifact_kind: z.literal("workflow_definition"),
    workflow_id: z.string().regex(/^WF-[A-Za-z0-9_-]+$/),
    objective: z.string().min(1),
    entry_node_id: z.string().min(1),
    input: z.record(z.string(), jsonValueSchema).default({}),
    nodes: z.array(workflowNodeSchema).min(1)
  })
  .strict();

export class WorkflowDefinitionValidationError extends Error {
  constructor(readonly diagnostics: WorkflowDefinitionDiagnostic[]) {
    super(
      `Workflow definition is invalid: ${diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`
    );
    this.name = "WorkflowDefinitionValidationError";
  }
}

export function validateWorkflowDefinition(
  value: unknown
): WorkflowDefinitionValidationResult {
  const parsed = workflowDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      diagnostics: parsed.error.issues.map((issue) => ({
        code: "schema_invalid",
        message: `${issue.path.join(".") || "definition"}: ${issue.message}`
      }))
    };
  }

  const definition = parsed.data as WorkflowDefinition;
  const diagnostics = validateGraph(definition);
  return {
    valid: diagnostics.length === 0,
    definition: diagnostics.length === 0 ? definition : undefined,
    diagnostics,
    digest: diagnostics.length === 0 ? digestWorkflowDefinition(definition) : undefined
  };
}

export async function loadWorkflowDefinitionFile(
  definitionPath: string
): Promise<WorkflowDefinitionValidationResult> {
  return validateWorkflowDefinition(
    await readJsonFile<unknown>(path.resolve(definitionPath))
  );
}

export async function readValidatedWorkflowDefinition(
  definitionPath: string
): Promise<WorkflowDefinition> {
  const validation = await loadWorkflowDefinitionFile(definitionPath);
  if (!validation.valid || validation.definition === undefined) {
    throw new WorkflowDefinitionValidationError(validation.diagnostics);
  }
  return validation.definition;
}

export async function persistWorkflowDefinition(
  projectRoot: string,
  definition: WorkflowDefinition
): Promise<{ path: string; project_path: string; digest: string }> {
  const validation = validateWorkflowDefinition(definition);
  if (!validation.valid || validation.definition === undefined || validation.digest === undefined) {
    throw new WorkflowDefinitionValidationError(validation.diagnostics);
  }
  const artifactPath = workflowDefinitionArtifactPath(
    projectRoot,
    definition.workflow_id
  );
  await writeJsonFileAtomic(artifactPath, validation.definition);
  return {
    path: artifactPath,
    project_path: toPosixPath(path.relative(projectRoot, artifactPath)),
    digest: validation.digest
  };
}

export function workflowDefinitionArtifactPath(
  projectRoot: string,
  workflowId: string
): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "workflows",
    "definitions",
    `${workflowId}.json`
  );
}

export function digestWorkflowDefinition(definition: WorkflowDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex");
}

function validateGraph(
  definition: WorkflowDefinition
): WorkflowDefinitionDiagnostic[] {
  const diagnostics: WorkflowDefinitionDiagnostic[] = [];
  const nodesById = new Map<string, WorkflowDefinitionNode>();
  for (const node of definition.nodes) {
    if (nodesById.has(node.id)) {
      diagnostics.push({
        code: "duplicate_node",
        node_id: node.id,
        message: `Duplicate workflow node: ${node.id}`
      });
      continue;
    }
    nodesById.set(node.id, node);
  }

  if (!nodesById.has(definition.entry_node_id)) {
    diagnostics.push({
      code: "missing_entry",
      node_id: definition.entry_node_id,
      message: `Workflow entry node does not exist: ${definition.entry_node_id}`
    });
  }

  for (const node of definition.nodes) {
    for (const dependencyId of node.depends_on) {
      if (!nodesById.has(dependencyId)) {
        diagnostics.push({
          code: "missing_dependency",
          node_id: node.id,
          message: `Workflow node ${node.id} depends on missing node ${dependencyId}.`
        });
      }
    }
    validateJoin(node, diagnostics);
    validateConditionDependency(node, nodesById, diagnostics);
  }
  validateParallelBranches(definition, nodesById, diagnostics);

  if (diagnostics.some((diagnostic) =>
    ["duplicate_node", "missing_entry", "missing_dependency"].includes(
      diagnostic.code
    )
  )) {
    return diagnostics;
  }

  const cycleNode = findCycle(definition.nodes);
  if (cycleNode !== undefined) {
    diagnostics.push({
      code: "cycle",
      node_id: cycleNode,
      message: `Workflow graph contains a cycle at ${cycleNode}.`
    });
  }

  for (const nodeId of findUnreachableNodes(definition)) {
    diagnostics.push({
      code: "unreachable_node",
      node_id: nodeId,
      message: `Workflow node is unreachable from ${definition.entry_node_id}: ${nodeId}`
    });
  }
  return diagnostics;
}

function validateJoin(
  node: WorkflowDefinitionNode,
  diagnostics: WorkflowDefinitionDiagnostic[]
): void {
  if (node.type !== "join") {
    return;
  }
  if (node.depends_on.length === 0) {
    diagnostics.push({
      code: "invalid_join",
      node_id: node.id,
      message: `Join node ${node.id} requires at least one dependency.`
    });
  }
  if (
    node.policy === "threshold" &&
    (node.threshold === undefined ||
      node.threshold < 1 ||
      node.threshold > node.depends_on.length)
  ) {
    diagnostics.push({
      code: "invalid_join",
      node_id: node.id,
      message: `Join node ${node.id} requires threshold between 1 and ${node.depends_on.length}.`
    });
  }
  if (node.policy !== "threshold" && node.threshold !== undefined) {
    diagnostics.push({
      code: "invalid_join",
      node_id: node.id,
      message: `Join node ${node.id} may only set threshold with threshold policy.`
    });
  }
}

function validateConditionDependency(
  node: WorkflowDefinitionNode,
  nodesById: Map<string, WorkflowDefinitionNode>,
  diagnostics: WorkflowDefinitionDiagnostic[]
): void {
  if (
    node.type === "condition" &&
    node.expression.source === "node" &&
    (!nodesById.has(node.expression.node_id) ||
      !node.depends_on.includes(node.expression.node_id))
  ) {
    diagnostics.push({
      code: "invalid_condition_dependency",
      node_id: node.id,
      message: `Condition node ${node.id} must depend on referenced node ${node.expression.node_id}.`
    });
  }
  if (node.when === undefined) {
    return;
  }
  const condition = nodesById.get(node.when.condition_node_id);
  if (
    condition?.type !== "condition" ||
    !node.depends_on.includes(node.when.condition_node_id)
  ) {
    diagnostics.push({
      code: "invalid_condition_dependency",
      node_id: node.id,
      message: `Workflow node ${node.id} must depend on condition node ${node.when.condition_node_id}.`
    });
  }
}

function validateParallelBranches(
  definition: WorkflowDefinition,
  nodesById: Map<string, WorkflowDefinitionNode>,
  diagnostics: WorkflowDefinitionDiagnostic[]
): void {
  const branchOwners = new Map<string, string>();
  for (const node of definition.nodes) {
    if (node.type !== "parallel") {
      continue;
    }
    for (const branch of node.branches) {
      const previousOwner = branchOwners.get(branch.id);
      if (previousOwner !== undefined) {
        diagnostics.push({
          code: "duplicate_branch",
          node_id: node.id,
          message: `Workflow branch ${branch.id} is declared by ${previousOwner} and ${node.id}.`
        });
      } else {
        branchOwners.set(branch.id, node.id);
      }
      const entry = nodesById.get(branch.entry_node_id);
      if (
        entry === undefined ||
        entry.branch_id !== branch.id ||
        !entry.depends_on.includes(node.id)
      ) {
        diagnostics.push({
          code: "invalid_parallel_branch",
          node_id: node.id,
          message: `Parallel branch ${branch.id} must reference an entry node that depends on ${node.id}.`
        });
      }
    }
  }
  for (const node of definition.nodes) {
    if (node.branch_id !== undefined && !branchOwners.has(node.branch_id)) {
      diagnostics.push({
        code: "invalid_parallel_branch",
        node_id: node.id,
        message: `Workflow node ${node.id} uses undeclared branch ${node.branch_id}.`
      });
    }
  }
}

function findCycle(nodes: WorkflowDefinitionNode[]): string | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dependents = dependencyMap(nodes);

  const visit = (nodeId: string): string | undefined => {
    if (visiting.has(nodeId)) {
      return nodeId;
    }
    if (visited.has(nodeId)) {
      return undefined;
    }
    visiting.add(nodeId);
    for (const dependent of dependents.get(nodeId) ?? []) {
      const cycle = visit(dependent);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return undefined;
  };

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle !== undefined) {
      return cycle;
    }
  }
  return undefined;
}

function findUnreachableNodes(definition: WorkflowDefinition): string[] {
  const dependents = dependencyMap(definition.nodes);
  const reachable = new Set<string>();
  const pending = [definition.entry_node_id];
  while (pending.length > 0) {
    const nodeId = pending.shift()!;
    if (reachable.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    pending.push(...(dependents.get(nodeId) ?? []));
  }
  return definition.nodes
    .map((node) => node.id)
    .filter((nodeId) => !reachable.has(nodeId));
}

function dependencyMap(
  nodes: WorkflowDefinitionNode[]
): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependencyId of node.depends_on) {
      const values = dependents.get(dependencyId) ?? [];
      values.push(node.id);
      dependents.set(dependencyId, values);
    }
  }
  return dependents;
}
