# demrec

NodeJS wrapper for [SourceVideoRender](https://github.com/crashfort/SourceDemoRender)!

## Installation

- Download latest release of [this fork](https://github.com/bakapear/SourceDemoRender)
- Set `svr_dir` in your `config.ini` to that SVR directory

## Usage

```js
let DemRec = require("demrec");
let dr = new DemRec("config.ini");

// prepare event log
let Events = Object.keys(DemRec.Events);
dr.on("log", (data) => {
  console.log(`EVENT: ${Events[data.event]}`);
});

// launch the game
await dr.launch();

// render a demo
await dr.record(
  "cooldemo.dem",
  {
    ticks: [300, 1800],
    spec: "soupcan", // player/steamid to spectate (SourceTV demo only)
    cmd: "mat_fullbright 1; volume 0.2", // commands to execute before recording
    out: "soupcan_does_cool_stuff", // output file
  },
  "output"
); // output folder
// result: -> output/soupcan_does_cool_stuff.mp4

// multiple recordings in a single demo supported
await dr.record(
  "Z:/demos/auto-20200724-224342-jump_haze.dem",
  [
    {
      ticks: [12710, 14067],
      spec: "STEAM_0:0:443798979",
      out: "toss_bonus1",
    },
    {
      ticks: [14359, 15936],
      spec: "STEAM_0:0:443798979",
      out: "toss_bonus2",
    },
    {
      ticks: [19334, 20723],
      spec: "STEAM_0:1:50458194",
      cmd: "spec_mode 5",
      out: "tom_wallclimbing",
    },
    {
      ticks: [21051, 22219],
      spec: "STEAM_0:1:50458194",
    },
  ],
  "output"
);
// results:
// output/toss_bonus1.mp4, output/toss_bonus2.mp4,
// output/tom_wallclimbing.mp4, output/out-4.mp4

// close the game
await dr.exit();
```

## FFMPEG configuration

The default configuration in `config.ini` simply merges the resulting mp4 & wav files into a single mp4.<br>
If you remove the FFMPEG section entirely, output of dr.record will contain both files instead.

You can add additional FFMPEG jobs like this:

```ini
[FFMPEG]
-i "%INPUT%.mp4"
-c:v copy
-c:a aac
"%NEXT%.mp4"

[FFMPEG]
-i "%PREV%.mp4" # %INPUT% is no longer available at this point
-vf "vignette=angle=0.5"
"%OUT%.mp4"
```
