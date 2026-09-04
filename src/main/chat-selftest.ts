import { app } from 'electron'
import { createServer, type Server } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { ChatCapture } from './chat'
import { colorFileFor, listArchive, newLinesOnly, readArchive } from './chat/archive'
import { classify, resolveMoment, splitTimestamp } from './chat/classify'
import { exportHtml, exportText } from './chat/export'

/*
 * The chat side cannot be exercised against a real game from here, so this
 * stands one up: a debugging endpoint on the port FiveM uses, answering the
 * same protocol with chat we control. Everything above it — attaching, reading,
 * splitting colours, deciding what is new, filing it by day, exporting — is the
 * real code, running the way it will run in front of a server.
 */

/*
 * Not the port the game uses. Binding that one would fail whenever FiveM is
 * already running, which is exactly when someone is most likely to run this.
 */
const PORT = 13999

interface Fake {
  close: () => Promise<void>
  setRows: (rows: { t: string; r: { s: number; n: number; c: string }[] }[]) => void
  setServer: (server: { address: string; name: string }) => void
}

function startFakeGame(): Promise<Fake> {
  let rows: { t: string; r: { s: number; n: number; c: string }[] }[] = []
  let server = { address: '127.0.0.1:30120', name: 'Test Sunucusu' }

  return new Promise((resolve, reject) => {
    const http: Server = createServer((req, res) => {
      if (req.url?.startsWith('/json')) {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify([
            {
              type: 'page',
              url: 'nui://game/ui/root.html',
              webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/1`
            }
          ])
        )
        return
      }
      res.statusCode = 404
      res.end()
    })

    const wss = new WebSocketServer({ server: http })
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as {
          id: number
          method?: string
          params?: { expression?: string; contextId?: number }
        }

        /*
         * Frames announce themselves after Runtime.enable, which is how the
         * reader learns there is somewhere other than the outer document to
         * look. Chat only answers in world 7, so a reader that ignores worlds
         * gets nothing here — exactly as it would in the game.
         */
        if (message.method === 'Runtime.enable') {
          socket.send(JSON.stringify({ id: message.id, result: {} }))
          for (const world of [
            { id: 7, origin: 'https://cfx-nui-chat', name: 'chat' },
            { id: 9, origin: 'https://cfx-nui-hud', name: 'hud' }
          ]) {
            socket.send(
              JSON.stringify({
                method: 'Runtime.executionContextCreated',
                params: { context: world }
              })
            )
          }
          return
        }

        const expression = message.params?.expression ?? ''
        const world = message.params?.contextId
        let value: string | null = null

        if (expression.includes('nuiHandoverData')) {
          value = JSON.stringify(server)
        } else if (expression.includes('pathTo')) {
          value =
            world === 7
              ? JSON.stringify({ path: '#chat > div', rows: rows.length, sample: rows[0]?.t ?? '' })
              : 'null'
        } else if (expression.includes('querySelector')) {
          value = world === 7 ? JSON.stringify(rows) : 'null'
        }

        socket.send(
          JSON.stringify({ id: message.id, result: { result: { value: value ?? 'null' } } })
        )
      })
    })

    http.on('error', reject)
    // Bound before anything reads it, and the client is pointed here for the
    // rest of the process.
    process.env['CA_CHAT_PORT'] = String(PORT)
    http.listen(PORT, '127.0.0.1', () => {
      resolve({
        close: () =>
          new Promise<void>((done) => {
            // The reader is still attached, and a server with a live socket on
            // it never finishes closing. Drop the sockets first.
            for (const client of wss.clients) client.terminate()
            wss.close()
            http.closeAllConnections()
            http.close(() => done())
          }),
        setRows: (next) => {
          rows = next
        },
        setServer: (next) => {
          server = next
        }
      })
    })
  })
}

const plain = (text: string): { t: string; r: { s: number; n: number; c: string }[] } => ({
  t: text,
  r: []
})

export async function runChatSelfTest(): Promise<void> {
  const logPath = join(app.getPath('temp'), 'ca-chat-selftest.log')
  writeFileSync(logPath, '')
  const log = (message: string): void => appendFileSync(logPath, `${message}\n`)
  log(`log: ${logPath}`)

  let failures = 0
  const check = (name: string, ok: boolean, detail = ''): void => {
    if (ok) log(`  OK: ${name}${detail ? ` — ${detail}` : ''}`)
    else {
      failures++
      log(`  FAILED: ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }

  // --- the parts that need no game at all -------------------------------
  log('satır ayrıştırma')
  const stamped = splitTimestamp('[21:04:37] * Deniz siperin arkasına geçer.')
  check('saat ayrılıyor', stamped.stamp?.hour === 21 && stamped.stamp.minute === 4)
  check('gövde kalıyor', stamped.body.startsWith('* Deniz'))
  check('rol satırı', classify('* Deniz siperin arkasına geçer.') === 'ic')
  check('ooc satırı', classify('(( Deniz: bir dakika ))') === 'ooc')
  check('slash b ooc', classify('/b geliyorum') === 'ooc')
  check('özel mesaj', classify('(( PM to Deniz: selam ))') === 'pm')
  check('sunucu satırı', classify('[INFO] Sunucuya hoş geldin.') === 'info')

  const midnight = new Date(2026, 8, 4, 0, 5, 0).getTime()
  const before = resolveMoment(midnight, { hour: 23, minute: 58, second: 0 })
  check('gece yarısı öncesi dünden sayılıyor', before < midnight, new Date(before).toLocaleString('tr-TR'))

  log('kayan pencere birleştirme')
  check('örtüşen kısım atlanıyor',
    JSON.stringify(newLinesOnly(['a', 'b', 'c'], ['b', 'c', 'd'])) === JSON.stringify(['d']))
  check('hiç kaymadıysa yeni yok',
    newLinesOnly(['a', 'b', 'c'], ['a', 'b', 'c']).length === 0)
  check('tamamen değiştiyse hepsi yeni',
    newLinesOnly(['a', 'b'], ['x', 'y']).length === 2)
  check('tekrar eden satır kaybolmuyor',
    JSON.stringify(newLinesOnly(['selam', 'selam'], ['selam', 'selam', 'selam'])) ===
      JSON.stringify(['selam']))

  // --- the whole pipeline against a stand-in game -----------------------
  const root = join(tmpdir(), `ca-chat-test-${Date.now()}`)
  const fake = await startFakeGame().catch((error: unknown) => {
    log(`FAILED: sahte oyun ucu açılamadı — ${String(error)}`)
    return null
  })
  if (!fake) return

  const chat = new ChatCapture(root)
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  try {
    log('canlı yakalama')
    fake.setRows([
      plain('[21:04:37] * Deniz siperin arkasına geçer.'),
      { t: '[21:04:41] Deniz Kaya: nerdesin', r: [{ s: 11, n: 10, c: '#7fc8a9' }] },
      plain('[21:04:44] (( Ali: 2 dk ))')
    ])
    chat.start()
    await wait(1400)

    let status = chat.getStatus()
    check('bağlandı', status.state === 'connected', status.error ?? '')
    check('sunucu adı okundu', status.serverName === 'Test Sunucusu', String(status.serverName))
    check('üç satır alındı', chat.getLines().length === 3, `${chat.getLines().length}`)

    const kinds = chat.getLines().map((line) => line.kind).join(',')
    check('türler doğru', kinds === 'ic,ic,ooc', kinds)

    log('aynı pencere tekrar okunuyor')
    await wait(1200)
    check('tekrar yazılmadı', chat.getLines().length === 3, `${chat.getLines().length}`)

    log('sohbet ilerliyor')
    fake.setRows([
      plain('[21:04:41] Deniz Kaya: nerdesin'),
      plain('[21:04:44] (( Ali: 2 dk ))'),
      plain('[21:05:02] * Ali kapıyı açar.'),
      plain('[21:05:09] [INFO] Kaydedildi.')
    ])
    await wait(1400)
    check('yalnızca yeni iki satır eklendi', chat.getLines().length === 5, `${chat.getLines().length}`)

    const file = chat.getStatus().archiveFile
    check('arşiv dosyası açıldı', !!file, file ?? '')

    if (file) {
      const text = await readFile(file, 'utf8')
      const lines = text.split('\n').filter(Boolean)
      // Five captured lines plus the "connected" marker written on attach.
      check('dosyada 6 satır var', lines.length === 6, `${lines.length}`)
      check('bağlanma işareti düşülmüş', lines[0]?.includes('Bağlanıldı') ?? false, lines[0] ?? '')
      check('satır düz metin olarak duruyor',
        lines[1] === '[21:04:37] * Deniz siperin arkasına geçer.', lines[1] ?? '')

      const colors = await readFile(colorFileFor(file), 'utf8').catch(() => '')
      const colorLines = colors.split('\n').filter(Boolean)
      check('renk dosyası satır sayısıyla eşleşiyor', colorLines.length === lines.length,
        `${colorLines.length}/${lines.length}`)
      check('renk korunmuş', colorLines[2]?.includes('#7fc8a9') ?? false, colorLines[2] ?? '')

      const reopened = await readArchive(file)
      check('arşiv geri okunuyor', reopened.length === 6, `${reopened.length}`)
      check('geri okunan renk yerinde',
        reopened[2]?.runs[0]?.color === '#7fc8a9', JSON.stringify(reopened[2]?.runs ?? []))

      const found = await listArchive(root)
      check('arşiv listeleniyor', found.length === 1, `${found.length}`)
      check('sunucu adı dosyadan çözülüyor', found[0]?.server === 'Test Sunucusu',
        found[0]?.server ?? '')

      log('dışa aktarma')
      const asText = join(root, 'disa.txt')
      const asHtml = join(root, 'disa.html')
      const exportable = reopened.map((line) => ({
        text: line.text,
        runs: line.runs,
        kind: classify(splitTimestamp(line.text).body)
      }))
      await exportText(asText, exportable)
      await exportHtml(asHtml, 'Test', exportable)
      const txt = await readFile(asText, 'utf8')
      const html = await readFile(asHtml, 'utf8')
      check('txt satırları içeriyor', txt.includes('* Ali kapıyı açar.'))
      check('html tek parça', html.includes('<style>') && !html.includes('<link'))
      check('html rengi gömüyor', html.includes('#7fc8a9'))
    }

    log('oyun kapanıyor')
    await fake.close()
    await wait(1600)
    check('kopma fark edildi', chat.getStatus().state !== 'connected', chat.getStatus().state)
  } finally {
    await chat.stop()
    await fake.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }

  log(failures === 0 ? '\nHEPSİ GEÇTİ' : `\n${failures} KONTROL BAŞARISIZ`)
}
