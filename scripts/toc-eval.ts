// Optional real-model check. Uses two ephemeral helper threads and synthetic text only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { CodexRpc } from '../src/rpc';
import { AuxiliaryAgent, type AuxiliaryModel } from '../src/auxiliary-agent';
import { outlineBatches, outlineContext, outlineInstructions, outlineSchema, validateOutline,
  type OutlineTopic, type OutlineTurn } from '../src/session-outline';

const cwd = process.cwd(), rpc = new CodexRpc({ cwd });
let model: AuxiliaryModel;
try {
  await rpc.start();
  const { config } = await rpc.request('config/read', { cwd, includeLayers: false });
  const { data } = await rpc.request('model/list', {});
  const name = config.model ?? data.find(m => m.isDefault)?.model;
  const info = data.find(m => m.model === name || m.id === name);
  model = { cwd, model: name, modelProvider: config.model_provider ?? undefined,
    effort: info?.supportedReasoningEfforts.some(e => e.reasoningEffort === 'low') ? 'low' : undefined };
} finally { await rpc.close(); }
const agent = new AuxiliaryAgent(() => rpc.createPeer());
const lines = [
  ['Why can the same program have different temporal guarantees after two elaborations?',
    'The observable events can agree while the assigned effects impose different temporal guarantees.'],
  ['Show the practical consequence with a service that announces readiness and sends heartbeats.',
    'The readiness event happens once; ongoing heartbeat events need a separate temporal condition.'],
  ['Can an infinite internal loop be a counterexample to productivity even when initialization succeeds?',
    'Yes. Initialization can succeed while an infinite silent loop produces no heartbeat.'],
  ['A separate problem: the paper build in CI now fails after I renamed main.tex to paper.tex.',
    'The workflow still points to main.tex. Updating the workflow path should restore the build.'],
  ['The build path change worked. Keep the paper theory unchanged for that fix.',
    'The CI path is fixed, and this change does not affect the theory.'],
  ['Back to temporal guarantees: suggest a condition that excludes the silent loop.',
    'A recurring observable-event requirement could exclude the silent loop. This is a proposal, not a proven rule.'],
  ['That proposed condition is too strong for finite computations. Leave the rule unresolved; record that objection.',
    'The objection is that a recurring-event requirement would reject valid finite computations. The condition remains unresolved.'],
  ['Thanks.', 'You are welcome.'],
];
const turns: OutlineTurn[] = lines.map(([prompt, reply], i) => ({ id: `t${i}`, status: 'completed', messages: [
  { role: 'user', anchor: `t${i}:user`, text: prompt }, { role: 'assistant', anchor: `t${i}:user`, text: reply },
] }));
let topics: OutlineTopic[] = [];
const stages = [];
for (const [index, evidence] of [turns.slice(0, 5), turns.slice(5)].entries()) {
  const start = Date.now();
  const value = await agent.generate({ ...model, source: 'thread_outline', timeoutMs: 60_000,
    instructions: outlineInstructions, schema: outlineSchema,
    prompt: JSON.stringify({ previousOutline: { topics }, recentContext: index ? outlineContext(turns.slice(0, 5)) : [],
      batch: 1, batches: 1, evidence: outlineBatches(evidence).flat() }),
  }, new AbortController().signal);
  topics = validateOutline(value, turns.flatMap(t => t.messages.filter(m => m.role === 'user').map(m => m.anchor)));
  stages.push({ elapsedMs: Date.now() - start, topics });
  console.log(`Stage ${index + 1}: ${topics.length} topics, ${topics.reduce((n, t) => n + t.children.length, 0)} subtopics`);
}
await mkdir('.prototype/toc-eval', { recursive: true });
await writeFile('.prototype/toc-eval/result.json', JSON.stringify({ model: model.model, stages }, null, 2));
const initialTheory = stages[0].topics.find(t => t.anchors.includes('t0:user'));
const theory = topics.find(t => t.id === initialTheory?.id);
assert.ok(topics.length >= 2 && topics.length <= 4, 'Distinct theory and build problems should form a compact outline');
assert.ok(theory?.anchors.includes('t5:user'), 'A return to the original topic should retain its identity and add a visit');
assert.ok(topics.some(t => t.anchors.includes('t3:user')), 'The build detour should remain visible');
assert.ok(topics.flatMap(t => [t, ...t.children]).some(t => t.anchors.includes('t2:user')), 'The counterexample should remain findable');
assert.ok(!topics.flatMap(t => [t, ...t.children]).some(t => t.anchors.includes('t7:user')), 'An acknowledgement should not create a new heading or visit');
console.log('PASS: real helper keeps meaningful structure, the detour, the counterexample, and a later return');
