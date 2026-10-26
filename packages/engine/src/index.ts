import { nodeDefinitions, validateGraph, type NodeKind, type WorkflowGraph } from '@awb/contracts';

export interface NodeExecutor {
  kind: NodeKind;
  execute(input: string, config: Record<string, unknown>): Promise<string>;
}
export class ExecutorRegistry {
  private executors = new Map<NodeKind, NodeExecutor>();
  register(executor: NodeExecutor) {
    if (this.executors.has(executor.kind)) throw new Error(`Duplicate executor: ${executor.kind}`);
    this.executors.set(executor.kind, executor);
  }
  async execute(kind: NodeKind, input: string, config: Record<string, unknown>) {
    const executor = this.executors.get(kind);
    if (!executor) throw new Error(`No executor registered for ${kind}`);
    const parsed = nodeDefinitions[kind].configSchema.parse(config);
    return executor.execute(input, parsed);
  }
}
export const registry = new ExecutorRegistry();
registry.register({kind: 'manual', execute: async input => input});
registry.register({kind: 'webhook', execute: async input => input});
registry.register({kind: 'schedule', execute: async input => input});
registry.register({kind: 'text', execute: async (input, config) => `${config.prefix ?? ''}${input}${config.suffix ?? ''}`});
registry.register({kind: 'uppercase', execute: async input => input.toUpperCase()});
registry.register({kind: 'router', execute: async input => input});
registry.register({kind: 'approval', execute: async input => input});

export function readPath(input: string, path: string): unknown {
  if (path === '$' || path === '') return input;
  if (!/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(path)) throw new Error('Invalid field path');
  let value: unknown;
  try {value = JSON.parse(input);} catch {return undefined;}
  for (const segment of path.split('.')) {
    if (value === null || typeof value !== 'object' || !(segment in value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
export function evaluateCondition(input: string, config: Record<string, unknown>): boolean {
  const candidate = readPath(input, String(config.field ?? '$'));
  const expected = String(config.value ?? '');
  switch (config.operator) {
    case 'equals': return String(candidate ?? '') === expected;
    case 'contains': return String(candidate ?? '').includes(expected);
    case 'exists': return candidate !== undefined && candidate !== null && candidate !== '';
    case 'greaterThan': return Number(candidate) > Number(expected);
    default: throw new Error('Unsupported condition operator');
  }
}
export function renderTemplate(template: string, input: string, trigger: string): string {
  return template.replace(/\{\{\s*(input|trigger)(?:\.([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*))?\s*\}\}/g, (_match, scope: string, path: string | undefined) => {
    const value = path ? readPath(scope === 'input' ? input : trigger, path) : scope === 'input' ? input : trigger;
    return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  });
}
export function nextNode(graph: WorkflowGraph, nodeId: string, route?: 'true' | 'false'): string | undefined {
  return graph.edges.find(edge => edge.source === nodeId && (route === undefined || edge.sourceHandle === route))?.target;
}

export async function executeGraph(
  graphInput: unknown,
  input: string,
  onStep?: (step: {nodeId: string; kind: NodeKind; input: string; output: string}) => Promise<void>,
) {
  const graph: WorkflowGraph = validateGraph(graphInput);
  let value = input;
  let id: string | undefined = graph.nodes.find(n => n.kind === 'manual' || n.kind === 'webhook' || n.kind === 'schedule')?.id;
  while (id) {
    const node = graph.nodes.find(n => n.id === id)!;
    const before = value;
    value = await registry.execute(node.kind, before, node.config);
    await onStep?.({nodeId: node.id, kind: node.kind, input: before, output: value});
    if(node.kind==='approval')throw new Error('Approval nodes require the durable workflow worker');
    id = nextNode(graph, node.id, node.kind === 'router' ? (evaluateCondition(value, node.config) ? 'true' : 'false') : undefined);
  }
  return value;
}
