let fs = require('fs')

let T = (index, tick, cmd) => `"${index}" { name "${index}" factory "PlayCommands" starttick "${tick}" commands "${cmd}" }`

function VDM (demo) {
  this.path = demo.slice(0, -4) + '.vdm'
  this.index = 0
  this.blocks = []
}

VDM.prototype.add = function (tick, cmd, token) {
  cmd = cmd.filter(x => x).join('; ')
  if (Array.isArray(tick)) {
    let index, lastFrame
    let range = { start: tick[0], end: tick[1] }
    let step = (range.end - range.start) / 100
    for (index = 1; index <= 100; index++) {
      let frame = Math.floor(index * step) - 1
      if (frame > 0 && lastFrame !== frame) {
        lastFrame = frame
        this.blocks.push(T(++this.index, range.start + frame, cmd.replace(token, index)))
      }
    }
  } else {
    this.blocks.push(T(++this.index, tick, cmd))
  }
}

VDM.prototype.write = function () {
  fs.writeFileSync(this.path, `demoactions {\n  ${this.blocks.join('\n  ')}\n}`)
}

module.exports = VDM
