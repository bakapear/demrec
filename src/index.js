let fs = require('fs')
let ph = require('path')
let util = require('./util')
let ffmpeg = require('./ffmpeg')
let steam = require('./steam')
let svr = require('./svr')
let VDM = require('./vdm')

let DATA = ph.join(__dirname, 'data')
let SVR = ph.join(__dirname, '..', 'svr')
let TMP = ph.join(__dirname, '..', 'tmp')

class DemRec extends require('events') {
  constructor (config) {
    if (process.platform !== 'win32') throw new Error(`Platform '${process.platform}' not supported.`)

    super()

    if (!fs.existsSync(config)) throw new Error(`Config file "${config}" not found!`)

    this.cfg = util.readINI(config, ['FFMPEG RECORD', 'FFMPEG RECORD ONLY', 'FFMPEG'])

    if (!svr.init(SVR)) throw new Error('Could not find valid SVR directory!')

    this.initialized = false
    this.params = ''
    this.tmp = TMP
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
  try { await util.run('ffmpeg.exe -version') } catch (e) { throw new Error('FFmpeg not found!') }
  if (!await steam.init()) throw new Error('Steam is not running!')

  this.setGame(this.cfg.General.game_app, this.cfg.General.game_args)
  // this.setProfile(this.cfg)

  this.kill()
  if (this.cfg.Video.output) svr.movies = ph.resolve(this.cfg.Video.output)
  if (!fs.existsSync(svr.profiles)) fs.mkdirSync(svr.profiles)

  this.initialized = true
}

DemRec.prototype.setGame = function (app, args) {
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
  this.game.params = `-game ${this.game.token} ${args || ''}`.trim()
}

DemRec.prototype.updateCustomFiles = function () {
  if (!fs.existsSync(this.game.tmp)) fs.mkdirSync(this.game.tmp)
  if (!fs.existsSync(this.tmp)) fs.mkdirSync(this.tmp)

  let out = ph.join(this.tmp, 'custom')
  if (!fs.existsSync(out)) fs.mkdirSync(out)

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
  }, out)

  util.copyFolder(out, this.game.tmp)
  util.remove(out)
}

DemRec.prototype.setProfile = function (cfg, index, a) {
  let ffmpeg = (cfg['FFMPEG RECORD']?.[0] || cfg['FFMPEG RECORD ONLY']?.[0] || []).join(' ')
  ffmpeg = (ffmpeg && a) ? addArgsToFFMPEG(ffmpeg, a) : ''

  svr.writeProfile(this.game.token + (index ? `_${index}` : ''), {
    video: { ...cfg.Video, output: svr.movies },
    motion_blur: cfg['Motion Blur'],
    velo: cfg['Velocity Overlay'],
    audio: { enabled: 1 },
    custom: { args: ffmpeg, args_only: Number(!!cfg['FFMPEG RECORD ONLY']) }
  })
}

DemRec.prototype.launch = async function (silent = false) {
  if (!this.initialized) await this.init()
  this.updateCustomFiles()

  if (!silent) this.emit('log', { event: DemRec.Events.GAME_LAUNCH })

  let file = ph.join(this.game.exe, '..', 'steam_appid.txt')

  this.app = await svr.run(this.game, {
    hello: () => {
      // kill steam overlay by deleting appid txt
      // it automatically creates a new one but the game launched wont have overlay!
      if (fs.existsSync(file)) fs.unlinkSync(file)
    },
    exit: code => {
      this.app = null
      this.code = code
      this.exit(true)
    }
  })

  if (!silent) this.emit('log', { event: DemRec.Events.GAME_LAUNCH_END })
}

DemRec.prototype.record = async function (demo, arr, out) {
  if (!this.initialized) await this.init()
  if (!this.app) throw new Error('Game not running!')

  if (!out) out = ''
  else if (!fs.existsSync(out)) fs.mkdirSync(out)
  out = ph.resolve(out)

  if (!demo) throw new Error('No demo provided!')
  if (!fs.existsSync(demo)) throw new Error('Demo path does not exist!')

  let info = getDemoInfo(demo)
  if (!info) throw new Error('Invalid demo provided!')

  if (!Array.isArray(arr)) arr = [arr]

  for (let i = 0; i < arr.length; i++) {
    let a = arr[i]

    if (!a.ffmpeg) a.ffmpeg = {}
    if (!a.pre) a.pre = 0
    if (!a.padding) a.padding = 0
    a.ticks[0] -= a.padding
    a.ticks[1] += a.padding
    if (!a.ticks[0] || a.ticks[0] < 0) a.ticks[0] = 0
    if (!a.ticks[1] || a.ticks[1] > info.total) a.ticks[1] = info.total
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

    this.setProfile(this.cfg, i + 1, a)
  }

  let name = ph.basename(demo)
  let file = util.rndkey() + '.dem'

  let dem = clearDemoGame(demo, ph.join(this.game.tmp, file))
  let vdm = createVDM(dem, arr, this.game.token)

  let povr = addParticleOverride(this.game.tmp, info.map)

  this.emit('log', { event: DemRec.Events.DEMO_LAUNCH, demo: name })

  this.app.send(`sv_cheats 1; mat_fullbright 0; playdemo "${file}"`)

  await new Promise((resolve, reject) => {
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
        resolve()
        return
      }

      let regex = new RegExp(`\\[${this.game.token}]\\[(.*?)]\\[(.*?)](?:\\[(.*?)])?`, 'g')
      let matches = log.data.replace(/\r?\n/g, '').matchAll(regex)
      while (true) {
        let match = matches.next()
        if (match.done) break
        if (!match.value) continue

        let [, index, events, progress] = match.value
        events = events.split(',').map(Number)
        for (let event of events) {
          let o = { event, demo: name, file: arr[index].out }
          if (progress) o.progress = Number(progress)
          this.emit('log', o)
        }
      }
    })
  })

  let res = await this.runFFMPEG(arr, out, name)

  util.remove([dem, vdm, povr, this.tmp])

  return res
}

DemRec.prototype.exit = async function (silent = false) {
  if (!silent) this.emit('log', { event: DemRec.Events.GAME_EXIT })
  if (this.app) {
    this.app.send('quit')
    await this.app.exit()
    await util.sleep(1234)
  }
  this.kill()
  if (!silent) this.emit('log', { event: DemRec.Events.GAME_EXIT_END })
}

DemRec.prototype.kill = function () {
  let paths = [ph.join(DATA, 'TMP')]
  if (svr && svr.path) paths.push(svr.movies, svr.profiles)
  if (this.game) {
    paths.push(this.game.tmp)
    util.unwatch(ph.join(this.game.tmp, this.game.log))
  }
  util.remove(paths)
}

DemRec.prototype.runFFMPEG = async function (arr, out, demo) {
  let res = []
  let dir = svr.movies
  let files = [...new Set(arr.map(x => x.out))]
  for (let i = 0; i < files.length; i++) {
    let a = arr[i]
    let file = ph.join(dir, files[i])
    let result = ph.join(out, files[i])

    if (this.cfg.FFMPEG) {
      let parts = this.cfg.FFMPEG
      for (let i = 0; i < parts.length; i++) {
        let pipe = [`${file}_${i}`, `${file}_${i + 1}`]
        if (i === 0) pipe[0] = file
        let cmd = parts[i].join(' ')
          .replaceAll('%INPUT%', file)
          .replaceAll('%PREV%', pipe[0])
          .replaceAll('%NEXT%', pipe[1])
          .replaceAll('%DIR%', dir)
          .replaceAll('%OUT%', result)

        cmd = addArgsToFFMPEG(cmd, a)

        await ffmpeg(cmd, progress => {
          this.emit('log', { event: DemRec.Events.FFMPEG_PROCESS + Number(progress === 100), demo, file: files[i], progress, index: i + 2, total: parts.length + 1 })
        })

        util.remove([pipe[0] + '.mp4', pipe[0] + '.wav'])
      }
      res.push(result + '.mp4')
    } else {
      let I = { mp4: file + '.mp4', wav: file + '.wav' }
      let O = { mp4: result + '.mp4', wav: result + '.wav' }

      fs.copyFileSync(I.mp4, O.mp4)
      fs.copyFileSync(I.wav, O.wav)
      res.push(O.mp4, O.wav)
      util.remove([I.mp4, I.wav])
    }
  }
  this.emit('log', { event: DemRec.Events.FFMPEG_DONE, demo })

  util.remove(dir)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir)

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
      `startmovie ${a.out + '.mp4'} ${token}_${i + 1}`
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

function addParticleOverride (tmp, map) {
  let dir = ph.join(tmp, 'custom', 'maps')
  let pipe = [ph.join(dir, 'particles_template.txt'), ph.join(dir, `${map}_particles.txt`)]
  fs.copyFileSync(...pipe)
  return pipe[1]
}

function getDemoInfo (file) {
  let buffer = fs.readFileSync(file)
  if (buffer.toString('utf8', 0, 8) !== 'HL2DEMO\0') return null
  return {
    map: buffer.toString('utf8', 536, buffer.indexOf(0, 536)),
    total: buffer.readIntLE(1060, 4)
  }
}

// clears gamedir of demo file so we can launch it from a game with custom -game parameter
function clearDemoGame (demo, out) {
  let SIZ = 1161
  let SRC = new Uint8Array([0x8f, 0xc2, 0x75, 0x3c, 0x6c]) // STV
  let SRC2 = new Uint8Array([0xa3, 0x70, 0x1d, 0x0f, 0x1b]) // POV

  let buf = fs.readFileSync(demo)

  let s = buf.indexOf(SRC)
  if (s === -1) s = buf.indexOf(SRC2)

  if (buf[SIZ] < 2) buf[SIZ + 1]--
  buf[SIZ] -= 2

  if (s !== -1) {
    s += SRC.length
    let t = buf.slice(s)
    let res = Buffer.concat([buf.slice(0, s), t.slice(t.indexOf(0))])
    fs.writeFileSync(out, res)
    return out
  }
  throw Error('Could not clear gamedir from demo file.')
}

function addArgsToFFMPEG (str, a) {
  str = str
    .replaceAll('%TIME%', util.getTickTime(a.ticks[1] - a.ticks[0]))
    .replaceAll('%SECS%', (a.ticks[1] - a.ticks[0]) / (200 / 3))
    .replace(/%TIME\[(.*?)\]%/g, (_, b) => util.getTickTime(a.ticks[1] - a.ticks[0], Number(b)))
    .replace(/%SECS\[(.*?)\]%/g, (_, b) => (a.ticks[1] - a.ticks[0]) / (200 / 3) + Number(b))
    .replaceAll('%TIME_START%', util.getTickTime(a.padding))
    .replaceAll('%TIME_END%', util.getTickTime(a.ticks[1] - a.ticks[0] - a.padding))

  for (let key in a.ffmpeg) str = str.replaceAll(`%${key}%`, a.ffmpeg[key])

  return str
}
