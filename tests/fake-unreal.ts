/**
 * A stand-in Unreal Editor speaking the editor side of Unreal's Python remote execution protocol: it answers pings on
 * the multicast group, connects back when asked to open a command channel, and answers each command with a scripted
 * result. Lets the bridge be tested over real UDP and TCP without Unreal.
 */
import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import net from 'node:net'

export interface FakeEditorOptions {
  projectName: string
  projectRoot: string
  engineVersion?: string
  /** What a command prints, and whether it succeeds; defaults to echoing the code. */
  respond?: (code: string, mode: string) => { success: boolean; output: string[]; result?: string }
}

export class FakeUnrealEditor {
  readonly nodeId = randomUUID()
  readonly commands: { code: string; mode: string }[] = []
  private udp?: dgram.Socket
  private tcp?: net.Socket
  private readonly options: FakeEditorOptions
  constructor(options: FakeEditorOptions) {
    this.options = options
  }

  start(): Promise<void> {
    return new Promise(resolve => {
      const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      this.udp = udp
      udp.on('message', buffer => this.onMessage(JSON.parse(buffer.toString('utf8'))))
      udp.bind({ address: '0.0.0.0', port: 6766 }, () => {
        udp.setMulticastLoopback(true)
        udp.setMulticastTTL(0)
        udp.setMulticastInterface('0.0.0.0')
        udp.addMembership('239.0.0.1', '0.0.0.0')
        resolve()
      })
    })
  }

  stop(): void {
    this.tcp?.destroy()
    this.udp?.close()
  }

  private send(type: string, dest: string, data?: unknown) {
    this.udp?.send(JSON.stringify({ version: 1, magic: 'ue_py', type, source: this.nodeId, dest, data }), 6766, '239.0.0.1')
  }

  private onMessage(message: { magic: string; type: string; source: string; dest?: string; data?: { command_ip: string; command_port: number } }) {
    if (message.magic !== 'ue_py' || message.source === this.nodeId || (message.dest && message.dest !== this.nodeId)) return
    if (message.type === 'ping') {
      this.send('pong', message.source, { engine_root: '/UE', engine_version: this.options.engineVersion ?? '5.4.4', machine: 'test', project_name: this.options.projectName, project_root: this.options.projectRoot, user: 'dev' })
    } else if (message.type === 'open_connection' && message.data) {
      const client = message.source
      this.tcp = net.connect(message.data.command_port, message.data.command_ip)
      let buffer = ''
      this.tcp.on('data', chunk => {
        buffer += chunk.toString('utf8')
        let command: { data: { command: string; exec_mode: string } }
        try {
          command = JSON.parse(buffer)
        } catch {
          return
        }
        buffer = ''
        const { command: code, exec_mode: mode } = command.data
        this.commands.push({ code, mode })
        const answer = this.options.respond?.(code, mode) ?? { success: true, output: [`ran: ${code.split('\n')[0]}`] }
        this.tcp!.write(JSON.stringify({ version: 1, magic: 'ue_py', type: 'command_result', source: this.nodeId, dest: client,
          data: { command: code, success: answer.success, result: answer.result ?? 'None', output: answer.output.map(output => ({ type: 'Info', output: `${output}\n` })) } }))
      })
      this.tcp.on('error', () => undefined)
    } else if (message.type === 'close_connection') {
      this.tcp?.destroy()
      this.tcp = undefined
    }
  }
}
