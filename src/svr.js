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

SVR.prototype.run = async function (game) {
  let proc = util.findProcess(x => x.cmd.split(' ').pop() === ph.basename(game.token))
  if (!proc) {
    let svr = child.exec(`${this.exe} ${game.id}`, { cwd: this.path })
    await new Promise(resolve => svr.on('exit', resolve))
  }

  return new Promise((resolve, reject) => {
    let app = util.findProcess(x => x.path.toLowerCase() === game.exe.toLowerCase())
    app.send = cmd => child.spawn(game.exe, ['-hijack', ...cmd])
    app.exit = () => process.kill(app.id)
    if (proc) resolve(app)
    else {
      let log = ph.join(game.tmp, game.log)
      util.watch(log, line => {
        util.unwatch(log)
        resolve(app)
      })
    }
  })
}

module.exports = new SVR()
