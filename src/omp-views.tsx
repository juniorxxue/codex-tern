/** @jsxImportSource @stencil-hq/tern */
/**
 * Native node layouts adapted from can1357/oh-my-pi (MIT).
 * See THIRD_PARTY_NOTICES.md. The omp.* roles select Tern's built-in skin;
 * they are presentation hooks, never agent identity or model instructions.
 */
import type { Children } from '@stencil-hq/tern';

export function Welcome() {
  return <col key="welcome" role="omp.welcome" gap="sm">
    <row key="lockup" role="ct.welcome.lockup" gap="sm" align="center">
      <icon key="logo" name="app-codex" role="ct.logo" />
      <text key="wordmark" role="ct.welcome.wordmark" wrap="none">codex</text>
    </row>
    <text key="tip" role="ct.welcome.prompt">What would you like to work on?</text>
  </col>;
}

export function ComposerFrame(props: { running: boolean; children: Children }) {
  return <col key="body" role="omp.editor" tone={props.running ? 'pending' : undefined}>{props.children}</col>;
}

/** Same native working row as OMP's loader. Tern clocks the motion and timer. */
export function WorkingRow(props: { turnKey: string; age: number; reduceMotion: boolean }) {
  return <row key={`working-${props.turnKey}`} role="omp.working" align="center" gap="sm">
    <spinner key="spinner" style="starburst" tone="accent" />
    <elapsed key="elapsed" age={props.age} format="short" />
    <text key="sep" role="omp.working.sep" text="·" />
    {props.reduceMotion ? <text key="label" role="omp.working.label" tone="muted" text="Working…" />
      : <shimmer key="label" role="omp.working.label" text="Working…" mode="classic"
        palette={{ low: 'dim', mid: 'muted', high: 'accent' }} />}
    <row key="fill" grow={1} />
  </row>;
}
