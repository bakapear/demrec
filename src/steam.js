let fs = require('fs')
let ph = require('path')
let util = require('./util')

let APPS = {
  240: ['Counter-Strike Source/hl2.exe', 'cstrike'],
  440: ['Team Fortress 2/tf_win64.exe', 'tf', 'tf2_steam.ini'],
  730: ['Counter-Strike Global Offensive/csgo.exe', 'csgo']
}

function Steam (search) {
  this.search = search
  this.path = null
}

Steam.prototype.init = async function () {
  let proc = await util.findProcess(x => x.path.toLowerCase().endsWith(this.search))
  if (proc) {
    this.path = ph.join(proc.path, '..')
    return true
  }
  return false
}

Steam.prototype.get = function (id) {
  let app = APPS[id]
  if (!app) throw new Error('Game not supported.')
  let paths = [this.path]

  let lib = ph.join(this.path, 'steamapps', 'libraryfolders.vdf')
  if (fs.existsSync(lib)) {
    let vdf = fs.readFileSync(lib, 'utf-8')
    let lines = vdf.split(/\r?\n/)
    let legacy = vdf.substr(1, 14) === 'LibraryFolders'
    for (let line of lines) {
      let match = line.match(new RegExp(`"${legacy ? '\\d+' : 'path'}".*"(.*)"`))
      if (match) {
        let dir = match[1]
        if (fs.existsSync(dir) && fs.existsSync(ph.join(dir, 'libraryfolder.vdf'))) {
          paths.push(dir)
        }
      }
    }
  }

  for (let path of paths) {
    let dir = ph.join(path, 'steamapps', 'common', app[0])
    if (fs.existsSync(dir)) return { exe: dir, dir: ph.join(dir, '..', app[1]), ini: app[2] }
  }
  throw new Error('Game not found.')
}

module.exports = new Steam('\\steam\\steam.exe')
