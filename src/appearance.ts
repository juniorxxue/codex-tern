import { css } from '@stencil-hq/tern';

// Tern confines program sheets to region descendants. The window plugin
// wraps this same sheet in a surface selector for clients already running.
// Match the reference's density, with 24 px lines for mixed Chinese/English text.
export const appearanceStyles = css`
  .sf.sf-col[data-role="omp.assistant"] {
    --ct-prose: "SF Pro Text", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  .sf.sf-card[data-role="omp.user"],
  .sf.sf-col[data-role="omp.assistant"],
  .sf.sf-card[data-role="omp.welcome"],
  .sf.sf-col[data-role="omp.welcome"],
  .sf.sf-row[data-role="ct.pending"],
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
  .sf.sf-col[data-role="omp.assistant"] > .sf-md { gap: 12px; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md {
    font-family: var(--ct-prose);
    font-size: 16px;
    line-height: 24px;
    letter-spacing: 0;
    color: var(--t1);
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md p { margin: 0; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h1,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h2,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h3,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h4 {
    font-family: var(--ct-prose) !important;
    font-weight: 700;
    line-height: 24px;
    margin: 8px 0 0;
    letter-spacing: 0;
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h1 { font-size: 22px !important; line-height: 28px; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h2 { font-size: 20px !important; line-height: 26px; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h3,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md h4 { font-size: 18px !important; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md > .md:first-child > :first-child { margin-top: 0; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md ul,
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md ol {
    margin: 0;
    padding-left: 28px;
  }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md li { margin: 0; }
  .sf.sf-col[data-role="omp.assistant"] .sf-md .md li + li { margin-top: 4px; }
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
    font-family: "SF Pro Text", "PingFang SC", system-ui, sans-serif;
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
    font-family: "SF Pro Text", "PingFang SC", system-ui, sans-serif;
    font-size: 14px;
    line-height: 21px;
  }
  .sf.sf-col[data-role="omp.editor"],
  .sf.sf-section[data-role="omp.queue"],
  .sf.sf-el.ct-request {
    width: 100%;
    max-width: 768px;
    margin-left: auto;
    margin-right: auto;
  }
  .sf.sf-col[data-role="omp.editor"] {
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    outline: none;
    backdrop-filter: none;
    filter: none;
    box-shadow: none;
    gap: 4px;
  }
  .sf.sf-col[data-role="omp.editor"]::before,
  .sf.sf-col[data-role="omp.editor"]::after { display: none; }
  .sf.sf-col[data-role="omp.editor"] > [data-role="omp.composer.line"] {
    min-height: 48px;
    padding: 11px 14px;
    border: 1px solid var(--l2);
    border-radius: 14px;
    background: var(--card);
    box-shadow: 0 2px 10px rgb(0 0 0 / 4%);
  }
  .sf.sf-col[data-role="omp.editor"] .sf-editor {
    font-family: "SF Pro Text", "PingFang SC", system-ui, sans-serif;
    font-size: 14px;
    line-height: 22px;
  }
  .sf.sf-col[data-role="omp.editor"] > [data-role="omp.composer.bar"] {
    padding: 2px 2px 0;
    min-height: 32px;
    gap: 4px 8px;
  }
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
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.effort"] {
    min-height: 28px;
    padding: 4px 6px;
    border-radius: 7px;
    border: 0;
    box-shadow: none;
    background: transparent;
    font-family: "SF Pro Text", "PingFang SC", system-ui, sans-serif;
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
  .sf.sf-row[data-role="ct.nav"] {
    width: 100%;
    max-width: 768px;
    margin-left: auto;
    margin-right: auto;
    min-height: 22px;
    padding: 0 8px;
    gap: 8px;
    font-family: "SF Pro Text", "PingFang SC", system-ui, sans-serif;
    font-size: 11px;
    line-height: 18px;
    color: var(--t3);
  }
  .sf.sf-row[data-role="ct.nav"] .sf-status {
    min-height: 0;
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
  .sf.sf-row[data-role="ct.pending"],
  .sf.sf-el.ct-activity {
    font-family: "SF Pro Text", "PingFang SC", system-ui, sans-serif;
    font-size: 12px;
    line-height: 20px;
  }
  .sf.sf-row[data-role="ct.pending"] { padding: 8px 2px; }
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
  .sf.sf-col[data-role="omp.editor"] .ct-send {
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
  .sf.sf-col[data-role="omp.editor"] .ct-send::before,
  .sf.sf-col[data-role="omp.editor"] .ct-send::after { display: none; }
  .sf.sf-col[data-role="omp.editor"] .ct-send .sf-icon,
  .sf.sf-col[data-role="omp.editor"] .ct-send .ico { width: 16px; height: 16px; color: inherit; }
  .sf.sf-col[data-role="omp.editor"] .ct-send[aria-disabled="true"] {
    background: var(--l2);
    color: var(--t3);
    opacity: 0.6;
    cursor: default;
  }
  .sf.sf-col[data-role="omp.editor"] .ct-send:not([aria-disabled="true"]):hover { background: var(--t2); }
  .sf.sf-col[data-role="omp.editor"] .ct-send:not([aria-disabled="true"]):active { background: var(--t1); box-shadow: inset 0 0 0 2px var(--t3); }
  .sf.sf-row[data-role="ct.composer.actions"] > .sf-icon:active,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.model"]:active,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.effort"]:active,
  .sf.sf-el.ct-activity .ct-activity-toggle:active { background: var(--l2); }
  .sf.sf-el.ct-button {
    min-height: 32px;
    padding: 6px 12px;
    border: 1px solid var(--l2);
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: 12px/18px "SF Pro Text", "PingFang SC", system-ui, sans-serif;
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
    font: 13px/20px "SF Pro Text", "PingFang SC", system-ui, sans-serif;
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
    font-family: "SF Pro Text", "PingFang SC", system-ui, sans-serif;
  }
  .sf.sf-col[data-role="omp.welcome"] [data-role="ct.welcome.lockup"] { gap: 10px; }
  .sf.sf-col[data-role="omp.welcome"] [data-role="ct.logo"],
  .sf.sf-col[data-role="omp.welcome"] [data-role="ct.logo"] .ico { width: 28px; height: 28px; }
  .sf.sf-col[data-role="omp.welcome"] [data-role="ct.welcome.wordmark"] { font: 600 24px/30px "SF Pro Text", system-ui, sans-serif; letter-spacing: -0.5px; }
  .sf.sf-col[data-role="omp.welcome"] [data-role="ct.welcome.prompt"] { font-size: 14px; line-height: 22px; color: var(--t3); text-align: center; }
  .sf.sf-row[data-role="ct.composer.actions"] > .sf-icon:focus-visible,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.model"]:focus-visible,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.effort"]:focus-visible,
  .sf.sf-col[data-role="omp.editor"] .ct-send:focus-visible,
  .sf.sf-col[data-role="omp.editor"] [data-role="omp.composer.stop"]:focus-visible,
  .sf.sf-el.ct-button:focus-visible,
  .sf.sf-el.ct-choice:focus-visible,
  .sf.sf-el.ct-activity .ct-activity-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;
