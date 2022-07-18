let fs = require('fs')
let ph = require('path')
let util = require('./util')
let ffmpeg = require('./ffmpeg')
let steam = require('./steam')
let svr = require('./svr')
let VDM = require('./vdm')

let KILLERS = ['exit', 'SIGINT', 'SIGUSR1', 'SIGUSR2', 'uncaughtException']
let DATA = ph.join(__dirname, 'data')

class DemRec extends require('events') {
  constructor (config) {
    super()
    if (!fs.existsSync(config)) throw new Error(`Config file "${config}" not found!`)

    this.cfg = util.readINI(config, ['FFMPEG'])

    if (!svr.init(this.cfg.General.svr_dir)) throw new Error('Could not find valid SVR directory!')

    this.initialized = false
  }

  static Events = {
    GAME_LAUNCH: 0,
    GAME_LAUNCH_END: 1,
    DEMO_LAUNCH: 2,
    DEMO_LAUNCH_END: 3,
    DEMO_SKIP: 4,
    DEMO_SKIP_END: 5,
    DEMO_RECORD: 6,
    DEMO_RECORD_END: 7,
    DEMO_DONE: 8,
    FFMPEG_PROCESS: 9,
    FFMPEG_PROCESS_END: 10,
    FFMPEG_DONE: 11,
    GAME_EXIT: 12,
    GAME_EXIT_END: 13
  }
}

Object.defineProperty(DemRec.Events, 'add', {
  value: function (events) {
    let len = Object.keys(this).length
    if (!Array.isArray(events)) events = [events]
    for (let event of events) this[event] = len++
  }
})

DemRec.prototype.init = async function () {
  if (!await steam.init()) throw new Error('Steam is not running!')

  this.setGame(this.cfg.General.game_app)
  this.setLaunchOptions(this.cfg.General.game_args)
  this.setProfile(this.cfg)

  this.kill()
  if (!fs.existsSync(svr.movies)) fs.mkdirSync(svr.movies)

  this.initialized = true
}

DemRec.prototype.setGame = function (app) {
  this.game = {
    id: app,
    ...steam.get(app),
    log: 'console.log',
    token: (this.cfg.General.game_token || 'demrec').toLowerCase()
  }
  if (['bin', 'hl2', 'platform', ph.basename(this.game.dir).toLowerCase()].includes(this.game.token)) {
    throw new Error('Invalid game token provided!')
  }
  this.game.tmp = ph.join(this.game.dir, '..', this.game.token)
}

DemRec.prototype.updateCustomFiles = function () {
  if (!fs.existsSync(this.game.tmp)) fs.mkdirSync(this.game.tmp)

  let TMP = ph.join(DATA, 'TMP')

  let paths = (this.cfg.General.game_custom || '').replaceAll('%TF%', this.game.dir).split(/[,;]/).map(x => {
    if (x) {
      let p = ph.resolve(x.trim())
      x = 'game+mod+custom_mod\t"' + p + (fs.existsSync(p) && fs.statSync(p).isDirectory() ? '/*"' : '"')
    }
    return x
  }).join('\n\t\t\t')

  util.modify(ph.join(DATA, this.game.id.toString()), {
    files: ['custom/cfg/start.cfg', 'gameinfo.txt'],
    vars: {
      '%LOG%': this.game.log,
      '%CFG%': (this.cfg.General.game_cfgs || '').split(/[,;]/).map(x => x ? `exec "${x.trim()}"` : '').join('\n'),
      '%CUSTOMS%': paths
    }
  }, TMP)

  util.copyFolder(TMP, this.game.tmp)
  util.remove(TMP)
}

DemRec.prototype.setLaunchOptions = function (opts) {
  let args = [`-game ${this.game.token}`]
  if (opts) args.push(opts)

  svr.writeLaunchOptions(this.game.id, args.join(' '))
}

DemRec.prototype.setProfile = function (cfg) {
  svr.writeProfile(this.game.token, {
    video: cfg.Video,
    motion_blur: cfg['Motion Blur'],
    velo: cfg['Velocity Overlay'],
    audio: { enabled: 1 }
  })
}

DemRec.prototype.launch = async function (silent = false) {
  if (!this.initialized) await this.init()
  this.updateCustomFiles()

  let overlay = ph.join(steam.path, 'GameOverlayUI.exe')
  let replace = overlay + 'DISABLED'

  let act = () => fs.existsSync(replace) && fs.renameSync(replace, overlay)

  if (!silent) this.emit('log', { event: DemRec.Events.GAME_LAUNCH })

  this.app = await svr.run(this.game, {
    hello: () => {
      fs.renameSync(overlay, replace)
      util.addListeners(process, KILLERS, act)
    },
    init: () => {
      act()
      util.removeListeners(process, KILLERS, act)
    }
  })

  if (!silent) this.emit('log', { event: DemRec.Events.GAME_LAUNCH_END })
}

DemRec.prototype.record = async function (demo, arr, out) {
  if (!this.initialized) await this.init()
  if (!this.app) throw new Error('Game not running!')

  if (!out) throw new Error('No output directory provided!')
  if (!fs.existsSync(out)) fs.mkdirSync(out)

  if (!demo) throw new Error('No demo provided!')
  if (!fs.existsSync(demo)) throw new Error('Demo path does not exist!')

  let total = getDemoTicks(demo)
  if (!total) throw new Error('Invalid demo provided!')

  let name = ph.basename(demo)

  let dem = ph.join(this.game.tmp, name)
  fs.copyFileSync(demo, dem)

  if (!Array.isArray(arr)) arr = [arr]

  for (let i = 0; i < arr.length; i++) {
    let a = arr[i]

    if (!a.pre) a.pre = 0
    if (!a.padding) a.padding = 0
    a.ticks[0] -= a.padding
    a.ticks[1] += a.padding
    if (!a.ticks[0] || a.ticks[0] < 0) a.ticks[0] = 0
    if (!a.ticks[1] || a.ticks[1] > total) a.ticks[1] = total
    if (a.ticks[1] - a.ticks[0] < 10) throw new Error('Invalid demo tick range!')
    if (a.ticks[0] - a.pre < 0) throw new Error('Tick pre setting not possible!')
    if (i !== 0 && a.ticks[0] <= arr[i - 1].ticks[1]) throw new Error(`Ticks of [${i}] & [${i + 1}] overlap!`)

    a.out = (a.out || `out-${i + 1}`).replace('.mp4', '')
    if (!a.cmd) a.cmd = ''
    if (a.spec) a.cmd += `; spec_player "${a.spec}"`
    if (!a.raw) a.cmd = 'volume 0.5; viewanim_reset; snd_soundmixer "Default_Mix"; spec_mode 4;' + (a.cmd || '')
    a.cmd = a.cmd.split(';').map(x => x.trim()).filter(x => x).join('\n')

    let cfg = `vdm_${i + 1}.cfg`
    fs.writeFileSync(ph.join(this.game.tmp, 'custom', 'cfg', cfg), a.cmd)
    a.cmd = `exec ${cfg}`

    arr[i] = a
  }

  if (!this.app) throw new Error('Game is not running!')

  createVDM(dem, arr, this.game.token)

  clearDemoGame(dem, dem)

  this.emit('log', { event: DemRec.Events.DEMO_LAUNCH, demo: name })
  this.app.send(['+mat_fullbright', '0', '+playdemo', name])

  let result = await new Promise((resolve, reject) => {
    let files = [...new Set(arr.map(x => x.out))]

    util.watch(ph.join(this.game.tmp, this.game.log), async log => {
      let map = log.data.match(/^(?:\d\d\/\d\d\/\d\d\d\d - \d\d:\d\d:\d\d: )?Missing map maps\/(.*?), {2}disconnecting\r\n$/)
      if (map) {
        log.close()
        reject(Error(`Map '${map[1]}' not found!`))
        return
      }

      if (log.data.match(/^(?:\d\d\/\d\d\/\d\d\d\d - \d\d:\d\d:\d\d: )?Redownloading all lightmaps\r\n$/)) {
        this.emit('log', { event: DemRec.Events.DEMO_LAUNCH_END, demo: name })
      }

      let end = log.data.match(/^(?:\d\d\/\d\d\/\d\d\d\d - \d\d:\d\d:\d\d: )?Ending movie after .*? seconds \(\d+ frames, .*? fps\)\r\n$/)
      if (end) {
        log.close()

        await util.sleep(1234)

        this.emit('log', { event: DemRec.Events.DEMO_DONE, demo: name })

        let dir = ph.join(svr.path, 'movies')

        let res = await this.runFFMPEG(arr, name, files, dir, out)

        util.remove(dir)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir)

        resolve(res)
        return
      }

      let regex = new RegExp(`\\[${this.game.token}]\\[(.*?)]\\[(.*?)](?:\\[(.*?)])?`, 'g')
      let matches = log.data.replace(/\r?\n/g, '').matchAll(regex)
      while (true) {
        let match = matches.next()
        if (match.done) break
        if (!match.value) continue

        let [, file, events, progress] = match.value
        events = events.split(',').map(Number)
        for (let event of events) {
          let o = { event, demo: name, file: files[file] }
          if (progress) o.progress = Number(progress)
          this.emit('log', o)
        }
      }
    })
  })

  util.remove([dem, dem.replace('.dem', '.vdm')])

  return result
}

DemRec.prototype.exit = async function (silent = false) {
  if (!silent) this.emit('log', { event: DemRec.Events.GAME_EXIT })
  if (this.app) await this.app.exit()
  await util.sleep(1234)
  this.kill()
  if (!silent) this.emit('log', { event: DemRec.Events.GAME_EXIT_END })
}

DemRec.prototype.kill = function () {
  let paths = [(svr && svr.path) ? ph.join(svr.path, 'movies') : null, ph.join(DATA, 'TMP')]
  if (this.game) {
    paths.push(this.game.tmp)
    util.unwatch(ph.join(this.game.tmp, this.game.log))
  }
  util.remove(paths)
}

DemRec.prototype.runFFMPEG = async function (arr, demo, files, dir, out) {
  let res = []
  for (let i = 0; i < files.length; i++) {
    let a = arr[i]
    let file = ph.join(dir, files[i])
    let input = ph.join(dir, 'tmp-' + files[i])
    let result = ph.join(out, files[i])

    await ffmpeg(`-i "${file + '.mp4'}" -i "${file + '.wav'}" -c:v copy -c:a aac "${this.cfg.FFMPEG ? input : result}.mp4"`, progress => {
      this.emit('log', { event: DemRec.Events.FFMPEG_PROCESS + Number(progress === 100), demo, file: files[i], progress, index: 1, total: (this.cfg.FFMPEG?.length || 0) + 1 })
    })
    util.remove([file + '.mp4', file + '.wav'])

    if (this.cfg.FFMPEG) {
      let parts = this.cfg.FFMPEG
      for (let i = 0; i < parts.length; i++) {
        let pipe = [`${file}_${i}`, `${file}_${i + 1}`]
        if (!i) pipe[0] = input
        let cmd = parts[i].join(' ')
          .replaceAll('%PREV%', pipe[0])
          .replaceAll('%NEXT%', pipe[1])
          .replaceAll('%IN%', input)
          .replaceAll('%DIR%', dir)
          .replaceAll('%TIME%', util.getTickTime(a.ticks[1] - a.ticks[0]))
          .replaceAll('%SECS%', (a.ticks[1] - a.ticks[0]) / (200 / 3))
          .replace(/%TIME\[(.*?)\]%/g, (_, b) => util.getTickTime(a.ticks[1] - a.ticks[0], Number(b)))
          .replace(/%SECS\[(.*?)\]%/g, (_, b) => (a.ticks[1] - a.ticks[0]) / (200 / 3) + Number(b))
          .replaceAll('%TIME_START%', util.getTickTime(a.padding))
          .replaceAll('%TIME_END%', util.getTickTime(a.ticks[1] - a.ticks[0] - a.padding))
          .replaceAll('%OUT%', result)

        await ffmpeg(cmd, progress => {
          this.emit('log', { event: DemRec.Events.FFMPEG_PROCESS + Number(progress === 100), demo: file, file: files[i], progress, index: i + 2, total: parts.length + 1 })
        })
        util.remove(pipe[0] + '.mp4')
      }
    }
    res.push(result + '.mp4')
  }
  this.emit('log', { event: DemRec.Events.FFMPEG_DONE, demo })
  return res
}

module.exports = DemRec

function createVDM (demo, arr, token) {
  let vdm = new VDM(demo)
  let last = 0
  let skip = 0

  let mark = (file, events, progress) => {
    return `echo [${token}][${file}][${events.filter(x => x).join(',')}]` + (progress ? `[${progress}]` : '')
  }

  for (let i = 0; i < arr.length; i++) {
    let a = arr[i]
    let same = a.out === arr[i - 1]?.out

    // goto
    if (a.ticks[0] !== 0) {
      vdm.add(last, [
        last && !same ? 'endmovie' : '',
        mark(i, [last && !same ? DemRec.Events.DEMO_RECORD_END : null, DemRec.Events.DEMO_SKIP]),
        'volume 0',
        `demo_gototick ${a.ticks[0] - a.pre}`
      ])
      skip++
    }

    // start
    if (a.pre) vdm.add(a.ticks[0] - a.pre, [a.cmd, 'volume 0'])
    vdm.add(a.ticks[0], [
      mark(i, [skip ? (DemRec.Events.DEMO_SKIP_END) : null, DemRec.Events.DEMO_RECORD]),
      a.cmd,
      `startmovie ${a.out + '.mp4'} ${token}`
    ])

    // ticks
    vdm.add(a.ticks, [mark(i, [DemRec.Events.DEMO_RECORD], '*')], '*')

    // finish
    if (i === arr.length - 1) vdm.add(a.ticks[1], ['volume 0', mark(i, [DemRec.Events.DEMO_RECORD_END]), 'stopdemo'])

    last = a.ticks[1]
  }

  vdm.write()

  return vdm.path
}

function getDemoTicks (file) {
  let buffer = fs.readFileSync(file)
  if (buffer.slice(0, 8).toString() !== 'HL2DEMO\0') return null
  return buffer.readIntLE(1060, 4)
}

// clears gamedir of demo file so we can launch it from a game with custom -game parameter
function clearDemoGame (demo, out) {
  let SIZ = 1161
  let SRC = new Uint8Array([0x8f, 0xc2, 0x75, 0x3c, 0x6c]) // STV
  let SRC2 = new Uint8Array([0xa3, 0x70, 0x1d, 0x0f, 0x1b]) // POV

  let buf = fs.readFileSync(demo)

  let s = buf.indexOf(SRC)
  if (s === -1) s = buf.indexOf(SRC2)

  buf[SIZ] -= 2

  if (s !== -1) {
    s += SRC.length
    let t = buf.slice(s)
    let res = Buffer.concat([buf.slice(0, s), t.slice(t.indexOf(0))])
    return fs.writeFileSync(out, res)
  }
  throw Error('Could not clear gamedir from demo file.')
}
