#requires -Version 5
<#
.SYNOPSIS
  dsh-volume-bar self-check: verifies every link of the chain from this machine.

.DESCRIPTION
  Checks, in order:
    1. the plugin is installed in the desktop profile and listed in its bundles
    2. the host half answers on the DSH webserver (protocol v2 fields)
    3. the audio helper is installed and its dependency probe passes
    4. the audio helper streams *new* frames for the capture device
    5. (optional) a short test tone is played so real signal is visible
    6. the browser half has checked in (marks found, rail adapted)

  Frames are counted by `seq`, not by "a level object arrived", so a cached frame
  cannot inflate the result (review F19). The script holds its own lease and only
  stops the meter when it is the last consumer, so it never interrupts a page
  that is using the meter. State is restored and temporary files are removed in
  `finally` blocks.

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

# Windows PowerShell 5.1 reads .ps1 files as ANSI unless they carry a UTF-8 BOM,
# which mangles the Chinese output. The pack step writes the BOM; if a tool drops
# it, re-launch once in a child process that is told the file is UTF-8.
if (-not $env:DSH_VB_UTF8) {
  $env:DSH_VB_UTF8 = '1'
  $script_path = $PSCommandPath
  if (-not $script_path) { $script_path = $MyInvocation.MyCommand.Path }
  & powershell -NoProfile -ExecutionPolicy Bypass -Command `
    "& { [Console]::OutputEncoding = [Text.Encoding]::UTF8; & '$script_path' @args }" @args
  exit $LASTEXITCODE
}

$home_dsh = Join-Path $env:USERPROFILE '.dsh'
$profile_dir = Join-Path $home_dsh "profiles\$Profile"
$pkg = Join-Path $profile_dir 'node_modules\dsh-volume-bar\package.json'
$venv_py = Join-Path $home_dsh 'tools\dsh-volume-bar\venv\Scripts\python.exe'
$helper = Join-Path $profile_dir 'node_modules\dsh-volume-bar\lib\audio-levels.py'
$client_id = 'verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$wav = Join-Path $env:TEMP "dsh-volume-bar-tone-$client_id.wav"

$problems = @()
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Good($text) { Write-Host "   ok   $text" -ForegroundColor Green }
function Bad($text) { Write-Host "   FAIL $text" -ForegroundColor Red; $script:problems += $text }
function Info($text) { Write-Host "        $text" -ForegroundColor DarkGray }

function Get-Json($path, $method = 'GET', $body = $null) {
  try {
    $params = @{ Uri = "$Base$path"; Method = $method; UseBasicParsing = $true; TimeoutSec = 10 }
    if ($body) {
      $params.Body = ($body | ConvertTo-Json -Compress)
      $params.ContentType = 'application/json'
    }
    return (Invoke-WebRequest @params).Content | ConvertFrom-Json
  } catch {
    return $null
  }
}

$before = $null
$tone_process = $null
try {
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
  $protocol2 = $false
  if (-not $state) {
    Bad "GET $Base/volume-bar/state 无响应——宿主半没挂上（试试重启 DSH）"
  } else {
    $before = $state
    Good "宿主半在线；协议版本 = $($state.protocolVersion)，采集状态 = $($state.captureState)"
    if ($state.PSObject.Properties.Name -contains 'protocolVersion' -and $state.protocolVersion -ge 2) {
      $protocol2 = $true
      Good "依赖探测：python $($state.probe.python)，numpy $($state.probe.numpy)，pyaudiowpatch $($state.probe.pyaudiowpatch)，loopback 设备 $($state.probe.devices)"
      if ($state.probe.ok -ne $true) { Bad "依赖探测未通过：$($state.probe.error)" }
      if (-not $state.probe.numpy) { Bad "NumPy 不可用——频段分析会降级为「只显示总电平」" }
      Info "当前租约数 = $($state.leases)（其他页面可能正在使用）"
    } else {
      Info "当前运行的宿主半版本较旧（没有协议版本字段），建议重启 DSH 后再跑一次"
    }
    if ($state.clientSeenAt) {
      Good "浏览器半已上线：$([math]::Round($state.clientAgeMs / 1000, 1)) 秒前，找到 $($state.clientInfo.marks) 个刻度（rail=$($state.clientInfo.rail)）"
    } elseif ($state.PSObject.Properties.Name -contains 'clientSeenAt') {
      Bad "浏览器半还没上报——页面可能没加载插件（刷新一次页面）"
    }
  }

  Step "3. 音频助手"
  if (-not (Test-Path $venv_py)) {
    Bad "音频助手的 venv 不存在：$venv_py"
    Info "点一次 ♪ 会自动创建，或手动：python -m venv --site-packages 后 pip install pyaudiowpatch numpy"
  } else {
    Good "venv 存在：$venv_py"
  }

  if ($state) {
    $start = Get-Json '/volume-bar/start' 'POST' @{ clientId = $client_id; protocolVersion = 2; ttlMs = 120000 }
    if ($start -and $start.ok -eq $false) { Bad "启动失败：$($start.error)" }
    Start-Sleep -Milliseconds 1500

    if ($Tone -and (Test-Path $venv_py)) {
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

    Step "4. 采集帧（按 seq 去重）"
    $unique = @{}
    $samples = 0
    $max = 0.0
    $max_bands = $null
    $device = $null
    $analysis = $null
    $minAge = $null
    $maxAge = $null
    $captureStates = @{}
    for ($i = 0; $i -lt 60; $i++) {
      $levels = Get-Json "/volume-bar/levels?clientId=$client_id"
      if ($levels) {
        if ($levels.device) {
          # Protocol v2 sends an object; the older host sent a bare name string.
          if ($levels.device -is [string]) { $device = $levels.device } else { $device = $levels.device.name }
        }
        if ($levels.analysisMode) { $analysis = $levels.analysisMode }
        if ($levels.captureState) { $captureStates[$levels.captureState] = $true }
        if ($null -ne $levels.ageMs) {
          if ($null -eq $minAge -or $levels.ageMs -lt $minAge) { $minAge = $levels.ageMs }
          if ($null -eq $maxAge -or $levels.ageMs -gt $maxAge) { $maxAge = $levels.ageMs }
        }
        if ($levels.level) {
          if ($null -ne $levels.seq) { $unique["$($levels.frameGeneration):$($levels.seq)"] = $true }
          else { $samples += 1 }   # older host: no seq, count samples separately
          if ($levels.level.rms -gt $max) { $max = $levels.level.rms; $max_bands = $levels.level.bands }
        }
      }
      Start-Sleep -Milliseconds 80
    }

    $frames = $unique.Count
    if ($device) {
      $mode = if ($start -and $start.state -and $start.state.device) { $start.state.device.mode } else { 'n/a' }
      Good "采集目标：$device（模式 $mode）"
    } else { Bad "没拿到设备信息——助手可能启动失败" }
    if ($analysis) {
      Good "分析模式：$analysis"
    } elseif ($protocol2) {
      Bad "没有拿到分析模式——助手没有上报 hello"
    } else {
      Info "旧版宿主半没有分析模式字段（升级并重启 DSH 后可见）"
    }
    if ($frames -gt 0) {
      Good "收到 $frames 个唯一帧（按 generation:seq 去重）"
    } elseif ($samples -gt 0) {
      if ($protocol2) { Bad "宿主上报了 seq，但样本没有去重成功" }
      else { Info "旧版宿主半没有 seq：收到 $samples 次电平样本（升级后可按唯一帧统计）" }
    } else { Bad "没有收到任何新帧" }
    if ($null -ne $minAge) {
      if ($minAge -lt 1500) { Good "帧龄最小 $minAge ms（采集是新鲜的）" } else { Bad "帧龄最小 $minAge ms——宿主在线但没有新音频" }
    }
    $states = @($captureStates.Keys)
    if ($states.Count -gt 0) { Good "出现过的采集状态：$($states -join ', ')" }
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

    Step "5. 释放自己的租约"
    $stop = Get-Json '/volume-bar/stop' 'POST' @{ clientId = $client_id }
    if ($stop) {
      if ($stop.stopped) { Good "没有其他消费者，采集已停止" }
      else { Good "其他页面仍在使用（剩余租约 $($stop.leases)），没有打断它们" }
    }
  }
} catch {
  Bad "自检中断：$($_.Exception.Message)"
} finally {
  if ($tone_process -and -not $tone_process.HasExited) { $tone_process.Kill() }
  if (Test-Path $wav) { Remove-Item $wav -Force -ErrorAction SilentlyContinue }
  # Never leave a lease behind, even if a check threw.
  $null = Get-Json '/volume-bar/stop' 'POST' @{ clientId = $client_id }
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
