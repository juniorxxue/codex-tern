#!/usr/bin/env bun
// Deterministic UI fixture. Never calls a model or executes a command.
import { createInterface } from 'node:readline';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FileLock } from '@oh-my-pi/pi-natives';
import { join } from 'node:path';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { proposalReply } from './proposals.mjs';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const notify = (method, params) => send({ method, params });
const threads = new Map();
if (process.env.QA_PROPOSAL_FIXTURES) threads.set('proposal-saved', {
  id: 'proposal-saved', cwd: process.cwd(), name: 'Saved proposals', preview: '',
  createdAt: 1792558800, updatedAt: 1792558800, recencyAt: 1792558800,
  turns: [{ id: 'proposal-saved-turn', status: 'completed', items: [
    { id: 'proposal-saved-answer', type: 'agentMessage', phase: 'final_answer', text: proposalReply },
  ] }],
});
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
let backgroundOnly = false;
const historyFile = process.env.QA_HISTORY_FILE;
if (historyFile && existsSync(historyFile)) {
  const history = JSON.parse(readFileSync(historyFile, 'utf8'));
  seq = history.seq;
  threads.clear();
  for (const thread of history.threads) {
    for (const turn of thread.turns) if (turn.status === 'inProgress') turn.status = 'interrupted';
    threads.set(thread.id, thread);
  }
}
function persist() {
  if (historyFile && !backgroundOnly) writeFileSync(historyFile, JSON.stringify({ seq, threads: [...threads.values()] }));
}
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
const settings = thread => ({ thread, cwd: thread.cwd, model: thread.model ?? 'qa-model', reasoningEffort: thread.reasoningEffort ?? 'high',
  approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: { type: 'workspaceWrite' } });
const event = (method, extra) => {
  const { current, turn } = local.getStore();
  notify(method, { threadId: current.id, turnId: turn.id, ...extra });
};
function add(item, done = true) {
  const { turn } = local.getStore();
  const existing = turn.items.findIndex(i => i.id === item.id);
  if (existing < 0) turn.items.push(item); else turn.items[existing] = item;
  persist();
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
  persist();
  event('turn/completed', { turn });
}
createInterface({ input: process.stdin }).on('line', async line => {
  const m = JSON.parse(line);
  if (process.env.QA_RPC_LOG) appendFileSync(process.env.QA_RPC_LOG,
    JSON.stringify({ pid: process.pid, method: m.method ?? 'response', threadId: m.params?.threadId,
      ephemeral: m.params?.ephemeral, source: m.params?.threadSource, cursor: m.params?.cursor, name: m.params?.name,
      useStateDbOnly: m.params?.useStateDbOnly }) + '\n');
  const gates = process.env.QA_STARTUP_RELEASE_DIR;
  const gate = m.method === 'account/read' ? 'account'
    : ['thread/start', 'thread/resume'].includes(m.method) ? 'session'
    : m.method === 'thread/list' && !m.params?.useStateDbOnly ? 'scan' : undefined;
  if (gates && gate) while (!existsSync(join(gates, gate))) await new Promise(resolve => setTimeout(resolve, 10));
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
    case 'config/read': reply({ config: {}, origins: {}, layers: null }); break;
    case 'thread/start': {
      if (m.params.ephemeral && !(m.params.threadSource === 'thread_outline' ? process.env.QA_TOC_FIXTURE : process.env.QA_GENERATED_TITLE)) {
        send({ id: m.id, error: { code: -32000, message: 'This background task is not enabled in the fixture' } }); break;
      }
      if (m.params.ephemeral) backgroundOnly = true;
      const empty = m.params.cwd === process.env.QA_EMPTY_SESSION_CWD;
      current = { id: backgroundOnly ? `qa-title-${process.pid}` : `qa-thread-${++seq}`, ephemeral: backgroundOnly,
        cwd: m.params.cwd, model: m.params.model ?? 'qa-model', preview: empty ? '' : 'QA session', name: empty ? null : `QA session ${seq}`,
        createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, recencyAt: Date.now() / 1000, turns: [] };
      context.current = current; contexts.set(current.id, context);
      context.source = m.params.threadSource;
      if (!backgroundOnly) acquire(current.id);
      threads.set(current.id, current); persist(); reply(settings(current));
      notify('thread/started', { thread: { ...current, turns: [] } });
      notify('warning', { message: 'QA configuration notice' }); break;
    }
    case 'thread/fork': {
      const source = threads.get(m.params.threadId);
      const at = source?.turns.findIndex(t => t.id === m.params.lastTurnId) ?? -1;
      if (!source || at < 0 || source.turns[at].status !== 'completed') {
        send({ id: m.id, error: { code: -32000, message: 'Choose a completed turn' } }); break;
      }
      const fork = { ...structuredClone(source), id: `qa-thread-${++seq}`, forkedFromId: source.id,
        name: `Fork of ${source.name || source.preview}`, cwd: m.params.cwd ?? source.cwd,
        model: m.params.model ?? source.model, reasoningEffort: m.params.config?.model_reasoning_effort ?? source.reasoningEffort,
        createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, recencyAt: Date.now() / 1000,
        turns: structuredClone(source.turns.slice(0, at + 1)) };
      // Forking must not replace the source's live AsyncLocalStorage context.
      threads.set(fork.id, fork); contexts.set(fork.id, { current: fork }); acquire(fork.id); persist();
      notify('thread/started', { thread: { ...fork, turns: [] } });
      reply(settings({ ...fork, turns: m.params.excludeTurns ? [] : fork.turns })); break;
    }
    case 'thread/name/set': {
      const target = threads.get(m.params.threadId);
      if (!target || target.archived || m.params.name === 'QA_RENAME_REJECT') {
        send({ id: m.id, error: { code: -32000, message: 'QA_RENAME_UNAVAILABLE' } }); break;
      }
      target.name = m.params.name; persist(); reply({});
      notify('thread/name/updated', { threadId: target.id, threadName: target.name }); break;
    }
    case 'thread/list': {
      const activity = t => m.params.sortKey === 'recency_at' ? t.recencyAt ?? t.updatedAt : t.updatedAt;
      const rows = [...threads.values()].reverse().filter(t => !t.ephemeral && !t.archived && (!m.params.cwd || t.cwd === m.params.cwd))
        .sort((a, b) => activity(b) - activity(a));
      const at = Number(m.params.cursor ?? 0), limit = Math.min(m.params.limit ?? 30, process.env.QA_SESSION_FIXTURES ? 4 : 30);
      const data = rows.slice(at, at + limit).map(t => gates && m.params.useStateDbOnly && t.id === 'saved-2'
        ? { ...t, name: 'Cached session 2' } : t);
      reply({ data, nextCursor: at + limit < rows.length ? String(at + limit) : null }); break;
    }
    case 'thread/archive': {
      const target = threads.get(m.params.threadId);
      if (!target || target.turns.some(t => t.status === 'inProgress')) {
        send({ id: m.id, error: { code: -32000, message: 'Session unavailable or still running' } }); break;
      }
      target.archived = true;
      persist();
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
      if (!current) { send({ id: m.id, error: { code: -32000, message: 'Session not found' } }); break; }
      context.current = current; contexts.set(current.id, context);
      // Opening history changes update metadata, but not conversation activity.
      if (process.env.QA_SESSION_FIXTURES) current.updatedAt = Date.now() / 1000;
      if (process.env.QA_SESSION_FEEDBACK_TESTS && m.params.threadId === 'saved-5')
        setTimeout(() => reply(settings(current)), 750);
      else reply(settings(current));
      break;
    case 'thread/turns/list': {
      const sorted = [...current.turns].reverse();
      const start = process.env.QA_TOC_FIXTURE ? Number(m.params.cursor ?? 0) : 0;
      const limit = process.env.QA_TOC_FIXTURE ? m.params.limit ?? 15 : sorted.length;
      reply({ data: sorted.slice(start, start + limit), nextCursor: start + limit < sorted.length ? String(start + limit) : null }); break;
    }
    case 'thread/read': reply({ thread: threads.get(m.params.threadId) }); break;
    case 'thread/unsubscribe': reply({}); notify('thread/closed', { threadId: m.params.threadId }); break;
    case 'turn/start': {
      const text = m.params.input.filter(i => i.type === 'text').map(i => i.text).join('');
      if (text.includes('QA_DELAYED_REJECT')) {
        setTimeout(() => send({ id: m.id, error: { code: -32000, message: 'QA_DELAYED_REJECTED' } }), 1200);
        break;
      }
      current.preview ||= text || 'Image';
      current.recencyAt = current.updatedAt = Date.now() / 1000;
      current.model = m.params.model ?? current.model ?? 'qa-model';
      current.reasoningEffort = m.params.effort ?? current.reasoningEffort ?? 'high';
      turn = { id: `qa-turn-${++seq}`, items: [], status: 'inProgress', startedAt: Date.now() / 1000, durationMs: null,
        model: current.model, effort: current.reasoningEffort };
      context.turn = turn;
      current.turns.push(turn);
      if (text.includes('QA_CRASH_DELIVERY')) {
        turn.items.push({ id: `user-${turn.id}`, type: 'userMessage', content: m.params.input });
        persist(); process.exit(9);
      }
      reply(text.includes('QA_UNCONFIRMED') ? { turn: null } : { turn });
      event('turn/started', { turn });
      add({ id: `user-${turn.id}`, type: 'userMessage', content: m.params.input });
      if (current.ephemeral) {
        if (context.source === 'thread_outline') {
          const input = JSON.parse(text), topics = structuredClone(input.previousOutline.topics);
          for (const message of input.evidence) {
            const build = message.text.includes('BUILD');
            if (message.role === 'assistant') {
              const root = topics.find(t => t.id === 'rules');
              if (root && message.text.includes('REPAIR')) root.title = 'Substitution and its repair';
              continue;
            }
            const scrollTopic = message.text.match(/SCROLLTOPIC(\d+)/)?.[1];
            const id = scrollTopic ? `section-${scrollTopic}` : build ? 'build' : 'rules';
            let root = topics.find(t => t.id === id);
            if (!root) { root = { id, title: scrollTopic ? `Topic ${scrollTopic}` : build ? 'Build failure' : 'Substitution rule', summary: 'Fixture topic', anchors: [message.anchor], children: [] }; topics.push(root); }
            if (message.text.includes('RETURN') && !root.anchors.includes(message.anchor)) root.anchors.push(message.anchor);
            const label = message.text.includes('COUNTEREXAMPLE') ? 'Counterexample' : message.text.includes('SUGGEST') ? 'Proposed repair' : '';
            if (label && !root.children.some(c => c.title === label)) root.children.push({ id: label === 'Counterexample' ? 'counter' : 'repair', title: label, summary: 'Fixture subtopic', anchors: [message.anchor] });
          }
          const done = () => finish(JSON.stringify({ topics }));
          if (process.env.QA_TOC_RELEASE_FILE) {
            const interval = setInterval(() => { if (existsSync(process.env.QA_TOC_RELEASE_FILE)) { clearInterval(interval); done(); } }, 25);
          } else setTimeout(done, 100);
          break;
        }
        const done = () => finish(JSON.stringify({ title: process.env.QA_GENERATED_TITLE ?? '自动命名会话' }));
        if (process.env.QA_TITLE_RELEASE_FILE) {
          const interval = setInterval(() => {
            if (existsSync(process.env.QA_TITLE_RELEASE_FILE)) { clearInterval(interval); done(); }
          }, 25);
        } else setTimeout(done, 500);
        break;
      }
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
      } else if (text.includes('QA_PROPOSAL_FIXTURE')) {
        add({ id: `answer-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text: proposalReply.slice(0, proposalReply.indexOf('\n:::')) }, false);
        setTimeout(() => finish(proposalReply), 900);
      } else if (text.includes('QA_CITATION_FIXTURE')) {
        const citation = ':codex-file-citation{path="' + process.cwd() + '/.prototype/ui-qa/中文 [draft] (1) #?& 100%.txt" purpose="output"}';
        add({ id: `answer-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text: 'Read ' + citation.slice(0, -5) }, false);
        setTimeout(() => finish('Read ' + citation + '\n\nExample: `' + citation + '`'), 100);
      } else if (text.includes('QA_FILE_LINKS_FIXTURE')) {
        finish([
          String.raw`[First](./README.md) and **[Second](./.prototype/ui-qa/second.txt:2:1)**; [web](https://example.com). Whole-value ascription \((V:T)\).`,
          '',
          '| Current notation | Suggested notation |',
          '|---|---|',
          '| [`P` and its later superscript](./README.md) | \\(T_f\\) and \\(T_{\\mathrm{rec}}\\) |',
        ].join('\n'));
      } else if (text.includes('QA_CONTINUING_TURN')) {
        add({ id: `command-${turn.id}`, type: 'commandExecution', command: 'echo ready', status: 'completed', exitCode: 0 });
        add({ id: `interim-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text: 'QA_INTERIM_ANSWER: Should I change the core rules too?' });
      } else if (text.includes('hold')) {
        add({ id: `comment-${turn.id}`, type: 'agentMessage', phase: 'commentary', text: 'Checking the project…' });
        add({ id: `command-${turn.id}`, type: 'commandExecution', command: 'printf QA_OUTPUT', cwd: process.cwd(), status: 'inProgress',
          aggregatedOutput: Array.from({ length: 1000 }, (_, i) => `QA_OUTPUT_${i}`).join('\n') }, false);
      } else setTimeout(() => finish(m.params.input.some(i => i.type === 'localImage') ? 'QA_IMAGE_RECEIVED'
        : `QA_REPLY: ${text}\n\nQA_INPUT_BASE64: ${Buffer.from(text).toString('base64')}`), 50);
      break;
    }
    case 'turn/steer': {
      reply({ turnId: turn.id });
      if (m.params.input.some(i => i.type === 'text' && i.text.includes('QA_DELAYED_STEER'))) {
        setTimeout(() => {
          add({ id: `steer-${++seq}`, type: 'userMessage', clientId: m.params.clientUserMessageId, content: m.params.input });
          finish('QA_STEERED');
        }, 1500);
        break;
      }
      add({ id: `steer-${++seq}`, type: 'userMessage', clientId: m.params.clientUserMessageId, content: m.params.input });
      if (turn.items.some(i => i.id === `interim-${turn.id}`)
        && !m.params.input.some(i => i.type === 'text' && i.text.includes('QA_FINISH_CONTINUING'))) {
        add({ id: `reasoning-${turn.id}`, type: 'reasoning', summary: [], content: [] }, false);
      } else finish('QA_STEERED');
      break;
    }
    case 'turn/interrupt': reply({}); finish('', 'interrupted'); break;
    default: reply({});
  }
  });
});
