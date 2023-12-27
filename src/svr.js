let fs = require('fs')
let child = require('child_process')
let ph = require('path')
let util = require('./util')
let Rcon = require('./lib/rcon')

function SVR () {}

SVR.prototype.init = function (dir) {
  if (fs.existsSync(dir)) {
    this.path = ph.resolve(dir)
    this.exe = ph.join(this.path, 'svr_launcher.exe')
    this.movies = ph.join(this.path, 'movies')
    this.profiles = ph.join(this.path, 'data', 'profiles')
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

SVR.prototype.run = async function (game, events) {
  let proc = await util.findProcess(x => x.name === ph.basename(game.exe) && x.cmd.indexOf(game.token) !== -1)
  if (proc) throw new Error(`An SVR instance is already running! [${proc.id}]`)

  let pass = util.rndkey()

  let svr = child.exec(`"${this.exe}" ${game.id} -multirun -usercon +rcon_password "${pass}" +net_start ${game.params}`.trim())

  svr.on('error', e => { throw e })

  await new Promise(resolve => {
    svr.stdout.on('data', d => {
      let parts = d.toString().trim().split(' ')
      switch (parts[0]) {
        case 'HELLO': {
          if (events.hello) events.hello()
          break
        }
        case 'INIT': {
          if (events.init) events.init()
          resolve()
          break
        }
        case 'EXIT': {
          if (events.exit) events.exit(Number(parts[1]))
          svr.emit('finish')
          break
        }
      }
    })
  })

  let app = await util.findProcess(x => x.cmd.indexOf(pass) !== -1)
  if (!app) throw new Error('Could not find child process!')

  let server = null

  await new Promise((resolve, reject) => {
    util.watch(ph.join(game.dir, game.log), log => {
      let match = log.data.match(/(?:host (.*?):.*Server (.*?),|IP (.*?),.*ports (.*?) )/s)
      if (match && !server) {
        log.close()
        let [ip, port] = match.slice(1).filter(x => x)
        server = new Rcon(ip, port, pass)
        server.connect()
        server.once('error', reject)
        server.once('auth', resolve)
      }
    })
  })

  svr.send = cmd => server.send(cmd)
  svr.exit = async () => {
    server.disconnect()
    let tk = child.spawn('taskkill', ['/pid', app.id, '/f', '/t'])
    await new Promise(resolve => tk.on('close', resolve))
    svr = null
  }

  return svr
}

module.exports = new SVR()
