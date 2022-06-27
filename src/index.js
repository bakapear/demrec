let fs = require('fs')
let ph = require('path')
let ut = require('util')
let util = require('./util')
let ffmpeg = require('./ffmpeg')
let steam = require('./steam')
let svr = require('./svr')
let VDM = require('./vdm')

let DATA = ph.join(__dirname, 'data')

ut.inherits(DemRec, require('events').EventEmitter)

function DemRec (config) {
  this.cfg = util.readINI(config, ['FFMPEG'])

  if (!this.cfg) throw new Error(`Config file "${config}" not found!`)
  if (!steam.init()) throw new Error('Steam is not running!')
  if (!svr.init(this.cfg.General.svr_dir)) throw new Error('Could not find valid SVR directory!')

  this.setGame(this.cfg.General.game_app)
  this.setLaunchOptions(this.cfg.General.game_args)
  this.setProfile(this.cfg)

  this.kill()
  if (!fs.existsSync(svr.movies)) fs.mkdirSync(svr.movies)
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
      x = 'game+mod+custom_mod\t' + p + (fs.existsSync(p) && fs.statSync(p).isDirectory() ? '/*' : '')
    }
    return x
  }).join('\n\t\t\t')

  util.modify(ph.join(DATA, this.game.id.toString()), {
    files: ['custom/cfg/start.cfg', 'gameinfo.txt'],
    vars: {
      '%LOG%': this.game.log,
      '%CFG%': (this.cfg.General.game_cfgs || '').split(/[,;]/).map(x => x ? `exec ${x.trim()}` : '').join('\n'),
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
    velo: cfg['Velocity Overlay']
  })
}

DemRec.prototype.launch = async function () {
  this.updateCustomFiles()
  this.app = await svr.run(this.game)
}

DemRec.prototype.record = async function (demo, arr, out) {
  if (!out) throw new Error('No output directory provided!')
  if (!fs.existsSync(out)) fs.mkdirSync(out)

  if (!demo) throw new Error('No demo provided!')
  if (!fs.existsSync(demo)) throw new Error('Demo path does not exist!')

  let total = getDemoTicks(demo)
  if (!total) throw new Error('Invalid demo provided!')

  let file = Math.random().toString(36).slice(2) + '.dem'

  let dem = ph.join(this.game.tmp, file)
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

  this.createVDM(dem, arr)

  replaceDemGame(dem, this.game.token, dem)

  this.app.send(['+playdemo', file])

  return await new Promise((resolve, reject) => {
    let log = ph.join(this.game.tmp, this.game.log)
    util.watch(log, line => {
      let map = line.match(/^Missing map maps\/(.*?), {2}disconnecting/)
      if (map) {
        util.unwatch(log)
        reject(Error(`Map '${map[1]}' not found!`))
        return
      }
      let regex = new RegExp(`\\[${this.game.token}]\\[(.*?)]\\[(.*?)]\\[(.*?)]`, 'g')
      let matches = line.replace(/\r?\n/g, '').matchAll(regex)
      while (true) {
        let match = matches.next()
        if (match.done) break
        if (match.value) {
          let [, file, type, progress] = match.value
          progress = Number(progress) || 0

          this.emit('log', { file, type, progress })
          if (type === 'Done') {
            util.unwatch(log)
            setTimeout(async () => {
              let dir = ph.join(svr.path, 'movies')
              let files = [...new Set(arr.map(x => x.out))]
              let res = []

              for (let i = 0; i < files.length; i++) {
                let a = arr[i]
                let file = ph.join(dir, files[i])
                let input = ph.join(dir, 'tmp-' + files[i])
                let result = ph.join(out, files[i])

                await ffmpeg(`-i "${file + '.mp4'}" -i "${file + '.wav'}" -c:v copy -c:a aac "${this.cfg.FFMPEG ? input : result}.mp4"`, progress => {
                  this.emit('log', { file: files[i], type: 'Merging', progress, index: this.cfg.FFMPEG ? 1 : null })
                })
                util.remove([file + '.mp4', file + '.wav'])

                if (this.cfg.FFMPEG) {
                  let parts = this.cfg.FFMPEG
                  for (let i = 0; i < parts.length; i++) {
                    let pipe = [`${file}_${i}`, `${file}_${i + 1}`]
                    let cmd = parts[i].join(' ')
                      .replaceAll('%PREV%', pipe[0])
                      .replaceAll('%NEXT%', pipe[1])
                      .replaceAll('%IN%', input)
                      .replaceAll('%DIR%', dir)
                      .replaceAll('%TIME%', util.getTickTime(a.ticks[1] - a.ticks[0]))
                      .replaceAll('%TIME_START%', util.getTickTime(a.padding))
                      .replaceAll('%TIME_END%', util.getTickTime(a.ticks[1] - a.ticks[0] - a.padding))
                      .replaceAll('%OUT%', result)

                    await ffmpeg(cmd, progress => {
                      this.emit('log', { file: files[i], type: 'Merging', progress, index: i + 2 })
                    })
                    util.remove(pipe[0])
                  }
                }

                res.push(result + '.mp4')
              }

              util.remove(dir)
              if (!fs.existsSync(dir)) fs.mkdirSync(dir)

              resolve(res)
            }, 1000)
          }
        }
      }
    })
  })
}

DemRec.prototype.exit = async function () {
  if (this.app) await this.app.exit()
  await new Promise(resolve => setTimeout(() => {
    this.kill()
    resolve()
  }, 2000))
}

DemRec.prototype.kill = function () {
  let paths = [(svr && svr.path) ? ph.join(svr.path, 'movies') : null, ph.join(DATA, 'TMP')]
  if (this.game) {
    paths.push(this.game.tmp)
    util.unwatch(ph.join(this.game.tmp, this.game.log))
  }
  util.remove(paths)
}

DemRec.prototype.createVDM = function (demo, arr) {
  let vdm = new VDM(demo)
  let last = 0

  let mark = (file, type, progress = 0) => `echo [${this.game.token}][${file}][${type}][${progress}]`

  for (let i = 0; i < arr.length; i++) {
    let a = arr[i]
    let same = a.out === arr[i - 1]?.out
    if (a.ticks[0] !== 0) vdm.add(last, [same ? '' : 'endmovie', 'volume 0', mark(a.out, 'Skipping'), `demo_gototick ${a.ticks[0] - a.pre}`])
    if (a.pre) vdm.add(a.ticks[0] - a.pre, [a.cmd, 'volume 0'])
    vdm.add(a.ticks[0], [a.cmd, `startmovie ${a.out + '.mp4'} ${this.game.token}`])
    vdm.add(a.ticks, [mark(a.out, 'Rendering', '*')], '*')
    if (i === arr.length - 1) vdm.add(a.ticks[1], ['volume 0', mark(a.out, 'Done'), 'stopdemo'])
    last = a.ticks[1]
  }

  vdm.write()

  return vdm.path
}

module.exports = DemRec

function getDemoTicks (file) {
  let buffer = fs.readFileSync(file)
  if (buffer.slice(0, 8).toString() !== 'HL2DEMO\0') return null
  return buffer.readIntLE(1060, 4)
}

function replaceDemGame (demo, game, out) {
  let SIZ = 1161
  let SRC = new Uint8Array([0x8f, 0xc2, 0x75, 0x3c, 0x6c])

  let buf = fs.readFileSync(demo)
  buf[SIZ] += game.length - 2

  let s = buf.indexOf(SRC)
  if (s !== -1) {
    s += SRC.length
    let t = buf.slice(s)
    let res = Buffer.concat([buf.slice(0, s), Buffer.from(game), t.slice(t.indexOf(0))])
    return fs.writeFileSync(out, res)
  }
  throw Error('Could not replace demo file.')
}
