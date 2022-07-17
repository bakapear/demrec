let child = require('child_process')

module.exports = async function ffmpeg (cmd, progress, retries = 5) {
  let app = child.spawn('ffmpeg.exe', [...splitArgs(cmd), '-hide_banner', '-y'])

  let total = 0
  let msg = null

  app.stderr.on('data', e => {
    msg = e.toString()
    if (!total) {
      total = time(msg.match(/Duration: (.*?),/)?.[1])
      if (total && progress) progress(0)
    } else {
      let t = time(msg.match(/time=(.*?) /)?.[1])
      if (t && progress) {
        let p = Number((t * 100 / total).toFixed(2))
        if (p < 100) progress(p)
      }
    }
  })

  await new Promise((resolve, reject) => {
    app.on('close', e => {
      if (e) {
        let error = msg.split('\r\n').slice(-2, -1)[0]
        if (error.match(/Invalid data found when processing input|Permission denied/) && retries > 0) {
          setTimeout(() => ffmpeg(cmd, progress, --retries).then(resolve).catch(reject), 1234)
        } else throw Error(error)
      } else {
        progress(100)
        resolve()
      }
    })
  })
}

function splitArgs (str) {
  let matches = str.matchAll(/[^\s"]+|"([^"]*)"/gi)
  let arr = []
  while (true) {
    let match = matches.next()
    if (match.done) break
    if (match.value) arr.push(match.value[1] ? match.value[1] : match.value[0])
  }
  return arr
}

function time (str) {
  if (!str) return null
  let a = str.split(':').map(Number)
  return 3600000 * a[0] + 60000 * a[1] + 1000 * a[2]
}
