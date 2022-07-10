let fs = require('fs')
let child = require('child_process')
let ph = require('path')
let util = require('./util')

function SVR () {}

SVR.prototype.init = function (dir) {
  if (fs.existsSync(dir)) {
    this.path = ph.resolve(dir)
    this.exe = ph.join(this.path, 'svr_launcher.exe')
    this.movies = ph.join(this.path, 'movies')
    this.log = ph.join(this.path, 'data', 'SVR_LOG.txt')
    return true
  }
  return false
}

SVR.prototype.writeProfile = function (name, cfg) {
  let res = []
  for (let key in cfg) { for (let prop in cfg[key]) { res.push(`${key}_${prop}=${cfg[key][prop]}`) } }
  fs.writeFileSync(ph.join(this.path, 'data', 'profiles', name + '.ini'), `${res.join('\n')}\n`)
}

SVR.prototype.writeLaunchOptions = function (app, opts) {
  fs.writeFileSync(ph.join(this.path, 'svr_launch_params.ini'), `${app}=${opts}\n`)
}

SVR.prototype.run = async function (game, events) {
  let proc = await util.findProcess(x => x.name === ph.basename(game.exe) && x.cmd.indexOf(game.token) !== -1)
  if (!proc) {
    let svr = child.exec(`${this.exe} ${game.id}`, { cwd: this.path })
    await new Promise(resolve => {
      util.watch(this.log, log => {
        if (log.data.match(/^Hello from the game/)) events.hello()
        else if (log.data.match(/^Init for a .*? game/) || log.data.match(/^!!! ERROR/)) {
          events.init()
          log.close()
          resolve()
        }
      })
    })
    svr.on('error', e => { throw e })
  }

  let app = await util.findProcess(x => x.path.toLowerCase() === game.exe.toLowerCase())
  app.send = cmd => child.spawn(game.exe, ['-hijack', ...cmd])
  app.exit = () => {
    try { process.kill(app.id) } catch (e) { return false }
    app = null
  }

  return new Promise(resolve => {
    util.watch(ph.join(game.tmp, game.log), () => resolve(app), true)
    app.send(['+echo heartbeat'])
  })
}

module.exports = new SVR()
