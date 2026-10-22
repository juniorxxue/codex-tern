#!/usr/bin/env bun
// Deterministic UI fixture. Never calls a model or executes a command.
import { createInterface } from 'node:readline';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FileLock } from '@oh-my-pi/pi-natives';
import { join } from 'node:path';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const notify = (method, params) => send({ method, params });
const threads = new Map();
if (process.env.QA_SESSION_FIXTURES) {
  for (let n = 1; n <= 7; n++) threads.set(`saved-${n}`, {
    id: `saved-${n}`, cwd: process.cwd(), name: `Saved session ${n}`, preview: '',
    createdAt: 1792558800 - n * 60, updatedAt: 1792558800 - n * 60, recencyAt: 1792558800 - n * 60,
    turns: [{ id: `saved-turn-${n}`, status: 'completed', items: [
      { id: `saved-answer-${n}`, type: 'agentMessage', phase: 'final_answer', text: `QA_SAVED_HISTORY_${n}` },
    ] }],
  });
  threads.set('other-folder', { id: 'other-folder', cwd: '/tmp/other-project', name: 'EXCLUDED_OTHER_FOLDER',
    preview: '', updatedAt: 1792558800, turns: [] });
}
let seq = 0;
const contexts = new Map(), pending = new Map();
const local = new AsyncLocalStorage();
const owned = new Map();
function acquire(id) {
  if (!process.env.QA_CODEX_HOME || owned.has(id)) return true;
  const lock = FileLock.tryAcquire(join(process.env.QA_CODEX_HOME, 'thread-writer-locks', `${id}.lock`));
  if (!lock.acquired) { lock.release(); return false; }
  owned.set(id, lock); return true;
}
const model = id => ({ id, model: id, displayName: id === 'qa-model' ? 'QA Model' : 'Other Model',
  description: 'UI test fixture', isDefault: id === 'qa-model', hidden: false,
  supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: 'high' });
const settings = thread => ({ thread, cwd: thread.cwd, model: 'qa-model', reasoningEffort: 'high',
  approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: { type: 'workspaceWrite' } });
const event = (method, extra) => {
  const { current, turn } = local.getStore();
  notify(method, { threadId: current.id, turnId: turn.id, ...extra });
};
function add(item, done = true) {
  const { turn } = local.getStore();
  const existing = turn.items.findIndex(i => i.id === item.id);
  if (existing < 0) turn.items.push(item); else turn.items[existing] = item;
  event(done ? 'item/completed' : 'item/started', { item });
}
function finish(text, status = 'completed') {
  const { current, turn } = local.getStore();
  if (!turn || turn.status !== 'inProgress') return;
  const command = turn.items.find(i => i.type === 'commandExecution');
  if (command) add({ ...command, status: status === 'completed' ? 'completed' : 'failed', exitCode: status === 'completed' ? 0 : 130 });
  if (text) add({ id: `answer-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text });
  turn.status = status; turn.completedAt = Date.now() / 1000; turn.durationMs = Math.round((turn.completedAt - turn.startedAt) * 1000);
  current.recencyAt = current.updatedAt = turn.completedAt;
  event('turn/completed', { turn });
}
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const reply = result => send({ id: m.id, result });
  if (!m.method) {
    const context = pending.get(m.id);
    if (context) {
      pending.delete(m.id);
      local.run(context, () => finish(`QA_RESPONSE_${m.result.decision ?? (m.result.answers ? 'answered' : m.result.action)}`));
    }
    return;
  }
  const context = contexts.get(m.params?.threadId) ?? { current: threads.get(m.params?.threadId) };
  local.run(context, () => {
  let { current, turn } = context;
  switch (m.method) {
    case 'initialize': reply({ userAgent: 'UI fixture', codexHome: process.env.QA_CODEX_HOME }); break;
    case 'initialized': break;
    case 'account/read': reply({ account: { type: 'test' } }); break;
    case 'model/list': reply({ data: [model('qa-model'), model('other-model')], nextCursor: null }); break;
    case 'thread/start': {
      const empty = m.params.cwd === process.env.QA_EMPTY_SESSION_CWD;
      current = { id: `qa-thread-${++seq}`, cwd: m.params.cwd, preview: empty ? '' : 'QA session', name: empty ? null : `QA session ${seq}`,
        createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, recencyAt: Date.now() / 1000, turns: [] };
      context.current = current; contexts.set(current.id, context);
      acquire(current.id);
      threads.set(current.id, current); reply(settings(current));
      notify('warning', { message: 'QA configuration notice' }); break;
    }
    case 'thread/list': {
      const activity = t => m.params.sortKey === 'recency_at' ? t.recencyAt ?? t.updatedAt : t.updatedAt;
      const rows = [...threads.values()].reverse().filter(t => !t.archived && (!m.params.cwd || t.cwd === m.params.cwd))
        .sort((a, b) => activity(b) - activity(a));
      const at = Number(m.params.cursor ?? 0), limit = Math.min(m.params.limit ?? 30, process.env.QA_SESSION_FIXTURES ? 4 : 30);
      reply({ data: rows.slice(at, at + limit), nextCursor: at + limit < rows.length ? String(at + limit) : null }); break;
    }
    case 'thread/archive': {
      const target = threads.get(m.params.threadId);
      if (!target || target.turns.some(t => t.status === 'inProgress')) {
        send({ id: m.id, error: { code: -32000, message: 'Session unavailable or still running' } }); break;
      }
      target.archived = true;
      owned.get(target.id)?.release(); owned.delete(target.id);
      reply({}); notify('thread/archived', { threadId: target.id }); break;
    }
    case 'thread/resume':
      if (process.env.QA_SESSION_FEEDBACK_TESTS && m.params.threadId === 'saved-4') {
        setTimeout(() => send({ id: m.id, error: { code: -32000, message: 'QA_RESUME_UNAVAILABLE' } }), 750); break;
      }
      if (!acquire(m.params.threadId)) {
        send({ id: m.id, error: { code: -32600, message: `thread ${m.params.threadId} already has an active writer` } }); break;
      }
      current = threads.get(m.params.threadId);
      context.current = current; contexts.set(current.id, context);
      // Opening history changes update metadata, but not conversation activity.
      if (process.env.QA_SESSION_FIXTURES) current.updatedAt = Date.now() / 1000;
      if (process.env.QA_SESSION_FEEDBACK_TESTS && m.params.threadId === 'saved-5')
        setTimeout(() => reply(settings(current)), 750);
      else reply(settings(current));
      break;
    case 'thread/turns/list': reply({ data: [...current.turns].reverse(), nextCursor: null }); break;
    case 'turn/start': {
      const text = m.params.input.filter(i => i.type === 'text').map(i => i.text).join('');
      if (text.includes('QA_DELAYED_REJECT')) {
        setTimeout(() => send({ id: m.id, error: { code: -32000, message: 'QA_DELAYED_REJECTED' } }), 1200);
        break;
      }
      current.preview ||= text || 'Image';
      current.recencyAt = current.updatedAt = Date.now() / 1000;
      turn = { id: `qa-turn-${++seq}`, items: [], status: 'inProgress', startedAt: Date.now() / 1000, durationMs: null };
      context.turn = turn;
      current.turns.push(turn);
      reply(text.includes('QA_UNCONFIRMED') ? { turn: null } : { turn });
      event('turn/started', { turn });
      add({ id: `user-${turn.id}`, type: 'userMessage', content: m.params.input });
      if (text.includes('disconnect')) { setTimeout(() => process.exit(9), 30); break; }
      if (text.includes('approval') || text.includes('question')) {
        const requestId = ++seq + 1000; pending.set(requestId, context);
        const question = text.includes('question');
        send({ id: requestId, method: question ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval',
          params: { threadId: current.id, turnId: turn.id, itemId: 'approval-item', command: 'echo QA_APPROVAL', cwd: process.cwd(),
            ...(question ? { questions: [{ id: 'color', header: 'Color', question: 'Choose a color', options: [{ label: 'Blue', description: 'Use blue' }, { label: 'Orange', description: 'Use orange' }], isOther: true }] } : {}) } });
      } else if (text.includes('background')) {
        setTimeout(() => finish('QA_BACKGROUND_DONE'), 1500);
      } else if (text.includes('edit fixture')) {
        const diff = 'diff --git a/note.txt b/note.txt\nnew file mode 100644\n--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+QA_FILE_OK\n';
        add({ id: `file-${turn.id}`, type: 'fileChange', status: 'completed', changes: [{ path: 'note.txt', kind: { type: 'add' }, diff }] });
        event('turn/diff/updated', { diff });
        setTimeout(() => finish('QA_EDIT_DONE'), 50);
      } else if (text.includes('QA_CITATION_FIXTURE')) {
        const citation = ':codex-file-citation{path="' + process.cwd() + '/.prototype/ui-qa/中文 [draft] (1) #?& 100%.txt" purpose="output"}';
        add({ id: `answer-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text: 'Read ' + citation.slice(0, -5) }, false);
        setTimeout(() => finish('Read ' + citation + '\n\nExample: `' + citation + '`'), 100);
      } else if (text.includes('hold')) {
        add({ id: `comment-${turn.id}`, type: 'agentMessage', phase: 'commentary', text: 'Checking the project…' });
        add({ id: `command-${turn.id}`, type: 'commandExecution', command: 'printf QA_OUTPUT', cwd: process.cwd(), status: 'inProgress',
          aggregatedOutput: Array.from({ length: 1000 }, (_, i) => `QA_OUTPUT_${i}`).join('\n') }, false);
      } else setTimeout(() => finish(m.params.input.some(i => i.type === 'localImage') ? 'QA_IMAGE_RECEIVED'
        : `QA_REPLY: ${text}\n\nQA_INPUT_BASE64: ${Buffer.from(text).toString('base64')}`), 50);
      break;
    }
    case 'turn/steer': reply({ turnId: turn.id }); add({ id: `steer-${++seq}`, type: 'userMessage', content: m.params.input }); finish('QA_STEERED'); break;
    case 'turn/interrupt': reply({}); finish('', 'interrupted'); break;
    default: reply({});
  }
  });
});
