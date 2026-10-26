// Optional real-model check. Uses four ephemeral helper threads and synthetic text only.
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
const stages: { name: string; elapsedMs: number; raw: unknown; topics: OutlineTopic[] }[] = [];
async function generate(name: string, history: OutlineTurn[], evidence: OutlineTurn[], previous: OutlineTopic[] = []) {
  const anchors = history.flatMap(t => t.messages.filter(m => m.role === 'user').map(m => m.anchor));
  const start = Date.now();
  const value = await agent.generate({ ...model, source: 'thread_outline', timeoutMs: 60_000,
    instructions: outlineInstructions, schema: outlineSchema,
    prompt: JSON.stringify({ conversation: { userPromptCount: new Set(anchors).size }, previousOutline: { topics: previous },
      recentContext: outlineContext(history.slice(0, history.length - evidence.length)),
      batch: 1, batches: 1, evidence: outlineBatches(evidence).flat() }),
  }, new AbortController().signal);
  const topics = validateOutline(value, anchors);
  stages.push({ name, elapsedMs: Date.now() - start, raw: value, topics });
  await mkdir('.prototype/toc-eval', { recursive: true });
  await writeFile('.prototype/toc-eval/result.json', JSON.stringify({ model: model.model, stages }, null, 2));
  console.log(`${name}: ${topics.length} topics, ${topics.reduce((n, t) => n + t.children.length, 0)} subtopics`);
  return topics;
}
const discussion = (id: string, prompt: string, reply: string): OutlineTurn => ({ id, status: 'completed', messages: [
  { role: 'user', anchor: `${id}:user`, text: prompt }, { role: 'assistant', anchor: `${id}:user`, text: reply },
] });
const report = [discussion('design',
  '\u6211\u4eec\u5f88\u591a\u7684session\u90fd\u804a\u4e86effect inference\uff0cimplicit effect abstraction/application\u548cpolymorphism\uff0c\u4ee5\u53casubeffect\u7684\u95ee\u9898\uff0c\u603b\u7ed3\u4e00\u4e0b\u3002\u6211\u8981\u660e\u5929\u8ddfprofessor\u8ba8\u8bba\uff0c\u7136\u540e\u51b3\u5b9a\u4ec0\u4e48\u6837\u7684\u8bbe\u8ba1\uff0c\u6240\u4ee5\u8981\u77e5\u9053\u8fd9\u91cc\u9762\u7684trade-off\u548cchallenges\u5728\u54ea\u91cc',
  `The main design choice is the scope of inference and what annotations remain necessary.\n\n` + [
    ['Effect inference levels', 'Local inference, polymorphic signatures, and recursive invariant discovery have different costs.'],
    ['Subeffect checks and subsumption', 'Retain explicit checking boundaries while composing effects automatically.'],
    ['Implicit abstraction and evaluation', 'Binding scope and evaluation timing remain design questions.'],
    ['Partial application counterexample', 'Partial application can expose differences between proposed elaborations.'],
    ['Generalization and constrained schemes', 'Constraint handling affects generalization and user annotations.'],
    ['Recursive invariant search', 'Require user-provided invariants initially; inference is a separate research goal.'],
    ['Polymorphic repeat', 'Recursive signatures need a precise invariant representation.'],
    ['Cyclic constraints and termination', 'Cyclic constraints complicate solver termination.'],
    ['Checking and solving interfaces', 'Separate checking a candidate from discovering one.'],
    ['Meeting decisions', 'The suggested first stage is annotation-guided inference. Nothing is agreed yet.'],
  ].map(([title, text]) => `## ${title}\n\n${text}`).join('\n\n'))];
const reportTopics = await generate('Single prompt with ten answer headings', report, report);
assert.equal(reportTopics.length, 1); assert.deepEqual(reportTopics[0].children, []);
const rawReport = stages[0].raw as { topics: OutlineTopic[] };
assert.equal(rawReport.topics.length, 1, 'The model itself should avoid outlining reply headings');
assert.deepEqual(rawReport.topics[0].children, []);

const followups = [
  'Explain that first-stage recommendation more simply.', 'Give an example of what the user would annotate.',
  'Why is that annotation needed?', 'Can you make the same example smaller?',
  'I do not follow the last step. Explain it again.', 'What happens if we omit that annotation in this example?',
  'So the first stage keeps the annotation, correct?', 'Keep that recommendation provisional.',
  'Rewrite the explanation for the meeting.', 'Shorten that wording.', 'Use the earlier example.', 'Thanks.',
].map((prompt, i) => discussion(`follow-${i}`, prompt, 'We are refining the same provisional annotation-guided inference proposal and its example.'));
const focused = await generate('Thirteen prompts refining one discussion', [...report, ...followups], followups, reportTopics);
assert.equal(focused.length, 1, 'Related follow-ups must not become one entry per prompt');
assert.deepEqual(focused[0].children, [], 'Examples and wording changes do not create subtopics');
assert.equal(focused[0].id, reportTopics[0].id);
assert.deepEqual(focused[0].anchors, ['design:user']);

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
const theoryStages: OutlineTopic[][] = [];
for (const [index, evidence] of [turns.slice(0, 5), turns.slice(5)].entries()) {
  topics = await generate(`Detour and return ${index + 1}`, index ? turns : turns.slice(0, 5), evidence, topics);
  theoryStages.push(topics);
}
const initialTheory = theoryStages[0].find(t => t.anchors.includes('t0:user'));
const theory = topics.find(t => t.id === initialTheory?.id);
assert.equal(topics.length, 2, 'The theory discussion and build detour need only two topics');
assert.ok(theory?.anchors.includes('t5:user'), 'A return to the original topic should retain its identity and add a visit');
assert.ok(topics.some(t => t.anchors.includes('t3:user')), 'The build detour should remain visible');
assert.ok(topics.every(t => !t.children.length), 'An example and objection within the same question need no subheadings');
assert.ok(!topics.flatMap(t => [t, ...t.children]).some(t => t.anchors.includes('t7:user')), 'An acknowledgement should not create a new heading or visit');
console.log('PASS: one long answer stays one topic; follow-ups stay grouped; a detour and later return remain navigable');
