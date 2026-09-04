import { writeFile } from 'node:fs/promises'
import type { ChatColorRun, ChatKind } from '@shared/chat'
import { spansFor } from '@shared/chat'

export interface ExportLine {
  text: string
  runs: ChatColorRun[]
  kind: ChatKind
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export async function exportText(path: string, lines: ExportLine[]): Promise<void> {
  await writeFile(path, lines.map((line) => line.text).join('\r\n') + '\r\n', 'utf8')
}

/*
 * One file, nothing linked from outside it: the colours, the type and the text
 * all live inside, so it opens the same on a machine that has never seen this
 * app.
 */
export async function exportHtml(
  path: string,
  title: string,
  lines: ExportLine[]
): Promise<void> {
  const body = lines
    .map((line) => {
      const spans = spansFor(line.text, line.runs, line.kind)
        .map((span) => `<span style="color:${span.color}">${escape(span.text)}</span>`)
        .join('')
      return `<div class="l">${spans || '&nbsp;'}</div>`
    })
    .join('\n')

  const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 24px; background: #14161a; color: #e6e9ef;
    font: 14px/1.55 "Consolas", "Cascadia Mono", ui-monospace, monospace;
  }
  h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  p.sub { margin: 0 0 20px; color: #7d8694; font-size: 12px; }
  .l { white-space: pre-wrap; word-break: break-word; }
  .l:hover { background: rgba(255, 255, 255, .04); }
</style>
</head>
<body>
<h1>${escape(title)}</h1>
<p class="sub">${lines.length} satır · Capture Assistant</p>
${body}
</body>
</html>
`
  await writeFile(path, html, 'utf8')
}
