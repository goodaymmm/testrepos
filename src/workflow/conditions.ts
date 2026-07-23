import { isDeepStrictEqual } from "node:util";

export type WorkflowJsonPrimitive = string | number | boolean | null;
export type WorkflowJsonValue =
  | WorkflowJsonPrimitive
  | WorkflowJsonValue[]
  | { [key: string]: WorkflowJsonValue };

export type WorkflowConditionOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "contains"
  | "exists";

export type WorkflowConditionExpression =
  | {
      source: "input";
      path: string;
      operator: WorkflowConditionOperator;
      value?: WorkflowJsonValue;
    }
  | {
      source: "node";
      node_id: string;
      field: "status" | "attempt" | "condition_result";
      operator: WorkflowConditionOperator;
      value?: WorkflowJsonValue;
    };

export type WorkflowConditionNodeSnapshot = {
  status: string;
  attempt: number;
  condition_result?: boolean;
};

export type WorkflowConditionContext = {
  input: Record<string, WorkflowJsonValue>;
  nodes: Record<string, WorkflowConditionNodeSnapshot>;
};

export class WorkflowConditionEvaluationError extends Error {
  constructor(
    readonly code:
      | "missing_value"
      | "type_mismatch"
      | "invalid_operator"
      | "missing_operand",
    message: string
  ) {
    super(message);
    this.name = "WorkflowConditionEvaluationError";
  }
}

export function evaluateWorkflowCondition(
  expression: WorkflowConditionExpression,
  context: WorkflowConditionContext
): boolean {
  const actual =
    expression.source === "input"
      ? readInputPath(context.input, expression.path)
      : readNodeField(context, expression);

  if (expression.operator === "exists") {
    return actual !== undefined;
  }
  if (actual === undefined) {
    throw new WorkflowConditionEvaluationError(
      "missing_value",
      `Workflow condition value is missing: ${describeSource(expression)}`
    );
  }
  if (expression.value === undefined) {
    throw new WorkflowConditionEvaluationError(
      "missing_operand",
      `Workflow condition operator ${expression.operator} requires value.`
    );
  }

  switch (expression.operator) {
    case "eq":
      return deepEqual(actual, expression.value);
    case "ne":
      return !deepEqual(actual, expression.value);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compareOrdered(actual, expression.value, expression.operator);
    case "in":
      if (!Array.isArray(expression.value)) {
        throw typeMismatch(expression.operator, "array");
      }
      return expression.value.some((candidate) => deepEqual(actual, candidate));
    case "contains":
      if (Array.isArray(actual)) {
        const expected = expression.value;
        return actual.some((candidate) => deepEqual(candidate, expected));
      }
      if (typeof actual === "string" && typeof expression.value === "string") {
        return actual.includes(expression.value);
      }
      throw typeMismatch(expression.operator, "string or array");
    default:
      throw new WorkflowConditionEvaluationError(
        "invalid_operator",
        `Unsupported workflow condition operator: ${String(expression.operator)}`
      );
  }
}

function readInputPath(
  input: Record<string, WorkflowJsonValue>,
  inputPath: string
): WorkflowJsonValue | undefined {
  const segments = inputPath.split(".").filter((segment) => segment.length > 0);
  let current: WorkflowJsonValue | undefined = input;
  for (const segment of segments) {
    if (
      current === null ||
      Array.isArray(current) ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function readNodeField(
  context: WorkflowConditionContext,
  expression: Extract<WorkflowConditionExpression, { source: "node" }>
): WorkflowJsonValue | undefined {
  const node = context.nodes[expression.node_id];
  if (node === undefined) {
    return undefined;
  }
  return node[expression.field];
}

function compareOrdered(
  actual: WorkflowJsonValue,
  expected: WorkflowJsonValue,
  operator: "gt" | "gte" | "lt" | "lte"
): boolean {
  if (
    (typeof actual !== "number" || typeof expected !== "number") &&
    (typeof actual !== "string" || typeof expected !== "string")
  ) {
    throw typeMismatch(operator, "matching number or string");
  }
  if (typeof actual === "number" && typeof expected === "number") {
    return compareValues(actual, expected, operator);
  }
  return compareValues(String(actual), String(expected), operator);
}

function compareValues<T extends number | string>(
  actual: T,
  expected: T,
  operator: "gt" | "gte" | "lt" | "lte"
): boolean {
  if (operator === "gt") {
    return actual > expected;
  }
  if (operator === "gte") {
    return actual >= expected;
  }
  if (operator === "lt") {
    return actual < expected;
  }
  return actual <= expected;
}

function deepEqual(left: WorkflowJsonValue, right: WorkflowJsonValue): boolean {
  return isDeepStrictEqual(left, right);
}

function typeMismatch(operator: string, expected: string): WorkflowConditionEvaluationError {
  return new WorkflowConditionEvaluationError(
    "type_mismatch",
    `Workflow condition operator ${operator} requires ${expected} operands.`
  );
}

function describeSource(expression: WorkflowConditionExpression): string {
  return expression.source === "input"
    ? `input.${expression.path}`
    : `node.${expression.node_id}.${expression.field}`;
}
