let fs = require('fs')
let ph = require('path')
let child = require('child_process')

module.exports = {
  listProcesses () {
    let NAME = {
      Caption: ['name', String],
      ExecutablePath: ['path', String],
      CommandLine: ['cmd', String],
      ProcessId: ['id', Number]
    }
    let data = child.execSync('WMIC path win32_process get Caption,ExecutablePath,CommandLine,ProcessId').toString()
    let head = data.substr(0, data.indexOf('\n') + 1)
    let parts = head.split(/ (?=\w)/).map(x => {
      let name = NAME[x.trim()]
      return { key: name[0], type: name[1], length: x.length }
    })
    let pos = head.length
    let res = []
    while (pos < data.length) {
      let obj = {}
      for (let i = 0; i < parts.length; i++) {
        obj[parts[i].key] = parts[i].type(data.substr(pos, parts[i].length).trim())
        pos += parts[i].length
      }
      pos += parts.length - 1
      res.push(obj)
    }
    return res
  },
  findProcess (fn) {
    return this.listProcesses().find(fn)
  },
  readINI (file, array = []) {
    file = fs.readFileSync(ph.join(file), 'utf-8').replace(/(".*?"|'.*?')|((#|;)[^\r\n]*$)/gm, (a, b, c) => c ? '' : a)
    let lines = file.split(/\r?\n/)
    let res = {}
    let dex = 0
    let key = null
    for (let line of lines) {
      line = line.trim()
      if (!line) continue
      if (line[0] === '[' && line.slice(-1) === ']') {
        if (array.includes(key)) dex++
        key = line.slice(1, -1)
        if (!res[key]) {
          if (array.includes(key)) res[key] = []
          else res[key] = {}
        }
      } else if (array.includes(key)) {
        if (!res[key][dex]) res[key][dex] = []
        res[key][dex].push(line)
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
  splitArgs (args) {
    return args.replace(/\s(?=(?:[^'"`]*(['"`])[^'"`]*\1)*[^'"`]*$)/g, '\n').split('\n')
  },
  watch (file, fn) {
    fs.watchFile(file, { persistent: true, interval: 0 }, (curr, prev) => {
      if (curr.mtime <= prev.mtime) return
      let diff = curr.size - prev.size
      let buffer = Buffer.alloc(diff)
      let fd = fs.openSync(file, 'r')
      fs.readSync(fd, buffer, 0, diff, prev.size)
      fs.closeSync(fd)
      fn(buffer.toString())
    })
  },
  unwatch (file) {
    fs.unwatchFile(file)
  }
}
