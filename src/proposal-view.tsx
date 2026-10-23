/** @jsxImportSource @stencil-hq/tern */
import { html } from '@stencil-hq/tern';
import { proposalDiff, type ProposalRun } from './proposals';

function paragraph(runs: ProposalRun[], side: 'before' | 'after') {
  const paragraphs: ProposalRun[][] = [[]];
  for (const run of runs) {
    if (run.kind === 'break') paragraphs.push([]);
    else paragraphs.at(-1)!.push(run);
  }
  return paragraphs.map((runs, p) => <html.div key={`p${p}`} class="ct-proposal-paragraph">
    {runs.map((run, n) => {
      const change = run.changed ? side === 'before' ? 'ct-proposal-del' : 'ct-proposal-ins' : '';
      if (run.kind === 'math') {
        const props = { key: `r${n}`, class: `ct-proposal-math ${run.display ? 'ct-proposal-display' : ''} ${change}` };
        const formula = <md text={run.raw} />;
        return run.display ? <html.div {...props}>{formula}</html.div> : <html.span {...props}>{formula}</html.span>;
      }
      if (run.kind === 'markdown') {
        const emphasis = /^(\*\*|__|\*|_)([\s\S]+)\1$/.exec(run.raw);
        // Plain emphasis can inherit the diff color directly. Keep richer inline
        // content (including math) on Tern's Markdown path.
        if (emphasis && !/[$\\`\[\]*_~]/.test(emphasis[2]!)) {
          const props = { key: `r${n}`, class: change, text: emphasis[2]! };
          return emphasis[1]!.length === 2 ? <html.strong {...props} /> : <html.em {...props} />;
        }
        return <html.span key={`r${n}`} class={`ct-proposal-inline ${change}`}><md text={run.raw} /></html.span>;
      }
      return <html.span key={`r${n}`} class={change} text={run.raw} />;
    })}
  </html.div>);
}

export function ProposalView({ before, after, number, checked, disabled, onSelect }: {
  before: string; after: string; number: number; checked: boolean; disabled: boolean; onSelect: (checked: boolean) => void;
}) {
  const diff = proposalDiff(before, after);
  return <html.div class="ct-proposal" role="ct.proposal">
    <html.label class="ct-proposal-choice">
      <html.input type="checkbox" aria={`Select edit ${number}`} checked={checked} disabled={disabled}
        onChange={event => onSelect(event.checked === true)} />
      <html.span text={`Edit ${number}`} />
    </html.label>
    <html.div role="ct.proposal.before" class="ct-proposal-side">
      <html.div class="ct-proposal-label" text="Original" />
      <html.div class="ct-proposal-prose">{paragraph(diff.before, 'before')}</html.div>
    </html.div>
    <html.div role="ct.proposal.after" class="ct-proposal-side">
      <html.div class="ct-proposal-label" text="Suggested" />
      <html.div class="ct-proposal-prose">{paragraph(diff.after, 'after')}</html.div>
    </html.div>
  </html.div>;
}
