# demrec
NodeJS wrapper for [SourceDemoRender](https://github.com/crashfort/SourceDemoRender)!

## Usage
```js
let DemRec = require('demrec')
let dr = new DemRec('config.ini')

// launch the game
await dr.launch()

// prepare progress log
dr.on('log', data => {
   console.log('Progress: ' + data.progress + '%')
})

// render a demo
await dr.record({
  demo: 'cooldemo.dem',
  tick: { start: 300, end: 1800, padding: 20 },
  cmd: 'spec_mode 4; spec_player "coolguy"'
}, 'coolclip.mp4')

// close the game
await dr.exit()
```