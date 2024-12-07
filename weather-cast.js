const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
const http = require('http')

const progress = []
const progress_label = ["query", "synthesis", "play_queue", "playing", "done"]
const wav_list = []
const log = true

// 予報区の指定
const jma_pref = process.env.JMA_PREF // 府県予報区
const jma_area = process.env.JMA_AREA // 一次細分区域
const jma_point = process.env.JMA_POINT // 地域気象観測所
const jma_signature = process.env.JMA_SIGNATURE // 英字官署名

// Yahoo用 雨雲レーダーの情報を取得したい地点の緯度経度
const y_app_id = process.env.Y_APP_ID
// 例:JR山形駅 経度:140.327220 緯度:38.248664
const y_keido = process.env.Y_KEIDO
const y_ido = process.env.Y_IDO

// VOICEVOX用
const vv_ip = process.env.VV_IP
const vv_port = process.env.VV_PORT
const vv_speaker = process.env.VV_SPEAKER
// 四国めたん ノーマル2,春日部つむぎ8,冥鳴ひまり14,No.7 ノーマル29 アナウンス30,小夜46,TT ノーマル47 楽々48
const speed = parseFloat(process.env.VV_SPEED) // 話速
const pause_length = parseFloat(process.env.VV_PAUSE_LENGTH) // 句読点などの時間調整

// Webサーバー用
const my_ip = process.env.MY_IP
const my_port = process.env.MY_PORT
const cast_ip = process.env.CAST_IP

// 気象庁APIから天気予報取得(Fetch APIを使用)
// Yahoo 地図APIから雨雲レーダー情報取得
// 読み上げ文章組み立て
// HTTPサーバー立てる
// VOICEVOXからquery取得,wav取得,メモリに保持
// 進捗を定期的にチェック
// GoogleHomeにつないでCast再生開始
// HTTPサーバーにアクセス来たらwav返す
// wav生成終了→再生→再生終了→次のwav生成終了→再生→...
// 全て再生終了したらおわり

// 現在の時刻を取得しておく
const time_now = new Date(Date.now() + ((new Date().getTimezoneOffset() + (9 * 60)) * 60 * 1000))

async function main() {
    try {
        // 気象庁APIから天気予報(天気,降水確率,最低・最高気温)を取得
        // 戻り値 降水確率(文章), 気温判定用(0:情報無し 1:最低気温 2:最高気温 3:最低・最高), 最低気温, 最高気温
        const [kakuritu_text, temp_option, temp_min, temp_max] = await get_jma()

        let temp_text = ""
        switch (temp_option) {
            case 1:
            temp_text = `朝の最低気温は${temp_min}度です。`
            break

            case 2:
            temp_text = `日中の最高気温は${temp_max}度です。`
            break

            case 3:
            temp_text = `朝の最低気温は${temp_min}度、日中の最高気温は${temp_max}度です。`
            break
        }
        console.log(kakuritu_text)
        console.log(temp_text)

        // 気象庁APIからテロップ(短い天気文)を取得
        // 戻り値 テロップ
        const telop = await get_telop()
        console.log(telop)

        // Yahoo(YOLP) 気象情報APIから雨雲レーダー情報取得
        // 戻り値 現在雨が降っているか,降り出しまで何分か(すでに降っていれば0,雨降らないなら-1),最高降雨強度
        const [is_rain, rain_delay, max_rain] = await get_yahoo()
        console.log(is_rain, rain_delay, max_rain)

        // HTTPサーバー用意
        http_server()

        // 文章組み立て
        // const text = "ボイスボックス。テスト音声です。"
        let text = `天気予報をお知らせします。今日の天気は ${telop.replace("雨","あめ")}、降水確率は、${kakuritu_text}です。`
        if (is_rain) {
            text += "現在雨が降っています。"
        } else {
            if (rain_delay == -1) {
                text += "今後1時間、雨はふりません。"
            } else {
                text += `およそ${rain_delay}分後に雨がふります。`
            }
        }
        if (0.00 < max_rain && max_rain < 0.50) {
            text += "弱い雨です。"
        } 
        if (3.00 < max_rain) {
            text += "強い雨です。"
        }
        const synthesis_list = []
        // 文章を区切る VOICEVOXに合成リクエスト投げる準備
        text.split(/[。、., ]/).forEach(elem => {
            if (elem !== "") {
              progress.push(0)
              synthesis_list.push(req_vv(elem, synthesis_list.length))
            }
        })

        // VOICEVOXに同時にリクエスト投げる
        Promise.all(synthesis_list).catch((error) => {
            console.log("error handling")
            console.error(error)
        })

        // Castデバイスにつなぐ
        const client = new Client()
        await cast_connect(client, cast_ip)
        const player = await cast_launch(client)

        // 進捗表示
        let prev_progress_text = ""
        const progress_interval = setInterval(() => {
            if (log) {
                // \e のかわりに \u001b を使う
                const green   = '\u001b[32m'
                const magenta = '\u001b[35m'
                const magenta_bg = '\u001b[45m'
                const cyan    = '\u001b[36m'
                const gray    = '\u001b[38;5;8m'
                const reset   = '\u001b[0m'

                let progress_text = ""
                progress.forEach(progress_ => {
                    for (let i = 0; i < progress_label.length; i++) {
                        // 音声ファイルごとに ... -> query -> synthesis -> ... のような進捗表示
                        // 到達部分は緑
                        if (progress_ > i) progress_text+=green
                        // 処理中部分は背景マゼンタ
                        if (progress_ == i) progress_text+=magenta_bg
                        // (未到達部分は白)
                        progress_text+=`${progress_label[i]}${reset} > `
                    }
                    progress_text+="\n"
                })
                // 変化があったら表示
                if (progress_text != prev_progress_text) {
                console.log(progress_text)
                prev_progress_text = progress_text
                }
            }
        }, 100)

        // 順番に再生
        let i = 0
        while (true) {
            await delay(100)
            // 生成完了まで待って再生
            if (progress[i] == 2) {
                const wait_interval = await cast_play(player, i, `http://${my_ip}:${my_port}/?id=${i}`, "タイトル")
                clearInterval(wait_interval)
                i++

                // 最後のが再生終了したらループ抜ける
                if (i >= progress.length) break
            }
        }
        // 全て終わり
        clearInterval(progress_interval)
        client.close()
        process.exit(1)
    } catch (error) {
        console.error(error.message)
    }
}


async function get_jma() {
    const jma_url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${jma_pref}.json`
    const response = await fetch(jma_url)
    if (!response.ok) throw new Error(`レスポンスステータス: ${response.status}`)
    const jma_json = await response.json()

    // jma_json[0]3日間の天気 [1]週間天気,平年値
    const jma_3d = jma_json[0]
    // timeSeries[0]天気,風,波 [1]降水確率 [2]気温
    
    // 天気,風,波を取得
    // 取得したい一次細分区域(例:愛知県西部)が何番目にあるか調べる
    let area_index = -1
    jma_3d.timeSeries[0].areas.forEach((elem, i) => {
        if (elem.area.code == jma_area) area_index = i
    })
    // 見つからなかったらエラー出す
    if (area_index == -1) throw new Error(`指定された一次細分区域が見つかりません`)
    
    // 0番目が今日のやつ たぶん
    const weather = jma_3d.timeSeries[0].areas[area_index].weathers[0]
    const wind = jma_3d.timeSeries[0].areas[area_index].winds[0]

    // bool ? true : false
    const wave = jma_3d.timeSeries[0].areas[area_index].waves ? jma_3d.timeSeries[0].areas[area_index].waves[0] : null
    // const kakuritu = jma_json[0].timeSeries
    // console.log("weather:",weather,"\nwind:",wind,"\nwave:",wave)
    // 天気,風,波おわり

    // 今日分の降水確率を取得 一次細分区域のインデックスは使いまわす

    // [[時,確率],[時,確率]]の形式にする
    // 時は0,6,12,18の4通り 13:00に取得すると12,18が入ってる
    const pops = []
    jma_3d.timeSeries[1].areas[area_index].pops.forEach((pop, i) => {
        const time = new Date(jma_3d.timeSeries[1].timeDefines[i])
        if(time_now.getDate() == time.getDate()) {
            pops.push([time.getHours(), parseInt(pop)])
        }
    })

    // データ数に合わせてテキストを組み立てる
    let kakuritu_text = ""
    switch (pops[0][0]) {
        case 0: // 0,6,12,18
            kakuritu_text = `午前${(pops[0][1] + pops[1][1]) / 2}パーセント、午後${(pops[2][1] + pops[3][1]) / 2}パーセント`
            break
            
        case 6: // 6,12,18
            kakuritu_text = `午前${pops[0][1]}パーセント、午後${(pops[1][1] + pops[2][1]) / 2}パーセント`
            break

        case 12: // 12,18
            kakuritu_text = `${(pops[0][1] + pops[1][1]) / 2}パーセント`
            break
        
        case 18: // 18
            kakuritu_text = `${pops[0][1]}パーセント`
            break
    }
    // console.log(kakuritu_text)
    // 降水確率おわり

    // 今日分の朝の最低気温・日中の最高気温取得
    let point_index = -1
    jma_3d.timeSeries[2].areas.forEach((elem, i) => {
        if (elem.area.code == jma_point) point_index = i
    })
    // 見つからなかったらエラー出す
    if (point_index == -1) throw new Error(`指定された地点が見つかりません(気温)`)
    
    // 9:00→最高気温,0:00→最低気温
    const temp_time = jma_3d.timeSeries[2].timeDefines
    // 時系列の順番バラバラ? [今日高,今日低,明日高,明日低]
    const temp_val = jma_3d.timeSeries[2].areas[point_index].temps
    
    let temp_min = null
    let temp_max = null
    temp_time.forEach((elem, i) => {
        // 今日分の最高/最低を取得
        const time = new Date(elem)
        if(time_now.getDate() == time.getDate()) {
            switch (time.getHours()) {
                case 0:
                    temp_min = temp_val[i]
                    break
            
                case 9:
                    temp_max = temp_val[i]
                    break
            }
        }
    })

    // 最低が"-"のとき、なぜか最低のところに最高と同じ気温が入る
    let temp_option = 0 // 0:情報無し 1:最低気温 2:最高気温 3:最低・最高
    if (temp_min !== null && temp_min != temp_max) {temp_option+=1}
    if (temp_max !== null) {temp_option+=2}

    let temp_text = ""
    switch (temp_option) {
        case 1:
        temp_text = `朝の最低気温は${temp_min}度です。`
        break

        case 2:
        temp_text = `日中の最高気温は${temp_max}度です。`
        break

        case 3:
        temp_text = `朝の最低気温は${temp_min}度、日中の最高気温は${temp_max}度です。`
        break
    }
    // 最低・最高気温おわり

    return [kakuritu_text, temp_option, temp_min, temp_max]
}


async function get_telop() {
    const telop_url = `https://www.data.jma.go.jp/multi/data/VPFD51/${jma_signature}_jp.json`
    const response = await fetch(telop_url)
    if (!response.ok) throw new Error(`レスポンスステータス: ${response.status}`)
    const telop_json = await response.json()

    // kind:テロップなど area エリア
    let area_index = -1
    telop_json.meteorologicalInfos.timeSeriesInfoWeather.forEach((elem, i) => {
        if (elem.area.code == jma_area) area_index = i
    })
    // 見つからなかったらエラー出す
    if (area_index == -1) throw new Error(`指定された一次細分区域が見つかりません`)
    
    return telop_json.meteorologicalInfos.timeSeriesInfoWeather[area_index].kind.weatherPart[0].weather
}


async function get_yahoo() {
    const params = new URLSearchParams({
        appid: y_app_id,
        coordinates: `${y_keido},${y_ido}`,
        output: "json",
        // 5分ごとのデータを取得
        interval: 5,
    })

    const yahoo_url = `https://map.yahooapis.jp/weather/V1/place?${params}`
    const response = await fetch(yahoo_url)
    if (!response.ok) throw new Error(`レスポンスステータス: ${response.status}`)
    const yahoo_json = await response.json()

    const dates = []
    const rains = []
    let rain_start_time = null

    // yahoo_json.Feature[0].Property.WeatherList.Weather[index]
    // 種別(実測/予測), 日付時刻(YYYYMMDDHHmm), 降雨強度[mm/h] 5分ごと 時系列順 60分後まで

    // 雨の強さ用の配列作成
    // 1番目は実測値(5~9分前のデータ) 2番目以降が予測値
    yahoo_json.Feature[0].Property.WeatherList.Weather.forEach(weather => {
        dates.push(weather.Date)
        rains.push(weather.Rainfall)
        // 雨が降り出す時刻取得
        if (weather.Rainfall > 0.00 && rain_start_time === null) rain_start_time = weather.Date
    })

    // 雨の強さ(60分間の最大値)
    const rain_max = rains.reduce((a, b) => Math.max(a, b), -Infinity)

    console.log(rain_max)

    // 雨降るかどうか
    if (rain_start_time !== null) {
        // 雨降る(降っている)なら何分後に降るか計算
        const rain_start_date = new Date(
            rain_start_time.substring(0, 4),
            rain_start_time.substring(4, 6)-1, // 月だけ0~11なので-1
            rain_start_time.substring(6, 8),
            rain_start_time.substring(8, 10),
            rain_start_time.substring(10, 12)
        )

        if (rain_start_date - time_now < 0) {
            // 降り出しまでが負の値ならすでに降っている
            return [true, 0, rain_max]
        } else {
            // いつ降り出すか ミリ秒→分に変換
            const rain_delay_min = (rain_start_date - time_now)/(1000*60)
            // 5分単位に丸める
            return [false, Math.floor(rain_delay_min/5)*5, rain_max]
        }
    } else {
        // 1時間通して0.00mm/h以下なら
        return [false, -1, rain_max]
    }
}


async function req_vv(text, id) {
    // クエリ作成
    const vv_headers = new Headers()
    vv_headers.append("Content-Type", "application/json")

    const params = new URLSearchParams({
        speaker: vv_speaker,
        text: text
    })

    const response1 = await fetch(`http://${vv_ip}:${vv_port}/audio_query?${params}`, {
        method: "POST",
        headers: vv_headers,
    })

    const query = await response1.json()
    // 帰ってきたクエリを少し修正 音量でかくする
    query.volumeScale = 2.0
    // 話速
    query.speedScale = speed
    // 句読点などの時間調整
    query.pauseLengthScale = pause_length
    // クエリ作成おわり 進捗更新
    progress[id] = 1

    // 音声合成
    const response2 = await fetch(`http://${vv_ip}:${vv_port}/synthesis?${params}`, {
        method: "POST",
        body: JSON.stringify(query),
        headers: vv_headers,
    })

    // arrayBufferを変数に保持
    wav_list[id] = await response2.arrayBuffer()
    // 合成おわり 進捗更新
    progress[id] = 2
}


function http_server() {
    // 用意
    const server = http.createServer((request, response) => {
        // GETパラメータidを取得
        // /file.html?param=value 最初の/を消してからパラメータ取得
        const params = new URLSearchParams(request.url.slice(1))

        // id存在チェック,数値かどうかチェック
        if (params.get("id") !== null && !isNaN(params.get("id"))) {
            // idに対応する音声ファイルがあるかチェック
            const id = parseInt(params.get("id"))
            if (wav_list[id] !== undefined) {
                response.writeHead(200, {
                    "Content-Type": "audio/wav"
                })
                // arrayBufferからBufferに変換して返す
                response.end(Buffer.from(wav_list[id]))
            } else {
                // なければ404
                response.writeHead(404)
                response.end()
            }
        } else {
            // idないor数値じゃないなら400
            response.writeHead(400)
            response.end()
        }
    })
    // 起動
    server.listen(my_port)
}


// Castデバイスにつなぐ
function cast_connect(client, host) {
    return new Promise((resolve, reject) => {
        client.connect(host, function () {
            resolve()
        })
        client.on('error', function (err) {
            console.log('Error: %s', err.message)
            console.log("close connection")
            client.close()
            reject()
        })
    })
}


// Castデバイスで再生準備(player取得)
function cast_launch(client) {
    return new Promise((resolve, reject) => {
        client.launch(DefaultMediaReceiver, function (err, player) {
            resolve(player)
        })
    })
}


// Castデバイスで再生,終了したらresolve
function cast_play(player, id, url, title) {
    return new Promise((resolve, reject) => {
        const media = {
            contentId: url,
            contentType: 'audio/wav',
            streamType: 'BUFFERED', // or LIVE
    
            metadata: {
                type: 0,
                metadataType: 0,
                title: title
            }
        }
    
        let cast_state = ""
    
        player.on('status', function (status) {
            cast_state = status.playerState
        })
    
        player.load(media, { autoplay: true }, function (err, status) {
            // 音声読み込んだ
        })
    
        // 再生終了まで待ってresolve
        const wait_interval = setInterval(() => {
            if (progress[id] == 2 && cast_state == "PLAYING") {
                progress[id] = 3
            }
            if (progress[id] == 3 && cast_state == "IDLE") {
                progress[id] = 4
                resolve(wait_interval)
            }
        }, 100);
    })
}



// 遅延用
function delay(ms) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve()
        }, ms);
    })
}

main()