#requires -Version 5
<#
.SYNOPSIS
  dsh-volume-bar self-check: verifies every link of the chain from this machine.

.DESCRIPTION
  Checks, in order:
    1. the plugin is installed in the desktop profile and listed in its bundles
    2. the host half answers on the DSH webserver
    3. the audio helper starts and streams frames for the default output device
    4. (optional) a short test tone is played so real signal is visible
    5. the browser half has checked in (only when the running host is new enough)

  Read-only apart from starting/stopping the meter, which is the plugin's own
  documented behaviour.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File verify.ps1
  powershell -ExecutionPolicy Bypass -File verify.ps1 -Tone
#>
param(
  [switch]$Tone,
  [string]$Profile = 'desktop',
  [string]$Base = 'http://127.0.0.1:19387'
)

$ErrorActionPreference = 'Stop'
$home_dsh = Join-Path $env:USERPROFILE '.dsh'
$profile_dir = Join-Path $home_dsh "profiles\$Profile"
$pkg = Join-Path $profile_dir 'node_modules\dsh-volume-bar\package.json'
$venv_py = Join-Path $home_dsh 'tools\dsh-volume-bar\venv\Scripts\python.exe'
$helper = Join-Path $profile_dir 'node_modules\dsh-volume-bar\lib\audio-levels.py'

$problems = @()
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Good($text) { Write-Host "   ok   $text" -ForegroundColor Green }
function Bad($text) { Write-Host "   FAIL $text" -ForegroundColor Red; $script:problems += $text }
function Info($text) { Write-Host "        $text" -ForegroundColor DarkGray }

function Get-Json($path, $method = 'GET') {
  try {
    $response = Invoke-WebRequest -Uri "$Base$path" -Method $method -UseBasicParsing -TimeoutSec 10
    return $response.Content | ConvertFrom-Json
  } catch {
    return $null
  }
}

Step "1. profile 安装状态"
if (-not (Test-Path $pkg)) {
  Bad "profile 里没有 dsh-volume-bar（$pkg）"
} else {
  $manifest = Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json
  Good "已安装 dsh-volume-bar $($manifest.version)"
  $profile_json = Get-Content (Join-Path $profile_dir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($profile_json.dsh.profile.bundles -contains 'dsh-volume-bar') {
    Good "已在 dsh.profile.bundles 中"
  } else {
    Bad "不在 dsh.profile.bundles 中——插件不会被加载"
  }
}

Step "2. 宿主半（HTTP 路由）"
$state = Get-Json '/volume-bar/state'
if (-not $state) {
  Bad "GET $Base/volume-bar/state 无响应——宿主半没挂上（试试重启 DSH）"
} else {
  Good "宿主半在线；依赖就绪 = $($state.ready)"
  if ($state.clientSeenAt) {
    Good "浏览器半已上线：$([math]::Round($state.clientAgeMs / 1000, 1)) 秒前，找到 $($state.clientInfo.marks) 个刻度"
  } elseif ($state.PSObject.Properties.Name -contains 'clientSeenAt') {
    Bad "浏览器半还没上报——页面可能没加载插件（刷新一次页面）"
  } else {
    Info "当前运行的宿主半版本较旧，没有浏览器半上报字段（重启 DSH 后可看到）"
  }
}

Step "3. 音频助手"
if (-not (Test-Path $venv_py)) {
  Bad "音频助手的 venv 不存在：$venv_py"
  Info "点一次 ♪ 会自动创建，或手动：python -m venv --system-site-packages 后 pip install pyaudiowpatch"
} else {
  Good "venv 存在：$venv_py"
}

if ($state) {
  $null = Get-Json '/volume-bar/start' 'POST'
  Start-Sleep -Milliseconds 1500

  $tone_process = $null
  if ($Tone) {
    $wav = Join-Path $env:TEMP 'dsh-volume-bar-tone.wav'
    & $venv_py -c @"
import math, struct, wave
rate, secs = 44100, 3.0
with wave.open(r'$wav', 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
    buf = bytearray()
    for i in range(int(rate * secs)):
        env = 0.5 + 0.5 * math.sin(2 * math.pi * 2.0 * i / rate)
        buf += struct.pack('<h', int(0.4 * env * 32767 * math.sin(2 * math.pi * 440 * i / rate)))
    w.writeframes(bytes(buf))
"@
    $tone_process = Start-Process -FilePath $venv_py -PassThru -WindowStyle Hidden `
      -ArgumentList @('-c', "import winsound,time; winsound.PlaySound(r'$wav', winsound.SND_FILENAME|winsound.SND_ASYNC); time.sleep(3.5)")
    Info "已播放 3 秒测试音（440Hz 脉冲）"
  }

  $max = 0.0
  $max_bands = $null
  $device = $null
  $frames = 0
  for ($i = 0; $i -lt 60; $i++) {
    $levels = Get-Json '/volume-bar/levels'
    if ($levels) {
      if ($levels.device) { $device = $levels.device }
      if ($levels.level) {
        $frames++
        if ($levels.level.rms -gt $max) { $max = $levels.level.rms; $max_bands = $levels.level.bands }
      }
    }
    Start-Sleep -Milliseconds 80
  }
  $null = Get-Json '/volume-bar/stop' 'POST'
  if ($tone_process -and -not $tone_process.HasExited) { $tone_process.Kill() }

  if ($device) { Good "抓到设备：$device" } else { Bad "没拿到设备信息——助手可能启动失败" }
  if ($frames -gt 0) { Good "收到 $frames 帧电平数据" } else { Bad "没有收到任何电平帧" }
  if ($Tone) {
    if ($max -gt 0.002) {
      Good "捕获到真实信号：最大 rms = $([math]::Round($max, 5))"
      Info "频段 = $($max_bands -join ', ')"
    } else {
      Bad "放了测试音但没抓到信号（最大 rms = $max）"
    }
  } else {
    Info "未播放测试音；当前最大 rms = $([math]::Round($max, 5))（放音乐时应该更大）"
    Info "想验证音频链路，加 -Tone 再跑一次"
  }
}

Write-Host ''
if ($problems.Count -eq 0) {
  Write-Host '结论：这条链路是通的。' -ForegroundColor Green
  Write-Host '界面上还差一步：DSH 里刷新页面（Ctrl+R），到 设置 → 音量条 打开开关，然后放首歌。' -ForegroundColor Green
  exit 0
}
Write-Host "结论：发现 $($problems.Count) 个问题：" -ForegroundColor Red
$problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
exit 1
