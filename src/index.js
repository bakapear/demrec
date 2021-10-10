let fs = require('fs')
let ph = require('path')
let ut = require('util')
let child = require('child_process')
let util = require('./util')
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
    demo: 'demo.dem',
    cmd: 'cmd.cfg'
  }
  this.game.token = ph.join('cfg', TOKEN)
  this.game.tmp = ph.join(this.game.dir, this.game.token)
}

DemRec.prototype.setLaunchOptions = function (opts) {
  let args = [`+sv_cheats 1 -nomouse +unbindall +con_timestamp 1 +con_logfile ${ph.join(this.game.token, this.game.log)}`]

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

DemRec.prototype.record = async function (obj, output) {
  let file = Date.now().toString()

  if (obj.cmd) {
    fs.writeFileSync(ph.join(this.game.tmp, this.game.cmd), obj.cmd)
    obj.cmd = `exec ${ph.join(TOKEN, this.game.cmd)}`
  }

  let demo = ph.join(this.game.tmp, this.game.demo)
  fs.copyFileSync(obj.demo, demo)
  obj.demo = demo

  createVDM(obj, file + '.mp4')

  this.app.send(['+playdemo', ph.join(this.game.token, this.game.demo)])

  await new Promise(resolve => {
    let log = ph.join(this.game.tmp, this.game.log)
    util.watch(log, line => {
      let match = null
      let parts = line.split(/\r?\n/)
      let regex = new RegExp(`\\[${TOKEN}]-(\\w+)(?:-(\\d+))?`)
      for (let part of parts) {
        let m = part.match(regex)
        if (m) match = m
      }
      if (match) {
        let type = match[1]
        let progress = Number(match[2]) || 0
        this.emit('log', { type, progress })
        if (progress === 100) {
          util.unwatch(log)
          setTimeout(async () => {
            let movies = ph.join(svr.path, 'movies')
            await mergeMovieFiles(ph.join(movies, file), movies, output)
            resolve()
          }, 1000)
        }
      }
    })
  })
}

DemRec.prototype.exit = async function () {
  if (this.app) await this.app.exit()
  this.kill()
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

function createVDM (obj, file) {
  if (obj.tick.padding) {
    obj.tick.start -= obj.tick.padding
    obj.tick.end += obj.tick.padding
  }
  if (obj.tick.start < 0) obj.tick.start = 0
  if (obj.tick.end - obj.tick.start < 10) throw new Error('Invalid demo tick range!')
  if (!validDemo(obj.demo)) throw new Error('Invalid demo provided!')

  let vdm = new VDM(obj.demo)
  if (obj.tick.start !== 0) vdm.add(0, `echo [${TOKEN}]-Skipping; demo_gototick ${obj.tick.start}`)
  vdm.add(obj.tick.start, [obj.cmd, `startmovie ${file} ${TOKEN}`].filter(x => x).join('; '))
  vdm.add([obj.tick.start, obj.tick.end], `echo [${TOKEN}]-Progress-*`)
  vdm.add(obj.tick.end, 'stopdemo')
  vdm.write()

  return vdm.path
}

async function mergeMovieFiles (file, dir, out) {
  await ffmpeg(`-i "${file + '.mp4'}" -i "${file + '.wav'}" -c:v copy -c:a aac "${out}"`)

  fs.rmSync(dir, { force: true, recursive: true })
  if (!fs.existsSync(dir)) fs.mkdirSync(dir)
}

async function ffmpeg (cmd) {
  let args = [...util.splitArgs(cmd), '-y', '-v', 'error']
  args = args.map(x => ["''", '""'].includes(x[0] + x.slice(-1)) ? x.slice(1, -1) : x)

  let app = child.spawn('ffmpeg.exe', args)
  app.stderr.on('data', e => { throw new Error(e) })

  await new Promise(resolve => app.on('close', resolve))
}

function validDemo (file) {
  if (!fs.existsSync(file)) return false
  if (fs.readFileSync(file).slice(0, 8).toString() !== 'HL2DEMO\0') return false
  return true
}
