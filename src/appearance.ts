import { css } from '@stencil-hq/tern';

// Tern confines program sheets to region descendants. The window plugin
// wraps this same sheet in a surface selector for clients already running.
// Open leading for mixed Chinese/English text, using the installed reading fonts.
export const appearanceStyles = css`
  .sf {
    --ct-prose: "Concourse T3", "LXGW Neo XiHei", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  /* Form dialogs need an opaque surface over the conversation. */
  .sf.sf-overlay.modal > .sf-ov-card {
    background: var(--card);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .sf.sf-overlay[data-role="ct.dialog.details"],
  .sf.sf-overlay[data-role="ct.dialog.workspace"],
  .sf.sf-overlay[data-role="ct.dialog.rename"] {
    font-family: var(--ct-prose);
    font-size: 14px;
    line-height: 21px;
  }
  .sf.sf-overlay[data-role="ct.dialog.details"] > .sf-ov-card,
  .sf.sf-overlay[data-role="ct.dialog.workspace"] > .sf-ov-card,
  .sf.sf-overlay[data-role="ct.dialog.rename"] > .sf-ov-card {
    width: 560px;
    max-width: calc(100% - 32px);
    border-radius: 18px;
  }
  .sf.sf-overlay[data-role="ct.dialog.details"] .sf-ov-head,
  .sf.sf-overlay[data-role="ct.dialog.workspace"] .sf-ov-head,
  .sf.sf-overlay[data-role="ct.dialog.rename"] .sf-ov-head {
    padding: 20px 24px 14px;
    font: 600 18px/24px var(--ct-prose);
  }
  .sf.sf-overlay[data-role="ct.dialog.details"] .sf-ov-body,
  .sf.sf-overlay[data-role="ct.dialog.workspace"] .sf-ov-body,
  .sf.sf-overlay[data-role="ct.dialog.rename"] .sf-ov-body { padding: 20px 24px 16px; }
  .sf.sf-overlay[data-role="ct.dialog.details"] .sf-ov-body > .sf-col,
  .sf.sf-overlay[data-role="ct.dialog.workspace"] .sf-ov-body > .sf-col,
  .sf.sf-overlay[data-role="ct.dialog.rename"] .sf-ov-body > .sf-col { gap: 0; min-width: 0; }
  .sf.sf-overlay[data-role="ct.dialog.rename"] > .sf-ov-card { width: 480px; }
  .sf.sf-overlay[data-role="ct.dialog.rename"] .sf-ov-head { padding-bottom: 0; box-shadow: none; }
  .sf.sf-overlay[data-role="ct.dialog.rename"] .sf-ov-body { padding-bottom: 20px; }
  .sf.sf-overlay[data-role="ct.dialog.rename"] .ct-dialog-footer { border-top: 0; padding-top: 0; margin-top: 20px; }
  .ct-dialog-hero, .ct-workspace-preview { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .ct-dialog-heading { flex: 1; min-width: 0; }
  .ct-dialog-icon { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px;
    flex-shrink: 0; border-radius: 12px; color: var(--t2); background: var(--raise); }
  .ct-dialog-icon .sf-icon, .ct-dialog-icon .ico { width: 20px; height: 20px; }
  .ct-dialog-title { font: 500 15px/22px var(--ct-prose); color: var(--t1); overflow-wrap: anywhere; }
  .ct-dialog-subtitle { font: 12px/18px var(--ct-prose); color: var(--t3); margin-top: 3px; overflow-wrap: anywhere; }
  .ct-session-state { flex-shrink: 0; font: 11px/18px var(--ct-prose); color: var(--t2);
    border: 1px solid var(--l2); border-radius: 20px; padding: 2px 9px; }
  .ct-detail-summary { display: flex; gap: 12px; margin: 20px 0 12px; }
  .ct-detail-card { display: flex; flex-direction: column; gap: 7px; flex: 1; min-width: 0; text-align: left;
    border: 1px solid var(--l2); border-radius: 12px; padding: 14px; background: var(--raise); cursor: pointer; }
  .ct-card-label { display: flex; align-items: center; gap: 6px; font: 12px/18px var(--ct-prose); color: var(--t3); }
  .ct-card-label .sf-icon, .ct-card-label .ico { width: 14px; height: 14px; }
  .ct-card-value { font: 500 16px/23px var(--ct-prose); color: var(--t1); overflow-wrap: anywhere; }
  .ct-card-hint { display: flex; align-items: center; gap: 4px; font: 11px/17px var(--ct-prose); color: var(--t3); }
  .ct-card-hint .sf-icon, .ct-card-hint .ico { width: 11px; height: 11px; }
  .ct-detail-card:not([aria-disabled="true"]):hover { border-color: var(--t3); }
  .ct-detail-card[aria-disabled="true"] { cursor: default; }
  .ct-detail-facts { display: flex; flex-direction: column; }
  .ct-detail-row { display: flex; align-items: baseline; gap: 16px; padding: 8px 0; font: 13px/20px var(--ct-prose); }
  .ct-detail-label { width: 88px; flex-shrink: 0; color: var(--t3); }
  .ct-detail-value { flex: 1; min-width: 0; color: var(--t1); overflow-wrap: anywhere; }
  .ct-mono { font: 11px/19px var(--mono); }
  .ct-default-model { display: flex; align-items: center; gap: 12px; width: 100%; margin: 16px 0;
    padding: 12px 14px; border: 1px solid var(--l2); border-radius: 12px; background: transparent;
    text-align: left; color: var(--t2); cursor: pointer; }
  .ct-default-model:not([aria-disabled="true"]):hover { background: var(--raise); }
  .ct-default-model > .sf-icon, .ct-default-model > .sf-icon .ico { width: 16px; height: 16px; flex-shrink: 0; }
  .ct-default-copy { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .ct-default-value { font: 500 14px/21px var(--ct-prose); color: var(--t1); overflow-wrap: anywhere; }
  .sf.sf-section[data-role="ct.details.technical"], .sf.sf-section[data-role="ct.details.notices"] {
    font: 12px/20px var(--ct-prose); margin: 0; padding: 4px 0; color: var(--t3);
  }
  .sf.sf-section[data-role="ct.details.technical"] .sf-text,
  .sf.sf-section[data-role="ct.details.notices"] .sf-text { font-family: var(--ct-prose); font-size: 12px; }
  .ct-dialog-footer { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap;
    gap: 8px; padding-top: 16px; margin-top: 16px; border-top: 1px solid var(--l2); }
  .ct-footer-hint { flex: 1; font: 11px/18px var(--ct-prose); color: var(--t3); min-width: 80px; }
  .ct-dialog-footer .sf.sf-el.ct-button { flex: 0 0 auto; min-height: 34px; width: auto; padding: 6px 14px;
    border-radius: 8px; font: 13px/20px var(--ct-prose); }
  .ct-dialog-intro { font: 14px/22px var(--ct-prose); color: var(--t2); margin-bottom: 18px; }
  .ct-workspace-preview { align-items: flex-start; margin-bottom: 22px; }
  .ct-workspace-fullpath { font: 12px/19px var(--ct-prose); color: var(--t3); overflow-wrap: anywhere; margin-top: 4px; }
  .ct-field-heading { display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 8px; font: 500 12px/20px var(--ct-prose); color: var(--t2); }
  .ct-browse { display: flex; align-items: center; gap: 5px; padding: 3px 6px; border-radius: 6px;
    font: 12px/20px var(--ct-prose); color: var(--t2); cursor: pointer; background: transparent; }
  .ct-browse .sf-icon, .ct-browse .ico { width: 13px; height: 13px; }
  .ct-browse:hover { background: var(--raise); }
  .sf.sf-input[data-role="ct.workspace.path"], .sf.sf-input[data-role="ct.workspace.path"].focused,
  .sf.sf-input[data-role="ct.session.name"], .sf.sf-input[data-role="ct.session.name"].focused {
    background: var(--raise); border: 1px solid var(--l2); border-radius: 9px; min-height: 40px;
    padding: 9px 12px; font: 12px/20px var(--mono);
  }
  .sf.sf-input[data-role="ct.session.name"], .sf.sf-input[data-role="ct.session.name"].focused {
    font: 14px/22px var(--ct-prose); letter-spacing: 0; min-width: 0;
  }
  .sf.sf-input[data-role="ct.workspace.path"].focused,
  .sf.sf-input[data-role="ct.session.name"].focused { border-color: var(--accent); box-shadow: none; }
  .sf.sf-input[data-role="ct.workspace.path"] .sf-ed-text,
  .sf.sf-input[data-role="ct.session.name"] .sf-ed-text { white-space: nowrap; font: inherit; }
  .ct-field-error { display: flex; align-items: center; gap: 7px; color: var(--bad); font: 12px/19px var(--ct-prose); margin-top: 8px; }
  .ct-field-error .sf-icon, .ct-field-error .ico { width: 13px; height: 13px; flex-shrink: 0; }
  .ct-default-model:focus-visible, .ct-detail-card:focus-visible, .ct-browse:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .sf.sf-card[data-role="omp.user"],
  .sf.sf-col[data-role="omp.assistant"],
  .sf.sf-card[data-role="omp.welcome"],
  .sf.sf-col[data-role="omp.welcome"],
  .sf.sf-row[data-role="ct.fork.origin"],
  .sf.sf-el.ct-activity {
    width: 100%;
    max-width: 736px;
    margin-left: auto;
    margin-right: auto;
  }
  .sf.sf-col[data-role="omp.assistant"] {
    padding: 0;
    margin-top: 0;
    margin-bottom: 0;
  }
  .sf.sf-col[data-role="omp.assistant"] > .sf-md,
  .sf.sf-card[data-role="omp.user"] > .sf-md { gap: 16px; }
  .sf.sf-row[data-role="ct.reply.actions"] { margin-top: 8px; }
  .ct-reply-action {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--ct-prose); font-size: 12px; line-height: 20px;
    padding: 3px 6px; border-radius: 6px; color: var(--t3); cursor: pointer;
  }
  .ct-reply-action:hover { color: var(--t1); background: var(--raise); }
  .ct-reply-action:focus-visible { outline: 1px solid var(--accent); }
  .ct-reply-action[aria-disabled="true"] { opacity: 0.45; cursor: default; }
  .ct-reply-action .sf-icon { width: 14px; height: 14px; }
  .sf.sf-row[data-role="ct.fork.origin"] { font-size: 12px; color: var(--t3); margin-bottom: 12px; }
  .ct-proposal {
    font-family: var(--ct-prose);
    font-size: 17px;
    line-height: 29px;
    color: var(--t1);
    margin: 8px 0;
    min-width: 0;
  }
  .ct-proposal-side + .ct-proposal-side { margin-top: 14px; }
  .ct-proposal-label { color: var(--t3); font-size: 12px; line-height: 20px; margin-bottom: 4px; }
  .ct-proposal-choice { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; color: var(--t2); cursor: pointer; }
  .ct-proposal-choice [role="checkbox"] { cursor: pointer; }
  .ct-proposal-choice [aria-disabled="true"] { cursor: default; }
  .ct-proposal-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 4px 0 12px; }
  .ct-proposal-count { color: var(--t3); font-size: 12px; }
  .ct-proposal-apply { font-size: 13px; cursor: pointer; }
  .ct-proposal-apply[aria-disabled="true"] { opacity: 0.45; cursor: default; }
  .ct-proposal-apply:focus-visible, .ct-proposal-choice [role="checkbox"]:focus-visible { outline: 1px solid var(--accent); }
  .ct-proposal-prose { overflow-wrap: anywhere; }
  .ct-proposal-paragraph + .ct-proposal-paragraph { margin-top: 16px; }
  .ct-proposal-del { --t1: var(--bad); color: var(--bad); text-decoration: line-through; }
  .ct-proposal-ins { --t1: var(--sf-c-ins, var(--good)); color: var(--sf-c-ins, var(--good)); background: var(--ct-proposal-added-bg); }
  .ct-proposal { --ct-proposal-added-bg: color-mix(in srgb, var(--sf-c-ins, var(--good)) 12%, transparent); }
  .ct-proposal-inline .sf-md,
  .ct-proposal-inline .md,
  .ct-proposal-inline .md p { display: inline; margin: 0; padding: 0; }
  /* Give Tern's typeset SVG its own inline layout box; a fully inline md shrinks it. */
  .ct-proposal-math:not(.ct-proposal-display) .sf-md { display: inline-block; vertical-align: baseline; margin: 0; padding: 0; }
  .ct-proposal .math svg { width: auto; height: auto; max-width: none; }
  .ct-proposal-display { margin: 8px 0; text-align: center; }
  .ct-proposal-display .math-display { display: inline-block; }
  .ct-proposal-display.ct-proposal-ins { background: transparent; }
  .ct-proposal-display.ct-proposal-ins .math-display { background: var(--ct-proposal-added-bg); }
  .sf.sf-col[data-role="omp.assistant"] .ct-proposal .ct-proposal-del .sf-md * { color: var(--bad); }
  .sf.sf-col[data-role="omp.assistant"] .ct-proposal .ct-proposal-ins .sf-md * { color: var(--sf-c-ins, var(--good)); }
  .ct-proposal-del .math, .ct-proposal-del .math-display { position: relative; }
  .ct-proposal-del .math { display: inline-block; }
  .ct-proposal-del .math::after, .ct-proposal-del .math-display::after {
    content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: currentColor;
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md {
    font-family: var(--ct-prose);
    font-size: 17px;
    line-height: 29px;
    letter-spacing: 0;
    color: var(--t1);
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md p { margin: 0; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md strong,
  .sf.sf-card[data-role="omp.user"] .sf-md .md strong { font-weight: 600; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h1,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h2,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h3,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h4 {
    font-family: var(--ct-prose) !important;
    font-weight: 600;
    line-height: 29px;
    margin: 10px 0 0;
    letter-spacing: 0;
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h1 { font-size: 22px !important; line-height: 32px; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h2 { font-size: 20px !important; line-height: 30px; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h3,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h4 { font-size: 18px !important; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md > .md:first-child > :first-child { margin-top: 0; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md ul,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md ol {
    margin: 0;
    padding-left: 28px;
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md li { margin: 0; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md li + li { margin-top: 6px; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md li p + p { margin-top: 8px; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md blockquote {
    margin: 0;
    padding: 0 0 0 14px;
    font-family: var(--ct-prose);
    font-size: inherit;
    line-height: inherit;
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md .code {
    position: relative;
    margin: 0;
    border: 1px solid var(--l2);
    border-radius: 12px;
    background: var(--card);
    overflow: hidden;
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md pre {
    margin: 0;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    background: transparent;
    padding: 14px;
    overflow-x: auto;
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md .code-head {
    position: absolute;
    top: 4px;
    right: 8px;
    height: 22px;
    min-height: 0;
    padding: 0;
    border: 0;
    background: var(--card);
    font-family: var(--ct-prose);
    opacity: 0;
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md .code:hover .code-head,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md .code:focus-within .code-head { opacity: 1; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md code,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md pre {
    font-family: var(--mono);
    font-size: 14px;
    line-height: 22px;
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md pre code { font-size: inherit; }
  .sf.sf-card[data-role="omp.user"] .sf-md .md {
    font-family: var(--ct-prose);
    font-size: 17px;
    line-height: 29px;
    letter-spacing: 0;
  }
  .sf.sf-col[data-role="omp.editor"],
  .sf.sf-row[data-role="omp.working"],
  .sf.sf-section[data-role="omp.queue"],
  .sf.sf-el.ct-request {
    width: 100%;
    max-width: 768px;
    margin-left: auto;
    margin-right: auto;
  }
  .sf.sf-col[data-role="omp.editor"] {
    /* Keep the custom three-row layout when Tern unfocuses the pane. */
    padding: 0 !important;
    min-height: 0 !important;
    margin-top: 0;
    margin-bottom: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    outline: none;
    backdrop-filter: none;
    filter: none;
    box-shadow: none;
    gap: 4px !important;
    animation: none;
    transition: none;
    transform: none;
  }
  .sf.sf-col[data-role="omp.editor"]::before,
  .sf.sf-col[data-role="omp.editor"]::after { display: none; }
  .sf.sf-col[data-role="omp.editor"] > :is([data-role="omp.composer.line"], [data-role="omp.composer.chips"]) {
    opacity: 1;
    pointer-events: auto;
    margin: 0 !important;
    transition: none;
  }
  .sf.sf-col[data-role="omp.editor"] > [data-role="omp.composer.line"] {
    min-height: 48px;
    padding: 11px 14px;
    border: 1px solid var(--l2);
    border-radius: 14px;
    background: var(--card);
    box-shadow: 0 2px 10px rgb(0 0 0 / 4%);
  }
  .sf.sf-col[data-role="omp.editor"] .sf-editor {
    font-family: var(--ct-prose);
    font-size: 16px;
    line-height: 26px;
    letter-spacing: 0;
  }
  .sf.sf-col[data-role="omp.editor"] > [data-role="omp.composer.bar"] {
    padding: 2px 2px 0;
    margin: 0;
    height: auto;
    min-height: 32px;
    gap: 4px 8px;
    transition: none;
  }
  /* Tern's collapsed title/draft and path occupy the custom model controls. */
  [data-role="omp.composer.bar"] > :is(.sf-place, .sf-caption) { display: none; }
  .sf.sf-row[data-role="ct.composer.settings"] {
    min-width: 0;
    flex: 1 1 180px;
  }
  .sf.sf-row[data-role="ct.composer.actions"] {
    flex: 0 0 auto;
    margin-left: auto;
    gap: 4px;
  }
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.model"],
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.effort"],
  .sf.sf-col[data-role="omp.editor"] [data-role="ct.composer.mode"] {
    min-height: 28px;
    padding: 4px 6px;
    border-radius: 7px;
    border: 0;
    box-shadow: none;
    background: transparent;
    font-family: var(--ct-prose);
    font-size: 12px;
    line-height: 20px;
    color: var(--t2);
    cursor: pointer;
  }
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.model"] { min-width: 0; max-width: 240px; }
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.model"] > .sf-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.effort"] { flex-shrink: 0; }
  .sf.sf-col[data-role="omp.editor"] [data-role="ct.composer.mode"] {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .sf.sf-col[data-role="omp.editor"] [data-role="ct.composer.mode"] .ico { width: 12px; height: 12px; }
  .sf.sf-row[data-role="ct.composer.actions"] > .sf-icon {
    width: 28px;
    height: 28px;
    padding: 7px;
    border-radius: 7px;
    color: var(--t3);
    cursor: pointer;
  }
  .sf.sf-row[data-role="ct.composer.actions"] > .sf-icon .ico { width: 14px; height: 14px; }
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.model"]:hover,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.effort"]:hover,
  .sf.sf-col[data-role="omp.editor"] [data-role="ct.composer.mode"]:hover,
  .sf.sf-row[data-role="ct.composer.actions"] > .sf-icon:hover {
    background: var(--l2);
    color: var(--t1);
  }
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.send"],
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.stop"] {
    width: 30px;
    height: 30px;
    min-width: 30px;
    min-height: 30px;
    margin: 0;
    flex-shrink: 0;
  }
  /* Center the native mark in clients that were already running before reload. */
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.stop"]::before {
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
  }
  .sf.sf-row[data-role="ct.nav"] {
    width: 100%;
    max-width: 768px;
    margin-left: auto;
    margin-right: auto;
    min-height: 22px;
    padding: 0 8px;
    gap: 8px;
    font-family: var(--ct-prose);
    font-size: 11px;
    line-height: 18px;
    color: var(--t3);
  }
  .sf.sf-row[data-role="ct.nav"] .sf-status {
    height: auto;
    min-height: 0;
    margin: 0;
    padding: 0;
    gap: 10px;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
  }
  .sf.sf-row[data-role="ct.nav"] .sf-seg-t {
    font-family: inherit;
    font-size: inherit;
    letter-spacing: 0;
  }
  .sf.sf-row[data-role="ct.nav"] .sf-icon,
  .sf.sf-row[data-role="ct.nav"] .ico { width: 12px; height: 12px; }
  .sf.sf-row[data-role="ct.working"] { flex-shrink: 0; font-size: 11px; }
  .sf.sf-el.ct-activity {
    font-family: var(--ct-prose);
    font-size: 12px;
    line-height: 20px;
  }
  .sf.sf-el.ct-activity .ct-activity-toggle {
    gap: 8px;
    min-height: 32px;
    padding: 6px 0;
    border-radius: 6px;
    font: inherit;
  }
  .sf.sf-el.ct-activity [data-role="ct.activity.chevron"] { width: 12px; height: 12px; flex-shrink: 0; }
  .sf.sf-el.ct-activity .ct-activity-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 20px;
    flex-shrink: 0;
  }
  .sf.sf-el.ct-activity .ct-activity-indicator .sf-icon,
  .sf.sf-el.ct-activity .ct-activity-indicator .ico { width: 13px; height: 13px; }
  .sf.sf-el.ct-activity .ct-activity-label {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 8px;
    min-width: 0;
  }
  .sf.sf-el.ct-activity [data-role="ct.activity.state"] { color: var(--t2); font-weight: 500; }
  .sf.sf-el.ct-activity [data-role="ct.activity.meta"] { color: var(--t3); }
  .sf.sf-el.ct-activity .ct-activity-preview {
    margin: 0 0 4px 27px;
    padding: 2px 0 2px 14px;
    color: var(--t3);
  }
  .sf.sf-el.ct-activity .ct-activity-title { font-size: 12px; line-height: 20px; color: var(--t2); }
  .sf.sf-el.ct-activity .ct-activity-command { font-family: var(--mono); color: var(--t3); }
  .sf.sf-el.ct-activity .ct-activity-output { font-size: 11px; line-height: 18px; max-height: 54px; margin: 2px 0 0; }
  .sf.sf-el.ct-activity [data-role="ct.activity.details"] { padding: 6px 0 4px 20px; }
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.chips"] { padding: 4px 2px; }
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.chip"] { border-radius: 10px; }
  .sf.sf-col[data-role="omp.editor"] > [data-role="omp.composer.line"]:focus-within {
    box-shadow: 0 0 0 1px var(--l2), 0 2px 10px rgb(0 0 0 / 4%);
  }
  .sf.sf-col[data-role="omp.editor"] :is(.ct-send, .ct-stop) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--t1);
    color: var(--card);
    cursor: pointer;
  }
  .sf.sf-col[data-role="omp.editor"] :is(.ct-send, .ct-stop)::before,
  .sf.sf-col[data-role="omp.editor"] :is(.ct-send, .ct-stop)::after { display: none; }
  .sf.sf-col[data-role="omp.editor"] .ct-stop-mark {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: currentColor;
  }
  .sf.sf-col[data-role="omp.editor"] .ct-send .sf-icon,
  .sf.sf-col[data-role="omp.editor"] .ct-send .ico { width: 16px; height: 16px; color: inherit; }
  .sf.sf-col[data-role="omp.editor"] .ct-send[aria-disabled="true"] {
    background: var(--l2);
    color: var(--t3);
    opacity: 0.6;
    cursor: default;
  }
  .sf.sf-col[data-role="omp.editor"] .ct-send:not([aria-disabled="true"]):hover { background: var(--t2); }
  .sf.sf-col[data-role="omp.editor"] .ct-stop:hover { background: var(--t2); }
  .sf.sf-col[data-role="omp.editor"] .ct-stop:active { background: var(--t1); box-shadow: inset 0 0 0 2px var(--t3); }
  .sf.sf-col[data-role="omp.editor"] .ct-send:not([aria-disabled="true"]):active { background: var(--t1); box-shadow: inset 0 0 0 2px var(--t3); }
  .sf.sf-row[data-role="ct.composer.actions"] > .sf-icon:active,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.model"]:active,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.effort"]:active,
  .sf.sf-col[data-role="omp.editor"] [data-role="ct.composer.mode"]:active,
  .sf.sf-el.ct-activity .ct-activity-toggle:active { background: var(--l2); }
  .sf.sf-el.ct-button {
    min-height: 32px;
    padding: 6px 12px;
    border: 1px solid var(--l2);
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: 12px/18px var(--ct-prose);
    cursor: pointer;
  }
  .sf.sf-el.ct-button:not([aria-disabled="true"]):hover { background: var(--l2); color: var(--t1); }
  .sf.sf-el.ct-button:not([aria-disabled="true"]):active { background: var(--raise); }
  .sf.sf-el.ct-button.ct-primary { background: var(--t1); border-color: transparent; color: var(--card); font-weight: 500; }
  .sf.sf-el.ct-button.ct-primary:not([aria-disabled="true"]):hover { background: var(--t2); color: var(--card); }
  .sf.sf-el.ct-button.ct-primary:not([aria-disabled="true"]):active { background: var(--t1); }
  .sf.sf-el.ct-button.ct-danger { color: var(--bad); }
  .sf.sf-el.ct-button.ct-danger:hover { color: var(--bad); }
  .sf.sf-el.ct-button[aria-disabled="true"] { background: var(--l2); color: var(--t3); opacity: 0.6; cursor: default; }
  .sf.sf-el.ct-button.ct-quiet { align-self: flex-start; border-color: transparent; padding-left: 0; padding-right: 0; }
  .sf.sf-el.ct-request {
    padding: 16px;
    border: 1px solid var(--l2);
    border-radius: 14px;
    box-shadow: none;
    background: var(--card);
    font: 13px/20px var(--ct-prose);
    color: var(--t2);
    max-height: 52vh;
    overflow-y: auto;
  }
  .sf.sf-el.ct-request [data-role="ct.request.heading"] { font-size: 14px; line-height: 22px; font-weight: 600; color: var(--t1); }
  .sf.sf-el.ct-request [data-role="ct.request.heading"] .sf-icon,
  .sf.sf-el.ct-request [data-role="ct.request.heading"] .ico { width: 16px; height: 16px; color: var(--t3); }
  .sf.sf-el.ct-request [data-role="ct.request.question"] + [data-role="ct.request.question"] { padding-top: 12px; border-top: 1px solid var(--l2); }
  .sf.sf-el.ct-request [data-role="ct.request.eyebrow"] { font-size: 11px; line-height: 16px; color: var(--t3); }
  .sf.sf-el.ct-request [data-role="ct.request.prompt"] { font-size: 14px; line-height: 22px; color: var(--t1); }
  .sf.sf-el.ct-request [data-role="ct.request.context"] { font-size: 12px; overflow-wrap: anywhere; }
  .sf.sf-el.ct-request .sf-code,
  .sf.sf-el.ct-request pre,
  .sf.sf-el.ct-request code { font-family: var(--mono); font-size: 12px; line-height: 20px; }
  .sf.sf-el.ct-request [data-role="ct.request.answer"] { padding: 8px 10px; background: var(--raise); border-radius: 8px; }
  .sf.sf-el.ct-request .ct-request-actions {
    justify-content: flex-end;
    gap: 6px;
    padding-top: 12px;
    border-top: 1px solid var(--l2);
  }
  .sf.sf-el.ct-choice {
    display: flex;
    align-items: flex-start;
    width: 100%;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--l2);
    border-radius: 10px;
    background: transparent;
    font: inherit;
    color: var(--t2);
    text-align: left;
    cursor: pointer;
  }
  .sf.sf-el.ct-choice:hover { background: var(--raise); }
  .sf.sf-el.ct-choice:active { background: var(--l2); }
  .sf.sf-el.ct-choice.ct-selected { background: var(--raise); border-color: var(--accent); box-shadow: none; }
  .sf.sf-el.ct-choice .ct-choice-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    border: 1px solid var(--l2);
    border-radius: 50%;
    flex-shrink: 0;
  }
  .sf.sf-el.ct-choice.ct-selected .ct-choice-mark { background: var(--accent); border-color: var(--accent); color: var(--card); }
  .sf.sf-el.ct-choice .ct-choice-mark .sf-icon,
  .sf.sf-el.ct-choice .ct-choice-mark .ico { width: 10px; height: 10px; color: inherit; }
  .sf.sf-el.ct-choice [data-role="ct.choice.copy"] { min-width: 0; gap: 2px; }
  .sf.sf-el.ct-choice [data-role="ct.choice.label"] { color: var(--t1); font-weight: 500; }
  .sf.sf-el.ct-choice [data-role="ct.choice.description"] { font-size: 12px; line-height: 18px; }
  .sf.sf-col[data-role="omp.welcome"] {
    align-items: center;
    padding: 48px 16px 32px;
    gap: 12px;
    font-family: var(--ct-prose);
  }
  .sf.sf-col[data-role="omp.welcome"] [data-role="ct.welcome.lockup"] { gap: 10px; }
  .sf.sf-col[data-role="omp.welcome"] [data-role="ct.logo"],
  .sf.sf-col[data-role="omp.welcome"] [data-role="ct.logo"] .ico { width: 28px; height: 28px; }
  .sf.sf-col[data-role="omp.welcome"] [data-role="ct.welcome.wordmark"] { font: 600 24px/30px var(--ct-prose); letter-spacing: -0.5px; }
  .sf.sf-col[data-role="omp.welcome"] [data-role="ct.welcome.prompt"] { font-size: 14px; line-height: 22px; color: var(--t3); text-align: center; }
  .sf.sf-row[data-role="ct.composer.actions"] > .sf-icon:focus-visible,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.model"]:focus-visible,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.effort"]:focus-visible,
  .sf.sf-col[data-role="omp.editor"] [data-role="ct.composer.mode"]:focus-visible,
  .sf.sf-col[data-role="omp.editor"] .ct-send:focus-visible,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.stop"]:focus-visible,
  .sf.sf-el.ct-button:focus-visible,
  .sf.sf-el.ct-choice:focus-visible,
  .sf.sf-el.ct-activity .ct-activity-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .sf.sf-row[data-role="ct.completion"],
  .sf.sf-row[data-role="ct.reconnect"] {
    width: 100%;
    max-width: 736px;
    align-self: center;
    padding: 9px 12px;
    margin-bottom: 8px;
    border: 1px solid var(--l2);
    border-radius: 12px;
    background: var(--card);
    color: var(--t2);
    font: 13px/20px var(--ct-prose);
  }
  [data-role="ct.completion.icon"] { color: var(--accent); }
  [data-role="ct.completion"] > .sf-icon,
  [data-role="ct.reconnect"] > .sf-icon { width: 14px; height: 14px; flex-shrink: 0; }
  .sf.sf-el.ct-completion-action {
    padding: 2px 6px;
    border-radius: 5px;
    background: transparent;
    color: var(--accent-ink);
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .sf.sf-el.ct-completion-action:hover { background: var(--raise); }
  .sf.sf-el.ct-completion-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;
