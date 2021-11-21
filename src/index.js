let fs = require('fs')
let ph = require('path')
let ut = require('util')
let util = require('./util')
let ffmpeg = require('./ffmpeg')
let steam = require('./steam')
let svr = require('./svr')
let VDM = require('./vdm')

let DATA = ph.join(__dirname, 'data')

let TOKEN = 'demrec'

ut.inherits(DemRec, require('events').EventEmitter)

function DemRec (config) {
  this.cfg = util.readINI(config)

  if (!this.cfg) throw new Error(`Config file "${config}" not found!`)
  if (!steam.init()) throw new Error('Steam is not running!')
  if (!svr.init(this.cfg.General.svr_dir)) throw new Error('Could not find valid SVR directory!')

  this.setGame(this.cfg.General.game_appid)
  this.setLaunchOptions(this.cfg.General.game_args)
  this.setProfile(this.cfg)

  this.kill()
  if (!fs.existsSync(this.game.tmp)) fs.mkdirSync(this.game.tmp)
  if (!fs.existsSync(svr.movies)) fs.mkdirSync(svr.movies)
}

DemRec.prototype.setGame = function (app) {
  this.game = {
    id: app,
    ...steam.get(app),
    log: 'console.log',
    demo: 'demo.dem'
  }
  this.game.token = ph.join('cfg', TOKEN)
  this.game.tmp = ph.join(this.game.dir, this.game.token)
}

DemRec.prototype.setLaunchOptions = function (opts) {
  let args = [`-nomouse +sv_cheats 1 +unbindall +volume 0 +con_logfile ${ph.join(this.game.token, this.game.log)}`]

  let cfgs = this.cfg.General.game_cfgs
  if (cfgs) {
    args.push(`-insert_search_path "${ph.join(DATA, this.game.id + '.vpk')}"`)
    cfgs.split(' ').filter(x => x).forEach(x => args.push(`+exec cfgs/${x}`))
  }

  if (opts) args.push(opts)

  args.push('+echo ' + TOKEN)

  svr.writeLaunchOptions(this.game.id, args.join(' '))
}

DemRec.prototype.setProfile = function (cfg) {
  svr.writeProfile(TOKEN, {
    video: cfg.Video,
    motion_blur: cfg['Motion Blur'],
    velo: cfg['Velocity Overlay']
  })
}

DemRec.prototype.launch = async function () {
  this.app = await svr.run(this.game)
}

DemRec.prototype.record = async function (demo, arr, out) {
  if (!out) throw new Error('No output directory provided!')
  if (!fs.existsSync(out)) fs.mkdirSync(out)

  if (!demo) throw new Error('No demo provided!')
  if (!fs.existsSync(demo)) throw new Error('Demo path does not exist!')

  let total = getDemoTicks(demo)
  if (!total) throw new Error('Invalid demo provided!')

  let dem = ph.join(this.game.tmp, this.game.demo)
  fs.copyFileSync(demo, dem)

  if (!Array.isArray(arr)) arr = [arr]

  for (let i = 0; i < arr.length; i++) {
    let a = arr[i]

    if (!a.ticks[0] || a.ticks[0] < 0) a.ticks[0] = 0
    if (!a.ticks[1] || a.ticks[1] > total) a.ticks[1] = total
    if (a.ticks[1] - a.ticks[0] < 10) throw new Error('Invalid demo tick range!')
    if (i !== 0 && a.ticks[0] <= arr[i - 1].ticks[1]) throw new Error(`Ticks of [${i}] & [${i + 1}] overlap!`)

    a.out = (a.out || `out-${i + 1}`).replace('.mp4', '')
    if (!a.cmd) a.cmd = ''
    if (a.spec) a.cmd += `; spec_player "${a.spec}"`
    if (!a.raw) a.cmd = 'volume 0.5; viewanim_reset; snd_soundmixer "Default_Mix"; spec_mode 4;' + (a.cmd || '')
    a.cmd = a.cmd.split(';').map(x => x.trim()).filter(x => x).join('\n')

    let cfg = `${i + 1}.cfg`
    fs.writeFileSync(ph.join(this.game.tmp, cfg), a.cmd)
    a.cmd = `exec ${ph.join(TOKEN, cfg)}`
  }

  if (!this.app) throw new Error('Game is not running!')

  createVDM(dem, arr)

  this.app.send(['+playdemo', ph.join(this.game.token, this.game.demo)])

  return await new Promise(resolve => {
    let log = ph.join(this.game.tmp, this.game.log)
    util.watch(log, line => {
      let regex = new RegExp(`\\[${TOKEN}]\\[(.*?)]\\[(.*?)]\\[(.*?)]`, 'g')
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
              let files = arr.map(x => x.out)
              let res = []

              for (let i = 0; i < files.length; i++) {
                let file = ph.join(dir, files[i])
                let mp4 = ph.join(out, files[i] + '.mp4')

                await ffmpeg(`-i "${file + '.mp4'}" -i "${file + '.wav'}" -c:v copy -c:a aac "${mp4}"`, progress => {
                  this.emit('log', { file: files[i], type: 'Merging', progress })
                })

                res.push(mp4)
              }

              fs.rmSync(dir, { force: true, recursive: true })
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
  await new Promise(resolve => setTimeout(() => this.kill(), 2000))
}

DemRec.prototype.kill = function () {
  let paths = [(svr && svr.path) ? ph.join(svr.path, 'movies') : null]
  if (this.game) {
    paths.push(this.game.tmp)
    util.unwatch(ph.join(this.game.tmp, this.game.log))
  }
  paths.forEach(x => x && fs.existsSync(x) && fs.rmSync(x, { force: true, recursive: true }))
}

module.exports = DemRec

function createVDM (demo, arr) {
  let vdm = new VDM(demo)
  let last = 0

  let mark = (file, type, progress = 0) => `echo [${TOKEN}][${file}][${type}][${progress}]`

  for (let i = 0; i < arr.length; i++) {
    let a = arr[i]
    if (a.ticks[0] !== 0) vdm.add(last, ['endmovie', 'volume 0', mark(a.out, 'Skipping'), `demo_gototick ${a.ticks[0]}`])
    vdm.add(a.ticks[0], [a.cmd, `startmovie ${a.out + '.mp4'} ${TOKEN}`])
    vdm.add(a.ticks, [mark(a.out, 'Rendering', '*')], '*')
    if (i === arr.length - 1) vdm.add(a.ticks[1], ['volume 0', mark(a.out, 'Done'), 'stopdemo'])
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
