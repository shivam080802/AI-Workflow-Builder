import { z } from 'zod';

export const nodeKindSchema = z.enum(['manual', 'webhook', 'schedule', 'text', 'uppercase', 'router', 'approval', 'llm', 'http', 'slack', 'github']);
export type NodeKind = z.infer<typeof nodeKindSchema>;
export const nodeSchema = z.object({
  id: z.string().min(1).max(100),
  kind: nodeKindSchema,
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  config: z.record(z.unknown()).default({}),
});
export const edgeSchema = z.object({
  id: z.string().min(1), source: z.string().min(1), target: z.string().min(1), sourceHandle: z.enum(['true','false']).optional(),
});
export const graphSchema = z.object({nodes: z.array(nodeSchema).min(1).max(100), edges: z.array(edgeSchema).max(200)});
export type WorkflowGraph = z.infer<typeof graphSchema>;

export interface NodeDefinition<C extends z.ZodTypeAny = z.ZodTypeAny> {
  kind: NodeKind;
  version: 1;
  label: string;
  description: string;
  configSchema: C;
  inputType: 'none' | 'text';
  outputType: 'text';
}
export const nodeDefinitions = {
  manual: {kind: 'manual', version: 1, label: 'Manual trigger', description: 'Starts a run with input text', configSchema: z.object({}), inputType: 'none', outputType: 'text'},
  webhook: {kind: 'webhook', version: 1, label: 'Webhook trigger', description: 'Starts when its signed URL receives JSON', configSchema: z.object({}), inputType: 'none', outputType: 'text'},
  schedule: {kind:'schedule',version:1,label:'Schedule trigger',description:'Starts at a fixed minute interval',configSchema:z.object({everyMinutes:z.number().int().min(1).max(1440)}),inputType:'none',outputType:'text'},
  text: {kind: 'text', version: 1, label: 'Text', description: 'Adds text before or after the input', configSchema: z.object({prefix: z.string().default(''), suffix: z.string().default('')}), inputType: 'text', outputType: 'text'},
  uppercase: {kind: 'uppercase', version: 1, label: 'Uppercase', description: 'Converts input to uppercase', configSchema: z.object({}), inputType: 'text', outputType: 'text'},
  router: {kind:'router',version:1,label:'Condition',description:'Routes to True or Otherwise',configSchema:z.object({field:z.string().default('$'),operator:z.enum(['equals','contains','exists','greaterThan']).default('equals'),value:z.string().default('')}),inputType:'text',outputType:'text'},
  approval: {kind:'approval',version:1,label:'Approval',description:'Pause until an editor approves or rejects',configSchema:z.object({prompt:z.string().min(1).max(500),timeoutMinutes:z.number().int().min(1).max(10080)}),inputType:'text',outputType:'text'},
  llm: {kind:'llm',version:1,label:'AI text',description:'Run a local Ollama model or deterministic test provider',configSchema:z.object({provider:z.enum(['mock','ollama']),model:z.string().max(100).default(''),prompt:z.string().min(1).max(4000)}).refine(v=>v.provider==='mock'||v.model.length>0,{message:'Select an Ollama model'}),inputType:'text',outputType:'text'},
  http: {kind:'http',version:1,label:'HTTP request',description:'Call an HTTPS endpoint',configSchema:z.object({url:z.string().url(),method:z.enum(['GET','POST','PUT','PATCH']).default('GET'),body:z.string().default(''),credentialId:z.string().optional()}),inputType:'text',outputType:'text'},
  slack: {kind:'slack',version:1,label:'Slack message',description:'Post a message to a channel',configSchema:z.object({channel:z.string().min(1),text:z.string().min(1),credentialId:z.string().min(1)}),inputType:'text',outputType:'text'},
  github: {kind:'github',version:1,label:'GitHub issue',description:'Create an issue in a repository',configSchema:z.object({owner:z.string().min(1),repo:z.string().min(1),title:z.string().min(1),body:z.string().default(''),credentialId:z.string().min(1)}),inputType:'text',outputType:'text'},
} as const satisfies Record<NodeKind, NodeDefinition>;

export class GraphValidationError extends Error {}
export function validateGraph(value: unknown): WorkflowGraph {
  const graph = graphSchema.parse(value);
  const ids = new Set(graph.nodes.map(n => n.id));
  if (ids.size !== graph.nodes.length) throw new GraphValidationError('Node IDs must be unique');
  const starts = graph.nodes.filter(n => n.kind === 'manual' || n.kind === 'webhook' || n.kind === 'schedule');
  if (starts.length !== 1) throw new GraphValidationError('Exactly one trigger is required');
  const incoming = new Map(graph.nodes.map(n => [n.id, 0]));
  const outgoing = new Map(graph.nodes.map(n => [n.id, 0]));
  for (const node of graph.nodes) nodeDefinitions[node.kind].configSchema.parse(node.config);
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new GraphValidationError('An edge references a missing node');
    if (edge.source === edge.target) throw new GraphValidationError('Self loops are not allowed');
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    const source = graph.nodes.find(n => n.id === edge.source)!;
    if ((source.kind === 'router'||source.kind==='approval') && !edge.sourceHandle) throw new GraphValidationError('Decision edges must use True or Otherwise handles');
    if (source.kind !== 'router'&&source.kind!=='approval' && edge.sourceHandle) throw new GraphValidationError('Only decisions can use branch handles');
  }
  if ((incoming.get(starts[0]!.id) ?? 0) !== 0) throw new GraphValidationError('The trigger cannot have an incoming edge');
  for (const node of graph.nodes) {
    if (node.id !== starts[0]!.id && incoming.get(node.id) !== 1) throw new GraphValidationError('Every action needs exactly one input');
    if (node.kind === 'router'||node.kind==='approval') {
      const routes = graph.edges.filter(e => e.source === node.id).map(e => e.sourceHandle);
      if (new Set(routes).size !== routes.length) throw new GraphValidationError('A condition can connect each route only once');
    } else if ((outgoing.get(node.id) ?? 0) > 1) throw new GraphValidationError('Only conditions may branch');
  }
  const visited = new Set<string>();
  const visit = (current: string, stack: Set<string>) => {
    if (stack.has(current)) throw new GraphValidationError('Cycles are not allowed');
    if (visited.has(current)) return;
    visited.add(current);
    const next = new Set(stack); next.add(current);
    for (const edge of graph.edges.filter(e => e.source === current)) visit(edge.target, next);
  };
  visit(starts[0]!.id, new Set());
  if (visited.size !== graph.nodes.length) throw new GraphValidationError('All nodes must be connected to the trigger');
  return graph;
}

export function orderedNodes(graph: WorkflowGraph) {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const result: WorkflowGraph['nodes'] = [];
  let id: string | undefined = graph.nodes.find(n => n.kind === 'manual' || n.kind === 'webhook' || n.kind === 'schedule')?.id;
  while (id) {
    result.push(nodes.get(id)!);
    id = graph.edges.find(e => e.source === id)?.target;
  }
  return result;
}
