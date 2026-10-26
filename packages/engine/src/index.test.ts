import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeGraph } from './index.js';
import { GraphValidationError, validateGraph } from '@awb/contracts';

const graph = {nodes: [
  {id:'start',kind:'manual',position:{x:0,y:0},config:{}},
  {id:'text',kind:'text',position:{x:100,y:0},config:{prefix:'Hi ',suffix:'!'}},
  {id:'upper',kind:'uppercase',position:{x:200,y:0},config:{}}
],edges:[{id:'a',source:'start',target:'text'},{id:'b',source:'text',target:'upper'}]};
test('executes a validated workflow in edge order', async () => {
  assert.equal(await executeGraph(graph, 'world'), 'HI WORLD!');
});
test('rejects disconnected nodes', () => {
  assert.throws(() => validateGraph({...graph,edges:[graph.edges[0]]}), GraphValidationError);
});
test('rejects cycles', () => {
  assert.throws(() => validateGraph({...graph,edges:[...graph.edges,{id:'c',source:'upper',target:'text'}]}), GraphValidationError);
});
