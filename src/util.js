let fs = require('fs')
let ph = require('path')
let child = require('child_process')

module.exports = {
  async listProcesses () {
    let data = await this.run('Get-CimInstance Win32_Process | Select-Object -Property Caption,ExecutablePath,CommandLine,ProcessId,ParentProcessId | ConvertTo-Json', { shell: 'powershell.exe' })
    return JSON.parse(data).map(x => {
      return {
        name: x.Caption || '',
        path: x.ExecutablePath || '',
        cmd: x.CommandLine || '',
        id: Number(x.ProcessId) || null,
        parent: Number(x.ParentProcessId) || null
      }
    })
  },
  async findProcess (fn) {
    let procs = await this.listProcesses()
    return procs.find(fn)
  },
  readINI (file, array = []) {
    file = fs.readFileSync(ph.join(file), 'utf-8').replace(/(".*?"|'.*?')|((#|;)[^\r\n]*$)/gm, (a, b, c) => c ? '' : a)
    let lines = file.split(/\r?\n/)
    let res = {}
    let dex = {}
    let key = null
    for (let line of lines) {
      line = line.trim()
      if (!line) continue
      if (line[0] === '[' && line.slice(-1) === ']') {
        if (array.includes(key)) dex[key]++
        key = line.slice(1, -1)
        if (!res[key]) {
          if (array.includes(key)) res[key] = []
          else res[key] = {}
        }
      } else if (array.includes(key)) {
        if (!dex[key]) dex[key] = 0
        if (!res[key][dex[key]]) res[key][dex[key]] = []
        res[key][dex[key]].push(line)
      } else if (key) {
        let split = line.indexOf('=')
        let prop = line.substr(0, split).trim()
        let value = line.substr(split + 1).trim()
        if (value === 'true') value = true
        else if (value === 'false') value = false
        else if (!isNaN(value)) value = Number(value)
        else if (['""', "''"].includes(value[0] + value.slice(-1))) value = value.slice(1, -1)
        res[key][prop] = value
      }
    }
    return res
  },
  watch (file, fn, autoclose = false) {
    fs.watchFile(file, { persistent: true, interval: 0 }, (curr, prev) => {
      if (curr.mtime <= prev.mtime) return
      if (autoclose) this.unwatch(file)
      let diff = curr.size - prev.size
      if (diff < 0) return
      let buffer = Buffer.alloc(diff)
      let fd = fs.openSync(file, 'r')
      fs.readSync(fd, buffer, 0, diff, prev.size)
      fs.closeSync(fd)
      fn({ data: buffer.toString(), close: () => this.unwatch(file) })
    })
  },
  unwatch (file) {
    fs.unwatchFile(file)
  },
  modify (dir, mod, out) {
    if (fs.lstatSync(dir).isDirectory()) {
      this.copyFolder(dir, out)
      for (let i = 0; i < mod.files.length; i++) {
        this.readReplace(ph.resolve(out, mod.files[i]), mod.vars)
      }
    } else {
      fs.copyFileSync(dir, out)
      this.readReplace(out, mod.vars)
    }
  },
  copyFolder (source, target, first = true) {
    if (!fs.existsSync(target)) fs.mkdirSync(target)
    let files = []
    let targetFolder = first ? target : ph.join(target, ph.basename(source))
    if (!fs.existsSync(targetFolder)) fs.mkdirSync(targetFolder)
    if (fs.lstatSync(source).isDirectory()) {
      files = fs.readdirSync(source)
      files.forEach(file => {
        let curSource = ph.join(source, file)
        if (fs.lstatSync(curSource).isDirectory()) this.copyFolder(curSource, targetFolder, false)
        else fs.copyFileSync(curSource, ph.join(targetFolder, file))
      })
    }
  },
  readReplace (file, vars) {
    let data = fs.readFileSync(file, 'utf-8')
    let regex = new RegExp(`(${Object.keys(vars).join('|')})`, 'g')
    data = data.replace(regex, (m, e) => vars[e])
    fs.writeFileSync(file, data)
  },
  remove (paths) {
    if (!Array.isArray(paths)) paths = [paths]
    for (let path of paths) {
      if (path && fs.existsSync(path)) fs.rmSync(path, { force: true, recursive: true })
    }
  },
  async run (cmd, opts) {
    return new Promise((resolve, reject) => {
      child.exec(cmd, opts, (err, data) => {
        if (err) reject(err)
        else resolve(data)
      })
    })
  },
  getTickTime (ticks, add = 0) {
    return this.formatTime((ticks / (200 / 3) + add) * 1000)
  },
  formatTime (ms, decimals = 3) {
    if (!ms) return '0:00' + (decimals ? '.' + '0'.repeat(decimals) : '')

    let invert = false

    if (ms < 0) {
      invert = true
      ms = Math.abs(ms)
    }

    ms = ms / 1000
    let s = Math.floor(ms % 60)
    let m = Math.floor(ms / 60 % 60)
    let h = Math.floor(ms / 60 / 60)

    if (!h) h = null
    else if (!m) m = '00'
    if (!s) s = '00'

    let t = [h, m, s].filter(x => x !== null).map((x, i) => (i !== 0 && x < 10 && x !== '00') ? '0' + x : x)

    let decs = (ms % 1).toString().slice(2)
    decs = decs + '0'.repeat(16 - decs.length)

    return (invert ? '-' : '') + t.join(':') + (decimals ? '.' + decs.slice(0, decimals) : '')
  },
  addListeners (app, listeners, listener) {
    for (let l of listeners) app.addListener(l, listener)
  },
  removeListeners (app, listeners, listener) {
    for (let l of listeners) app.removeListener(l, listener)
  },
  async sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  },
  rndkey () {
    return Math.random().toString(36).slice(2) + '-' + Date.now().toString(36)
  }
}
