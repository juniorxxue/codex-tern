/** @jsxImportSource @stencil-hq/tern */
import { html } from '@stencil-hq/tern';
import { basename } from 'node:path';
import type { Controller } from './controller';
import type { Draft } from './draft';

export function modelName(c: Controller, model?: string) {
  return model ? c.models.find(m => m.model === model)?.displayName ?? model : 'Use Codex default';
}
const effortName = (value: string) => ({ default: 'Default', none: 'None', minimal: 'Minimal', low: 'Low',
  medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' }[value] ?? value);
const pathLabel = (path: string) => process.env.HOME && path.startsWith(process.env.HOME + '/')
  ? '~' + path.slice(process.env.HOME.length) : path;
const row = (label: string, value: string, mono = false) => <html.div class="ct-detail-row">
  <html.span class="ct-detail-label">{label}</html.span>
  <html.span class={`ct-detail-value${mono ? ' ct-mono' : ''}`}>{value}</html.span>
</html.div>;

export function SessionDetails({ c, chooseModel, chooseEffort, chooseDefault, close }: {
  c: Controller; chooseModel: () => void; chooseEffort: () => void; chooseDefault: () => void; close: () => void;
}) {
  const access = c.effective?.sandbox?.type;
  const policy = c.effective?.approvalPolicy;
  const approvals = policy === 'on-request' ? 'When needed' : policy === 'untrusted' ? 'Untrusted commands'
    : policy === 'never' ? 'Never ask' : typeof policy === 'object' ? 'Custom rules' : 'Default';
  const reviewer = c.effective?.approvalsReviewer;
  const notices = c.notices.filter(n => !n.error);
  return <>
    <html.div class="ct-dialog-hero">
      <html.div class="ct-dialog-icon"><icon name="message" /></html.div>
      <html.div class="ct-dialog-heading">
        <html.div class="ct-dialog-title">{(c.thread?.name || c.thread?.preview || 'New session').replace(/\s+/g, ' ').slice(0, 120)}</html.div>
        <html.div class="ct-dialog-subtitle">{basename(c.cwd)} · {c.account}</html.div>
      </html.div>
      <html.span class="ct-session-state">{c.connection !== 'ready' ? 'Disconnected' : c.activeTurn ? 'Working' : 'Ready'}</html.span>
    </html.div>
    <html.div class="ct-detail-summary">
      <html.button class="ct-detail-card" aria="Change session model" attrs={{ 'aria-disabled': c.busy }} onClick={c.busy ? undefined : chooseModel}>
        <html.span class="ct-card-label"><icon name="model" />Model</html.span>
        <html.span class="ct-card-value">{modelName(c, c.model)}</html.span>
        <html.span class="ct-card-hint">{c.busy ? 'Current session' : 'Change model'}<icon name="chev-r" /></html.span>
      </html.button>
      <html.button class="ct-detail-card" aria="Change session reasoning" attrs={{ 'aria-disabled': c.busy }} onClick={c.busy ? undefined : chooseEffort}>
        <html.span class="ct-card-label"><icon name="brain" />Reasoning</html.span>
        <html.span class="ct-card-value">{effortName(c.effort)}</html.span>
        <html.span class="ct-card-hint">{c.busy ? 'Current session' : 'Change effort'}<icon name="chev-r" /></html.span>
      </html.button>
    </html.div>
    <html.div class="ct-detail-facts">
      {row('Workspace', pathLabel(c.cwd))}
      {row('File access', access === 'workspaceWrite' ? 'Workspace and allowed folders' : access === 'readOnly' ? 'Read only'
        : access === 'dangerFullAccess' ? 'Full access' : access === 'externalSandbox' ? 'Managed externally' : 'Loading…')}
      {row('Approvals', approvals + (reviewer === 'auto_review' || reviewer === 'guardian_subagent' ? ' · Automatic review' : reviewer === 'user' ? ' · Ask you' : ''))}
    </html.div>
    <html.button class="ct-default-model" aria="New session model" onClick={chooseDefault}>
      <icon name="plus" /><html.div class="ct-default-copy"><html.span class="ct-card-label">New session model</html.span>
        <html.span class="ct-default-value">{modelName(c, c.newSessionModel)}</html.span>
        <html.span class="ct-card-hint">Used for new sessions in every workspace</html.span></html.div><icon name="chev-r" />
    </html.button>
    <section key="technical" role="ct.details.technical" head="Technical details" collapsible collapsed>
      <html.div class="ct-detail-facts">
        {row('Client', 'Codex × Tern 0.1.0')}
        {row('Session ID', c.thread?.id ?? 'Not created', true)}
        {row('Backend', c.rpc.options?.binary ?? process.env.CODEX_BINARY ?? 'codex', true)}
      </html.div>
      <section head="Diagnostics" collapsible collapsed><code text={c.diagnostics.join('\n').slice(-12000) || 'No diagnostics.'} lang="text" wrap /></section>
    </section>
    {!!notices.length && <section key="notices" role="ct.details.notices" head={`Notices · ${notices.length}`} collapsible collapsed>
      {notices.map(n => <text key={n.id} text={n.text} />)}
    </section>}
    <html.div class="ct-dialog-footer"><html.span class="ct-footer-hint">Esc to close</html.span>
      <html.button class="ct-button" aria="Close details" onClick={close}>Done</html.button></html.div>
  </>;
}

export function WorkspaceForm({ c, draft, path, error, opening, edit, focus, browse, chooseDefault, submit, close }: {
  c: Controller; draft: Draft; path: string; error: string; opening: boolean;
  edit: () => void; focus: () => void; browse: () => void; chooseDefault: () => void; submit: () => void; close: () => void;
}) {
  return <>
    <html.div class="ct-dialog-intro">Choose where your next session works.</html.div>
    <html.div class="ct-workspace-preview"><html.div class="ct-dialog-icon"><icon name="folder-open" /></html.div>
      <html.div class="ct-dialog-heading"><html.div class="ct-dialog-title">{basename(path) || path}</html.div>
        <html.div class="ct-workspace-fullpath">{pathLabel(path)}</html.div></html.div></html.div>
    <html.div class="ct-field-heading"><html.span>Folder path</html.span>
      <html.button class="ct-browse" aria="Browse folders" attrs={{ 'aria-disabled': opening }} onClick={opening ? undefined : browse}>
        <icon name="folder" />Browse</html.button></html.div>
    <input key="field" role="ct.workspace.path" aria="Workspace folder" text={draft.text} cursor={draft.cursor} anchor={draft.anchor}
      placeholder="Paste or type a folder path" onEdit={e => { if (!opening) { draft.nativeEdit(e); edit(); } }}
      onUndo={() => { if (!opening) { draft.undo(); edit(); } }} onFocus={focus} />
    {error && <html.div class="ct-field-error" role="ct.workspace.error"><icon name="warn" />{error}</html.div>}
    <html.button class="ct-default-model" aria="New session model" attrs={{ 'aria-disabled': opening }} onClick={opening ? undefined : chooseDefault}>
      <icon name="model" /><html.div class="ct-default-copy"><html.span class="ct-card-label">New session model</html.span>
        <html.span class="ct-default-value">{modelName(c, c.newSessionModel)}</html.span></html.div><icon name="chev-r" />
    </html.button>
    <html.div class="ct-dialog-footer"><html.span class="ct-footer-hint">Current sessions keep running</html.span>
      <html.button class="ct-button" aria="Cancel workspace" onClick={close}>Cancel</html.button>
      <html.button class="ct-button ct-primary" aria="Create session" attrs={{ 'aria-disabled': opening || !draft.text.trim() }}
        onClick={opening || !draft.text.trim() ? undefined : submit}>{opening ? 'Opening…' : 'Create session'}</html.button></html.div>
  </>;
}
