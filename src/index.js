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
  this.token = this.cfg.General.game_token || 'demrec'

  if (!this.cfg) throw new Error(`Config file "${config}" not found!`)
  if (!steam.init()) throw new Error('Steam is not running!')
  if (!svr.init(this.cfg.General.svr_dir)) throw new Error('Could not find valid SVR directory!')

  this.setGame(this.cfg.General.game_app)
  this.setLaunchOptions(this.cfg.General.game_args)
  this.setProfile(this.cfg)

  this.kill()
  if (!fs.existsSync(this.game.tmp)) fs.mkdirSync(this.game.tmp)
  if (!fs.existsSync(svr.movies)) fs.mkdirSync(svr.movies)

  this.updateCustomFiles()
}

DemRec.prototype.setGame = function (app) {
  this.game = {
    id: app,
    ...steam.get(app),
    log: 'console.log',
    demo: 'demo.dem',
    custom: 'custom'
  }
  this.game.token = ph.join('cfg', this.token)
  this.game.tmp = ph.join(this.game.dir, this.game.token)
}

DemRec.prototype.updateCustomFiles = function () {
  let vpk = ph.join(this.game.exe, '..', 'bin', 'vpk.exe')
  let TMP = ph.join(DATA, 'TMP')

  util.modify(ph.join(DATA, this.game.id.toString()), {
    files: ['cfg/start.cfg'],
    vars: {
      '%LOG%': ph.join(this.game.token, this.game.log).replaceAll('\\', '/'),
      '%CFG%': (this.cfg.General.game_cfgs || '').split(' ').map(x => `exec ${x}`).join('\n')
    }
  }, TMP)

  let insert = []

  let custom = this.cfg.General.game_custom
  if (custom) {
    let paths = custom.split(',').map(x => ph.resolve(x))
    for (let path of paths) {
      if (fs.existsSync(path)) {
        if (!fs.statSync(path).isDirectory()) insert.push(path)
        else {
          let files = fs.readdirSync(path)
          files.forEach(file => insert.push(ph.join(path, file)))
        }
      }
    }
  }

  let dirs = []

  for (let file of insert) {
    if (!file.endsWith('.vpk')) util.copyFolder(file, TMP)
    else {
      // vpk extracting is a bit broken so we have to work around using vpk x command
      let files = util.run(`"${vpk}" "${file}"`) // create folder structure and get file list
      files = files.split(/\r?\n/).map(x => x.split(' ').pop())

      let dir = ph.join(ph.dirname(file), ph.basename(file, '.vpk'))

      util.run(`"${vpk}" x "${file}" ${files.join(' ')}`, { cwd: dir }) // add files to the folder structure using file list

      dirs.push(dir)

      util.copyFolder(dir, TMP)
    }
  }

  util.copyFolder(TMP, ph.join(this.game.tmp, this.game.custom))

  util.remove([...dirs, TMP])
}

DemRec.prototype.setLaunchOptions = function (opts) {
  let args = []

  args.push(`-insert_search_path "${ph.join(this.game.tmp, this.game.custom)}"`)

  if (opts) args.push(opts)

  svr.writeLaunchOptions(this.game.id, args.join(' '))
}

DemRec.prototype.setProfile = function (cfg) {
  svr.writeProfile(this.token, {
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
    a.cmd = `exec ${ph.join(this.token, cfg)}`
  }

  if (!this.app) throw new Error('Game is not running!')

  this.createVDM(dem, arr)

  this.app.send(['+playdemo', ph.join(this.game.token, this.game.demo)])

  return await new Promise(resolve => {
    let log = ph.join(this.game.tmp, this.game.log)
    util.watch(log, line => {
      let regex = new RegExp(`\\[${this.token}]\\[(.*?)]\\[(.*?)]\\[(.*?)]`, 'g')
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
                let file = ph.join(dir, files[i])
                let tmp = ph.join(dir, 'tmp-' + files[i])
                let mp4 = ph.join(out, files[i])

                await ffmpeg(`-i "${file + '.mp4'}" -i "${file + '.wav'}" -c:v copy -c:a aac "${this.cfg.FFMPEG ? tmp : mp4}.mp4"`, progress => {
                  this.emit('log', { file: files[i], type: 'Merging', progress, index: this.cfg.FFMPEG ? 1 : null })
                })

                if (this.cfg.FFMPEG) {
                  let parts = this.cfg.FFMPEG
                  for (let i = 0; i < parts.length; i++) {
                    let cmd = parts[i].join(' ')
                      .replaceAll('%IN%', tmp)
                      .replaceAll('%DIR%', dir)
                      .replaceAll('%OUT%', mp4)
                    await ffmpeg(cmd, progress => {
                      this.emit('log', { file: files[i], type: 'Merging', progress, index: i + 2 })
                    })
                  }
                }

                res.push(mp4 + '.mp4')
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

  let mark = (file, type, progress = 0) => `echo [${this.token}][${file}][${type}][${progress}]`

  for (let i = 0; i < arr.length; i++) {
    let a = arr[i]
    let same = a.out === arr[i - 1]?.out
    if (a.ticks[0] !== 0) vdm.add(last, [same ? '' : 'endmovie', 'volume 0', mark(a.out, 'Skipping'), `demo_gototick ${a.ticks[0]}`])
    vdm.add(a.ticks[0], [a.cmd, `startmovie ${a.out + '.mp4'} ${this.token}`])
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
