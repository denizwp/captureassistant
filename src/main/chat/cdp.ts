import WebSocket from 'ws'

/*
 * A very small Chrome DevTools Protocol client, enough to evaluate an
 * expression in a page.
 *
 * FiveM draws its interface in an embedded Chromium and leaves that Chromium's
 * debugging endpoint listening on localhost. Everything here goes through that
 * endpoint: we ask it which pages exist, attach to the one holding the game's
 * interface, and read the chat that is already on screen. Nothing is injected
 * into the game, no memory is read, and no input is sent — this is the same
 * door the browser's own developer tools use.
 */

/*
 * Where the game leaves its debugging endpoint. Overridable so the self-test
 * can stand up its own on a free port instead of fighting a running game for
 * this one — which also means the test can be run while playing.
 */
function endpoint(): string {
  return `http://127.0.0.1:${Number(process.env['CA_CHAT_PORT'] || 13172)}`
}

const CALL_TIMEOUT_MS = 4000

interface Target {
  type?: string
  url?: string
  title?: string
  webSocketDebuggerUrl?: string
}

export interface Context {
  id: number
  /* Which resource the frame belongs to, e.g. https://cfx-nui-chat */
  origin: string
  name: string
}

export class DevToolsPage {
  private socket: WebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  /*
   * The interface is one document with every resource running inside its own
   * frame, and each frame is its own JavaScript world. An expression evaluated
   * without naming one of these only ever sees the outer document, which holds
   * no chat — the chat lives in the frame its resource created. These are the
   * worlds available to run in.
   */
  private readonly worlds: Context[] = []

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  get contexts(): Context[] {
    return this.worlds
  }

  /*
   * The interface is split across several frames — the root document and one
   * per running resource. Chat is drawn by a resource, so every candidate is
   * worth attaching to; which one actually answers is decided by whoever asks
   * for something and gets an answer.
   */
  static async listPages(): Promise<Target[]> {
    const response = await fetch(`${endpoint()}/json`, {
      signal: AbortSignal.timeout(2000)
    })
    if (!response.ok) throw new Error(`devtools ${response.status}`)
    const targets = (await response.json()) as Target[]
    return targets.filter((target) => !!target.webSocketDebuggerUrl)
  }

  async attach(target: Target): Promise<void> {
    const url = target.webSocketDebuggerUrl
    if (!url) throw new Error('page has no debugger url')

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false })
      const settle = (error?: Error): void => {
        socket.off('open', onOpen)
        socket.off('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onOpen = (): void => {
        this.socket = socket
        settle()
      }
      const onError = (error: Error): void => settle(error)
      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.on('message', (data: Buffer) => this.receive(data.toString()))
      socket.on('close', () => this.fail(new Error('devtools connection closed')))
    })
  }

  private receive(text: string): void {
    let message: {
      id?: number
      method?: string
      params?: { context?: { id?: number; origin?: string; name?: string } }
      result?: unknown
      error?: { message?: string }
    }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      return
    }

    // Announced as frames come up, which is how the list of worlds is built.
    if (message.method === 'Runtime.executionContextCreated') {
      const context = message.params?.context
      if (typeof context?.id === 'number' && !this.worlds.some((w) => w.id === context.id)) {
        this.worlds.push({
          id: context.id,
          origin: context.origin ?? '',
          name: context.name ?? ''
        })
      }
      return
    }

    if (typeof message.id !== 'number') return
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(message.error.message ?? 'devtools error'))
    else waiter.resolve(message.result)
  }

  private fail(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    this.socket = null
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not attached'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /*
   * Turns on the notifications that announce each frame's world, then waits
   * briefly for the ones that already exist to be replayed. Without this the
   * list is empty and everything runs in the outer document.
   */
  async findWorlds(): Promise<Context[]> {
    await this.call('Runtime.enable', {})
    await new Promise((resolve) => setTimeout(resolve, 400))
    return this.worlds
  }

  /*
   * Runs an expression in one of the page's worlds and hands back whatever it
   * returned, already parsed. The expression stringifies its own result, so
   * anything structured survives the trip without the protocol trying to
   * describe it as an object graph.
   */
  async evaluate<T>(expression: string, contextId?: number): Promise<T | null> {
    const result = (await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
      timeout: CALL_TIMEOUT_MS,
      ...(contextId === undefined ? {} : { contextId })
    })) as {
      result?: { value?: unknown }
      exceptionDetails?: { text?: string }
    }

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'expression threw')
    }
    const value = result.result?.value
    if (typeof value !== 'string' || value.length === 0) return null
    return JSON.parse(value) as T
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    this.fail(new Error('closed'))
    try {
      socket?.close()
    } catch {
      // Already gone; there is nothing to report to anyone.
    }
  }
}
