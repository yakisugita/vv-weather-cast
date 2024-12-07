# vv-weather-cast
天気予報を取得してVOICEVOXで音声合成し、Castデバイスで再生するスクリプト

nodeの引数として`--env-file=.env`を使用するため、node v20.6.0 以降が必要です

# 使い方
`.env.example`を`.env`にコピーし、必要な編集を行ってください。
```
$ node --env-file=.env weather-cast.js
```

## pm2を使用する場合
`weather-cast.config.js.example`を`weather-cast.config.js`にコピーしてください。
configは毎日午前7:00に起動するようにしてあります。
```
$ pm2 start weather-cast.config.js
```